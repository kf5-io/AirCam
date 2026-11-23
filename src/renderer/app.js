'use strict';
/* AirCam renderer: views + video pipeline (WebCodecs decode → canvas → virtual camera). */

// ───────── helpers (same as KF Player) ─────────
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const ICONS = { // static, trusted markup
  cam: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h2l1.6-2h5.8L16.5 6h2A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.8"/>',
  phone: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 18.5h3"/>',
  gear: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  usb: '<path d="M12 21V5M12 3l-2.5 3h5zM12 15l-4-3V9.5M12 13l4-2.5V8"/><circle cx="12" cy="20" r="1.4" class="fill"/><rect x="14.8" y="6.4" width="2.4" height="2.4"/><circle cx="8" cy="8.5" r="1.2"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.7 15.8a5 5 0 0 1 6.6 0"/><circle cx="12" cy="19" r="1.3" class="fill"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  adjust: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17"/><path class="fill" d="M12 3.5a8.5 8.5 0 0 1 0 17z"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.6M6.4 6.9A15.6 15.6 0 0 0 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
};
const icon = n => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); s.innerHTML = ICONS[n]; return s; };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('aircam.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('aircam.' + k, JSON.stringify(v)); } catch { toast('Stockage local indisponible'); } },
};
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };

// ───────── state ─────────
// `settings` is sent as-is to the phone (ios/AirCam/Protocol.swift Settings); PC is the source of truth.
const DEFAULTS = { camera: 'back', resolution: '1080p', fps: 30, torch: false, zoom: 1, exposure: 0, focus: 'auto', background: 'none',
  whiteBalance: 'auto', temperature: 5500, tint: 0, log: false };
let settings = { ...DEFAULTS, ...store.get('settings', {}), torch: false };
let ui = { mirror: false, rotate: false, output: '1080p', ...store.get('ui', {}) }; // PC-side image options
let bgImage = store.get('bgImage', null); // data URL (JPEG ≤ 1920 px) for background replacement
let devices = [];
let conn = { state: 'disconnected' };
let status = null; // last status from the phone
let vcamInstalled = null;
let view = 'cam';

const CAMS = { front: 'Avant', back: 'Arrière', ultrawide: 'Ultra grand-angle', tele: 'Téléobjectif' };
const sendSettings = debounce(() => aircam.control(settings), 60);
function set(k, v) { settings[k] = v; store.set('settings', settings); sendSettings(); }
function setUi(k, v) { ui[k] = v; store.set('ui', ui); if (k === 'output') openVcam(); if (!live()) placeholder(); }

// ───────── video pipeline ─────────
const OUT = { '720p': [1280, 720], '1080p': [1920, 1080] };
const canvas = h('canvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
let bgr = null;
let lastFrame = 0;
let vcamOk = false;
const live = () => performance.now() - lastFrame < 1000;

async function openVcam() {
  const [w, hh] = OUT[ui.output] || OUT['1080p'];
  canvas.width = w; canvas.height = hh;
  bgr = new Uint8Array(w * hh * 3);
  vcamOk = await aircam.vcam.open(w, hh);
  placeholder();
}

function pushVcam() {
  if (!vcamOk || !aircam.vcam.inUse()) return; // nobody is using the camera: skip the readback
  aircam.vcam.send(rgbaToBgr(ctx.getImageData(0, 0, canvas.width, canvas.height).data, bgr));
}

function draw(frame) {
  const W = canvas.width, H = canvas.height;
  let sx = ui.mirror ? -1 : 1, sy = 1;
  if (ui.rotate) { sx = -sx; sy = -1; } // 180° = flip both axes
  ctx.setTransform(sx, 0, 0, sy, sx < 0 ? W : 0, sy < 0 ? H : 0);
  const fw = frame.displayWidth, fh = frame.displayHeight, k = Math.max(W / fw, H / fh); // cover
  const src = grading() ? grader.render(frame, gradeParams()) : frame;
  ctx.drawImage(src, (W - fw * k) / 2, (H - fh * k) / 2, fw * k, fh * k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  frame.close();
  lastFrame = performance.now();
  drawLayers();
  pushVcam();
}

// ───────── color: adjustments + LUTs (GPU, src/renderer/grade.js) ─────────
const grader = (() => { try { return Grade; } catch { return null; } })(); // null without WebGL2
// Sliders are -100…100 (0 = neutral); each one only applies when its switch is on.
const ADJ = {
  brightness: ['Luminosité', 'linear-gradient(90deg,#111,#888,#fff)'],
  hue: ['Teinte', 'linear-gradient(90deg,#4b6bff,#b04bff,#ff4b6b,#ffb84b,#6bff4b,#4bd7ff)'],
  saturation: ['Saturation', 'linear-gradient(90deg,#888,#e85d4a)'],
  vibrance: ['Vibrance', 'linear-gradient(90deg,#777,#d9a066,#4ac0e8)'],
  contrast: ['Contraste', 'linear-gradient(90deg,#666,#999,#000 50%,#fff 50%,#111)'],
  gamma: ['Gamma', 'linear-gradient(90deg,#222,#d8cf7a,#222)'],
  sharpness: ['Netteté', 'linear-gradient(90deg,#555,#999,#ddd)'],
};
let adj = Object.fromEntries(Object.keys(ADJ).map(k => [k, { on: false, v: 0, ...store.get('adj', {})[k] }]));
let look = { lut: null, intensity: 100, ...store.get('look', {}) }; // lut: 'look:warm' | 'user:<file.cube>' | null
const saveColor = debounce(() => { store.set('adj', adj); store.set('look', look); }, 300);
const LUT_LOG = 'builtin:applelog';
const luts = new Map(); // id → { size, data }
for (const [k, [, fn]] of Object.entries(LOOKS)) luts.set('look:' + k, makeLut(33, fn));
luts.set(LUT_LOG, makeLut(33, appleLogToRec709));
let userLuts = []; // file names in <userData>/luts

// In Apple Log with no LUT picked, the built-in Log → Rec.709 conversion is mandatory (log footage looks flat/grey).
const activeLutId = () => look.lut && luts.has(look.lut) ? look.lut : settings.log && status?.settings?.log ? LUT_LOG : null;
let uploaded;
function grading() {
  if (!grader) return false;
  const id = activeLutId();
  if (id !== uploaded) { grader.setLut(luts.get(id) || null); uploaded = id; }
  return !!id || Object.values(adj).some(a => a.on && a.v);
}
function gradeParams() {
  const v = k => adj[k].on ? adj[k].v / 100 : 0;
  const s = v('sharpness');
  return {
    lutMix: activeLutId() === LUT_LOG && !look.lut ? 1 : look.intensity / 100,
    bri: v('brightness') * .25, hue: v('hue') * Math.PI, sat: 1 + v('saturation'), vib: v('vibrance') * .8,
    con: 1 + v('contrast') * .6, gam: 2 ** (-v('gamma') * .8), sharp: s > 0 ? s * 1.5 : s * .8,
  };
}
async function loadUserLuts() {
  userLuts = await aircam.luts.list();
  await Promise.all(userLuts.filter(f => !luts.has('user:' + f)).map(async f => {
    try { luts.set('user:' + f, parseCube(await aircam.luts.read(f))); } catch { luts.delete('user:' + f); }
  }));
}
async function importLuts() {
  const added = await aircam.luts.import();
  for (const f of added) {
    try { luts.set('user:' + f, parseCube(await aircam.luts.read(f))); look.lut = 'user:' + f; }
    catch (e) { await aircam.luts.remove(f); toast(`${f} : ${e.message}`); }
  }
  await loadUserLuts();
  saveColor(); redraw(); render();
}

// Thumbnails: a small synthetic test card (hues, skin, grey ramp) run through the LUT on the CPU.
const thumbCache = new Map();
function lutThumb(id) {
  const log = settings.log && id !== null;
  const key = id + (log ? ':log' : '');
  if (thumbCache.has(key)) return thumbCache.get(key);
  const W = 96, H = 54, c = h('canvas', { width: W, height: H }), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, 0);
  ['#e8403a', '#f2b33d', '#5fbf4a', '#3ab0d9', '#4a5ce8', '#c04ad9', '#e8403a'].forEach((col, i, a) => g.addColorStop(i / (a.length - 1), col));
  x.fillStyle = g; x.fillRect(0, 0, W, H * .62);
  const v = x.createLinearGradient(0, 0, 0, H * .62); v.addColorStop(0, 'rgba(255,255,255,.35)'); v.addColorStop(1, 'rgba(0,0,0,.45)');
  x.fillStyle = v; x.fillRect(0, 0, W, H * .62);
  x.fillStyle = '#d9a184'; x.fillRect(W * .66, H * .62, W * .34, H * .38); // skin tone
  const r = x.createLinearGradient(0, 0, W * .66, 0); r.addColorStop(0, '#000'); r.addColorStop(1, '#fff');
  x.fillStyle = r; x.fillRect(0, H * .62, W * .66, H * .38);
  const lut = luts.get(id), img = x.getImageData(0, 0, W, H), d = img.data;
  if (lut) for (let i = 0; i < d.length; i += 4) {
    let p = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
    if (log) p = p.map(c2 => linearToAppleLog(srgbEotf(c2))); // log LUTs expect log input
    const o = sampleLut(lut, ...p);
    d[i] = o[0] * 255; d[i + 1] = o[1] * 255; d[i + 2] = o[2] * 255;
  }
  x.putImageData(img, 0, 0);
  const url = c.toDataURL();
  thumbCache.set(key, url);
  return url;
}

// ───────── layers: logos / watermarks / text drawn on top of the output (Camo-style) ─────────
// x, y = center as a fraction of the frame; size = width fraction (image) or height fraction (text).
let layers = store.get('layers', []);
let selId = null;
const imgCache = new Map();
const saveLayers = debounce(() => store.set('layers', layers), 300);
const redraw = () => { if (!live()) placeholder(); else placeSel(); }; // live video redraws on the next frame
function imgOf(l) {
  let img = imgCache.get(l.id);
  if (!img) { img = new Image(); img.onload = redraw; img.src = l.src; imgCache.set(l.id, img); }
  return img;
}
function drawLayers() {
  const W = canvas.width, H = canvas.height;
  for (const l of layers) {
    l.box = null;
    if (!l.visible) continue;
    ctx.globalAlpha = l.opacity;
    if (l.type === 'image') {
      const img = imgOf(l);
      if (!img.naturalWidth) continue;
      const w = l.size * W, hh = w * img.naturalHeight / img.naturalWidth, x = l.x * W - w / 2, y = l.y * H - hh / 2;
      ctx.drawImage(img, x, y, w, hh);
      l.box = [x, y, w, hh];
    } else {
      const fs = l.size * H;
      ctx.font = `600 ${fs}px "Segoe UI Variable Display", "Segoe UI"`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const pad = l.bg ? fs * .5 : 0, w = ctx.measureText(l.text || ' ').width + pad * 2, hh = fs * 1.55;
      const x = l.x * W - w / 2, y = l.y * H - hh / 2;
      if (l.bg) { ctx.fillStyle = 'rgba(10,10,14,.62)'; ctx.beginPath(); ctx.roundRect(x, y, w, hh, hh * .28); ctx.fill(); }
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, x + pad, l.y * H);
      l.box = [x, y, w, hh];
    }
  }
  ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
  placeSel();
}
// Selection outline: a DOM element over the preview, so it never reaches the virtual camera.
const selBox = h('div', { class: 'selbox', hidden: true });
function placeSel() {
  const b = layers.find(l => l.id === selId)?.box;
  selBox.hidden = !b;
  if (!b) return;
  const W = canvas.width, H = canvas.height;
  Object.assign(selBox.style, { left: `${b[0] / W * 100}%`, top: `${b[1] / H * 100}%`, width: `${b[2] / W * 100}%`, height: `${b[3] / H * 100}%` });
}
const SIZE = { image: [.03, 1], text: [.02, .2] };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function resize(l, k) { l.size = clamp(l.size * k, ...SIZE[l.type]); saveLayers(); redraw(); }
// Snap to a corner / center, keeping a small margin from the edges.
function place(l, pos) {
  const b = l.box, W = canvas.width, H = canvas.height, m = .035;
  const hw = b ? b[2] / W / 2 : .1, hh = b ? b[3] / H / 2 : .05;
  l.x = pos[1] === 'l' ? m + hw : pos[1] === 'r' ? 1 - m - hw : .5;
  l.y = pos[0] === 't' ? m + hh : pos[0] === 'b' ? 1 - m - hh : .5;
  saveLayers(); redraw();
}
function addLayer(l) {
  layers.push({ id: crypto.randomUUID(), opacity: 1, visible: true, ...l });
  selId = layers.at(-1).id;
  saveLayers(); redraw(); renderLayersBox();
}
function addImageLayer() {
  const input = h('input', { type: 'file', accept: 'image/*' });
  input.onchange = async () => {
    const file = input.files[0];
    const img = file && await createImageBitmap(file).catch(() => null);
    if (!img) return file && toast('Image illisible');
    const k = Math.min(1, 1024 / Math.max(img.width, img.height)); // keeps localStorage small
    const c = h('canvas', { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    addLayer({ type: 'image', name: file.name, src: c.toDataURL('image/webp', .92), x: .84, y: .17, size: .2 }); // webp keeps transparency
  };
  input.click();
}
const addTextLayer = () => addLayer({ type: 'text', text: 'Mon texte', color: '#ffffff', bg: true, x: .5, y: .87, size: .055 });

// Drag on the preview to move, wheel to resize.
let drag = null;
function canvasPt(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * canvas.width, (e.clientY - r.top) / r.height * canvas.height];
}
const hit = ([px, py]) => [...layers].reverse().find(l => l.box && px >= l.box[0] && px <= l.box[0] + l.box[2] && py >= l.box[1] && py <= l.box[1] + l.box[3]);
function bindStage(stage) {
  stage.onpointerdown = e => {
    const p = canvasPt(e), l = hit(p);
    const was = selId;
    selId = l?.id ?? null;
    if (l) { drag = { l, dx: p[0] / canvas.width - l.x, dy: p[1] / canvas.height - l.y }; stage.setPointerCapture(e.pointerId); }
    placeSel();
    if (was !== selId) renderLayersBox();
  };
  stage.onpointermove = e => {
    const p = canvasPt(e);
    if (!drag) { stage.style.cursor = hit(p) ? 'move' : ''; return; }
    drag.l.x = clamp(p[0] / canvas.width - drag.dx, 0, 1);
    drag.l.y = clamp(p[1] / canvas.height - drag.dy, 0, 1);
    redraw();
  };
  stage.onpointerup = () => { if (drag) { drag = null; saveLayers(); } };
  stage.onwheel = e => {
    const l = hit(canvasPt(e)) || layers.find(x => x.id === selId);
    if (!l) return;
    e.preventDefault();
    resize(l, e.deltaY < 0 ? 1.06 : 1 / 1.06);
    if (l.id === selId) renderLayersBox();
  };
}

const logo = new Image();
logo.src = '../assets/icon.png';
function placeholder() {
  const W = canvas.width, H = canvas.height, s = W / 1920;
  const g = ctx.createRadialGradient(W / 2, H * .42, 0, W / 2, H * .42, W * .6);
  g.addColorStop(0, '#1a1530'); g.addColorStop(1, '#07070a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (logo.complete) ctx.drawImage(logo, W / 2 - 120 * s, H * .40 - 200 * s, 240 * s, 240 * s);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5f5f7'; ctx.font = `600 ${84 * s}px "Segoe UI Variable Display", "Segoe UI"`;
  ctx.fillText('AirCam', W / 2, H * .40 + 150 * s);
  ctx.fillStyle = '#9a9aa6'; ctx.font = `${44 * s}px "Segoe UI Variable Text", "Segoe UI"`;
  ctx.fillText(conn.state === 'connected' ? 'Connexion à la caméra…' : 'En attente de l’iPhone', W / 2, H * .40 + 225 * s);
  drawLayers();
  pushVcam();
}
logo.onload = () => { if (!live()) placeholder(); };
setInterval(() => { if (!live()) placeholder(); }, 500); // keep apps that use the camera fed while there's no video

let dec = null, decSps = '', waitKey = true;
function newDecoder(codec) {
  try { dec?.close(); } catch {}
  dec = new VideoDecoder({
    output: draw,
    error: () => { dec = null; decSps = ''; waitKey = true; aircam.keyframe(); },
  });
  dec.configure({ codec, optimizeForLatency: true });
}
aircam.onVideo(u8 => {
  const key = (u8[0] & 1) === 1;
  const data = u8.subarray(9);
  if (key) {
    const s = sps(data), id = s ? s.join(',') : '';
    if (s && (id !== decSps || !dec)) { newDecoder(codecOf(s)); decSps = id; } // new stream / resolution change
    waitKey = false;
  }
  if (!dec || waitKey) return;
  if (dec.decodeQueueSize > 8 && !key) { waitKey = true; aircam.keyframe(); return; } // falling behind: skip to the next keyframe
  const ts = Number(new DataView(u8.buffer, u8.byteOffset + 1, 8).getBigUint64(0));
  dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data }));
});

// ───────── events from main ─────────
aircam.onDevices(d => { devices = d; if (view === 'devices') render(); });
aircam.onState(s => {
  const was = conn.state;
  conn = s;
  if (s.state === 'connected' && was !== 'connected') {
    waitKey = true; decSps = '';
    aircam.control(settings);
    if (settings.background === 'replace') sendBg();
    toast(s.device.via === 'usb' ? 'iPhone connecté en USB' : `Connecté à ${s.device.name}`);
  }
  if (s.state !== 'connected') { status = null; lastFrame = 0; placeholder(); }
  render();
});
aircam.onStatus(st => {
  const relayout = !status || st.cameras.join() !== status.cameras.join() || st.hasTorch !== status.hasTorch || st.maxZoom !== status.maxZoom
    || st.supportsLog !== status.supportsLog || st.settings.log !== status.settings.log || st.maxFps !== status.maxFps;
  status = st;
  if (st.settings.camera !== settings.camera) { settings.camera = st.settings.camera; store.set('settings', settings); }
  if (relayout && (view === 'cam' || view === 'adjust')) render(); else updateChip();
});

function sendBg() {
  if (!bgImage) return;
  aircam.background(Uint8Array.from(atob(bgImage.split(',')[1]), c => c.charCodeAt(0)));
}
// Picked image → JPEG ≤ 1920 px wide (small enough for localStorage and the wire).
function pickBg() {
  const input = h('input', { type: 'file', accept: 'image/*' });
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const img = await createImageBitmap(file).catch(() => null);
    if (!img) return toast('Image illisible');
    const k = Math.min(1, 1920 / img.width);
    const c = h('canvas', { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    bgImage = c.toDataURL('image/jpeg', .88);
    store.set('bgImage', bgImage);
    set('background', 'replace');
    sendBg();
    render();
  };
  input.click();
}

// ───────── views ─────────
const NAV = [['cam', 'Caméra', 'cam'], ['adjust', 'Ajustements', 'adjust'], ['layers', 'Calques', 'layers'], ['devices', 'Appareils', 'phone']];
function renderNav() {
  $('#nav').replaceChildren(
    h('div', { class: 'logo' }, h('img', { src: '../assets/icon.png', alt: '' }), h('span', {}, 'AirCam')),
    ...NAV.map(([v, label, ic]) => h('a', { class: view === v ? 'on' : '', onclick: () => go(v) }, icon(ic), h('span', {}, label))),
    h('div', { class: 'spacer' }),
    h('a', { class: view === 'settings' ? 'on' : '', onclick: () => go('settings') }, icon('gear'), h('span', {}, 'Réglages')));
}
function go(v) { view = v; render(); $('#main').scrollTop = 0; }
function render() {
  renderNav();
  $('#main').replaceChildren({ cam: vCam, adjust: vAdjust, layers: vLayersPage, devices: vDevices, settings: vSettings }[view]());
}

// UI atoms
function seg(options, value, onpick, disabled = () => false) {
  return h('div', { class: 'seg' }, options.map(([v, label]) =>
    h('button', { class: v === value ? 'on' : '', disabled: disabled(v), onclick: e => {
      for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget);
      onpick(v);
    } }, label)));
}
function toggle(label, value, onchange, disabled = false) {
  const sw = h('button', { class: 'switch' + (value ? ' on' : ''), role: 'switch', 'aria-checked': String(!!value), 'aria-label': label, disabled,
    onclick: () => { const on = !sw.classList.contains('on'); sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); onchange(on); } });
  return h('div', { class: 'row' }, h('span', {}, label), sw);
}
// grad: track gradient instead of the accent fill; bare: no label column (label shown elsewhere).
function slider(label, min, max, step, value, fmt, oninput, grad, bare) {
  const out = h('output', {}, fmt(value));
  const r = h('input', { type: 'range', min, max, step, value, 'aria-label': label, class: grad ? 'grad' : null, style: grad ? `background:${grad}` : null });
  const paint = () => r.style.setProperty('--p', `${(r.value - min) / (max - min) * 100}%`);
  r.oninput = () => { paint(); out.textContent = fmt(+r.value); oninput(+r.value); };
  paint();
  return h('div', { class: 'row' }, !bare && h('span', { style: 'flex:none;width:96px' }, label), r, out);
}
const box = (title, ...kids) => h('div', { class: 'box' }, h('h3', {}, title), ...kids);

let chip = null;
function updateChip() {
  if (!chip) return;
  const c = conn.state === 'connected';
  const parts = [c ? (conn.device.via === 'usb' ? 'USB' : 'Wi-Fi') : 'En attente de l’iPhone'];
  if (status) {
    parts.push(`${status.height}p · ${status.fps} i/s`);
    if (status.battery >= 0) parts.push(`batterie ${status.battery} %`);
  }
  chip.replaceChildren(h('span', { class: 'dot' + (c && status ? ' ok' : c ? '' : ' off') }), parts.join(' · '));
}

function vCam() {
  const c = conn.state === 'connected';
  chip = h('span', { class: 'chip' });
  updateChip();
  const cams = status?.cameras || Object.keys(CAMS);

  const stage = h('div', { class: 'stage' }, canvas, chip);
  const vcamLine = vcamInstalled === false
    ? [h('span', { class: 'dot' }), h('span', { class: 'grow' }, 'La webcam virtuelle « AirCam » n’est pas installée.'), h('button', { class: 'btn small', onclick: installVcam }, 'Installer')]
    : [h('span', { class: 'dot ok' }), h('span', { class: 'grow' }, 'Choisis « AirCam » comme caméra dans Zoom, Teams, Discord, OBS…')];
  const left = h('div', {}, stage, h('div', { class: 'under' }, vcamLine,
    c ? h('button', { class: 'btn small', onclick: () => aircam.disconnect() }, 'Déconnecter')
      : h('button', { class: 'btn small', onclick: () => go('devices') }, 'Appareils')));

  const off = c ? '' : ' off';
  const panel = h('div', { class: 'panel' },
    h('div', { class: 'box' + off }, h('h3', {}, 'Caméra'),
      seg(Object.entries(CAMS).filter(([k]) => cams.includes(k)).map(([k, v]) => [k, v.replace('Ultra grand-angle', 'Ultra GA').replace('Téléobjectif', 'Télé')]),
        settings.camera, v => { set('camera', v); if (v === 'front' && settings.torch) set('torch', false); })),
    h('div', { class: 'box' + off }, h('h3', {}, 'Image'),
      seg([['720p', '720p'], ['1080p', '1080p'], ['4k', '4K']], settings.resolution, v => set('resolution', v)),
      seg([[30, '30 i/s'], [60, '60 i/s'], [120, '120 i/s']], settings.fps, v => set('fps', v), v => !!status?.maxFps && v > status.maxFps),
      slider('Zoom', 1, Math.max(1.01, status?.maxZoom || 5), .05, settings.zoom, v => `${v.toFixed(1)}×`, v => set('zoom', v)),
      slider('Exposition', -2, 2, .1, settings.exposure, v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, v => set('exposure', v)),
      toggle('Mise au point verrouillée', settings.focus === 'locked', on => set('focus', on ? 'locked' : 'auto')),
      toggle('Miroir', ui.mirror, on => setUi('mirror', on)),
      toggle('Retourner (180°)', ui.rotate, on => setUi('rotate', on))),
    h('div', { class: 'box' + off }, h('h3', {}, 'Lumière'),
      toggle('Lampe torche', settings.torch, on => set('torch', on), !status?.hasTorch)),
    h('div', { class: 'box' + off }, h('h3', {}, 'Arrière-plan'),
      seg([['none', 'Aucun'], ['blur', 'Flou'], ['replace', 'Image']], settings.background, v => {
        if (v === 'replace' && !bgImage) return pickBg();
        set('background', v);
        if (v === 'replace') sendBg();
        render();
      }),
      settings.background === 'replace' && bgImage && h('div', { class: 'bgthumb', style: `background-image:url("${bgImage}")` }),
      settings.background === 'replace' && h('button', { class: 'btn small', onclick: pickBg }, icon('image'), 'Changer d’image')));

  return h('div', { class: 'cam' }, left, panel);
}

// Ajustements: white balance (on the phone's sensor), color adjustments + LUTs (on the PC's GPU).
function vAdjust() {
  chip = h('span', { class: 'chip' });
  updateChip();
  const stage = h('div', { class: 'stage' }, canvas, chip);
  const manual = settings.whiteBalance === 'manual';
  const wbRows = h('div', { class: 'stack' + (manual ? '' : ' off') },
    slider('Température', 2500, 10000, 50, settings.temperature, v => manual ? `${v} K` : 'Auto', v => set('temperature', v), 'linear-gradient(90deg,#3d7bff,#cfe0ff,#fff1c9,#ffb03d)'),
    slider('Teinte', -150, 150, 1, settings.tint, v => manual ? `${v > 0 ? '+' : ''}${v}` : 'Auto', v => set('tint', v), 'linear-gradient(90deg,#3ddc4a,#ccc,#e04ae0)'));
  const fresh = () => { redraw(); saveColor(); };
  const adjRows = Object.entries(ADJ).map(([k, [label, grad]]) => {
    const a = adj[k];
    const row = slider(label, -100, 100, 1, a.v, v => `${v > 0 ? '+' : ''}${v}`, v => { a.v = v; if (!a.on) { a.on = true; sw.classList.add('on'); } fresh(); }, grad, true);
    const t = toggle(label, a.on, on => { a.on = on; fresh(); });
    const sw = t.querySelector('.switch');
    return h('div', { class: 'adj' }, t, row);
  });
  const userList = userLuts.filter(f => luts.has('user:' + f));
  const lutCard = (id, name, removable) => h('div', { class: 'lut' + ((look.lut ?? null) === id ? ' on' : ''), title: name,
    onclick: () => { look.lut = id; saveColor(); redraw(); render(); } },
    h('div', { class: 'lthumb2', style: `background-image:url("${lutThumb(id)}")` }),
    h('span', {}, name),
    removable && h('button', { class: 'rm', 'aria-label': `Supprimer ${name}`, onclick: async e => {
      e.stopPropagation();
      await aircam.luts.remove(removable);
      luts.delete(id); if (look.lut === id) look.lut = null;
      await loadUserLuts(); saveColor(); redraw(); render();
    } }, icon('x')));
  const logOk = !!status?.supportsLog;
  return h('div', { class: 'cam' },
    h('div', {}, stage, h('div', { class: 'under' }, h('span', { class: 'grow' },
      grader ? 'Les ajustements et la LUT sont appliqués à l’image envoyée dans la webcam « AirCam ».' : 'WebGL2 indisponible : les ajustements et LUT sont désactivés.'))),
    h('div', { class: 'panel' },
      h('div', { class: 'box' }, h('h3', {}, 'Balance des blancs'),
        seg([['auto', 'Auto'], ['manual', 'Manuelle']], settings.whiteBalance, v => { set('whiteBalance', v); render(); }),
        wbRows),
      h('div', { class: 'box' }, h('div', { class: 'boxhead' }, h('h3', {}, 'Ajustements'),
        h('button', { class: 'iconbtn', title: 'Tout réinitialiser', 'aria-label': 'Tout réinitialiser', onclick: () => {
          for (const a of Object.values(adj)) { a.on = false; a.v = 0; }
          fresh(); render();
        } }, icon('reset'))), adjRows),
      h('div', { class: 'box' }, h('h3', {}, 'Apple Log'),
        toggle('Filmer en Apple Log', settings.log, on => { set('log', on); thumbCache.clear(); setTimeout(render, 400); }, !logOk && !settings.log),
        h('small', { class: 'muted' }, logOk || settings.log
          ? 'Image log (iPhone 15 Pro et plus) : plus de dynamique, convertie par la LUT. Sans LUT choisie, la conversion Apple Log → Rec.709 intégrée s’applique.'
          : conn.state === 'connected' ? 'Cette caméra ne filme pas en Apple Log (iPhone 15 Pro et plus, caméras arrière).' : 'Connecte l’iPhone pour activer l’Apple Log.')),
      h('div', { class: 'box' }, h('div', { class: 'boxhead' }, h('h3', {}, 'LUT'),
        h('button', { class: 'btn small', onclick: importLuts }, icon('plus'), 'Importer .cube')),
        h('div', { class: 'luts' },
          lutCard(null, settings.log ? 'Log → Rec.709' : 'Aucune'),
          Object.entries(LOOKS).map(([k, [name]]) => lutCard('look:' + k, name)),
          userList.map(f => lutCard('user:' + f, f.replace(/\.cube$/i, ''), f))),
        slider('Intensité', 0, 100, 1, look.intensity, v => `${v} %`, v => { look.intensity = v; fresh(); }),
        h('small', { class: 'muted' }, settings.log ? 'En Apple Log, choisis une LUT prévue pour l’Apple Log (ex. Apple Log → Rec.709, The One LUT).' : 'Fichiers .cube 3D (Resolve, Blackmagic Camera, Lightroom…).'))));
}

// Layers page: same preview (drag layers on it) + the layer editor.
function vLayersPage() {
  chip = h('span', { class: 'chip' });
  updateChip();
  const stage = h('div', { class: 'stage' }, canvas, selBox, chip);
  bindStage(stage);
  layersBox = vLayers();
  return h('div', { class: 'cam' },
    h('div', {}, stage, h('div', { class: 'under' }, h('span', { class: 'grow' }, 'Glisse un calque sur l’aperçu pour le déplacer, molette pour changer sa taille. Les calques apparaissent dans la webcam « AirCam ».'))),
    h('div', { class: 'panel' }, layersBox));
}

let layersBox = null;
function renderLayersBox() { if (!layersBox) return; const nb = vLayers(); layersBox.replaceWith(nb); layersBox = nb; }
const COLORS = ['#ffffff', '#000000', '#b39dff', '#7c5cff', '#ff5c8a', '#ffd166', '#3ddc84', '#4cc9f0'];
function vLayers() {
  const sel = layers.find(l => l.id === selId);
  const upd = () => { saveLayers(); redraw(); };
  return h('div', { class: 'box' }, h('h3', {}, 'Calques'),
    h('div', { class: 'btns' },
      h('button', { class: 'btn small', onclick: addImageLayer }, icon('image'), 'Image'),
      h('button', { class: 'btn small', onclick: addTextLayer }, icon('text'), 'Texte')),
    layers.length
      ? h('div', { class: 'layers' }, [...layers].reverse().map(l => h('div', { class: 'layer' + (l.id === selId ? ' on' : ''), onclick: () => { selId = l.id; placeSel(); renderLayersBox(); } },
        h('button', { class: 'eye', 'aria-label': l.visible ? 'Masquer' : 'Afficher', onclick: e => { e.stopPropagation(); l.visible = !l.visible; upd(); renderLayersBox(); } }, icon(l.visible ? 'eye' : 'eyeoff')),
        l.type === 'image' ? h('span', { class: 'lthumb', style: `background-image:url("${l.src}")` }) : h('span', { class: 'lthumb t' }, 'T'),
        h('span', { class: 'lname' + (l.visible ? '' : ' muted') }, l.type === 'text' ? l.text || 'Texte' : l.name))))
      : h('small', { class: 'muted' }, 'Ajoute un logo, un filigrane ou un texte par-dessus la caméra. Glisse-les sur l’aperçu pour les placer, molette pour la taille.'),
    sel && h('div', { class: 'editor' },
      sel.type === 'text' && h('input', { class: 'field', value: sel.text, maxlength: 120, oninput: e => { sel.text = e.target.value; upd(); }, onchange: renderLayersBox }),
      sel.type === 'text' && h('div', { class: 'swatches' }, COLORS.map(c =>
        h('button', { class: 'sw' + (sel.color === c ? ' on' : ''), style: `background:${c}`, 'aria-label': `Couleur ${c}`, onclick: () => { sel.color = c; upd(); renderLayersBox(); } }))),
      sel.type === 'text' && toggle('Fond', sel.bg, on => { sel.bg = on; upd(); }),
      slider('Taille', ...SIZE[sel.type], .001, sel.size, v => `${Math.round(v * 100)} %`, v => { sel.size = v; upd(); }),
      slider('Opacité', .05, 1, .01, sel.opacity, v => `${Math.round(v * 100)} %`, v => { sel.opacity = v; upd(); }),
      h('div', { class: 'row' }, h('span', {}, 'Position'), h('div', { class: 'seg pos' }, [['tl', 'en haut à gauche'], ['tr', 'en haut à droite'], ['cc', 'au centre'], ['bl', 'en bas à gauche'], ['br', 'en bas à droite']].map(([p, label]) =>
        h('button', { 'aria-label': `Placer ${label}`, title: `Placer ${label}`, onclick: () => place(sel, p) }, posIcon(p))))),
      h('div', { class: 'btns' },
        h('button', { class: 'btn small', 'aria-label': 'Monter', onclick: () => move(sel, 1) }, icon('up')),
        h('button', { class: 'btn small', 'aria-label': 'Descendre', onclick: () => move(sel, -1) }, icon('down')),
        h('button', { class: 'btn small danger', onclick: () => { layers = layers.filter(l => l !== sel); imgCache.delete(sel.id); selId = null; upd(); renderLayersBox(); } }, icon('trash'), 'Supprimer'))));
}
// Mini frame with a dot where the layer goes.
function posIcon(p) {
  const s = icon('image');
  const cx = p[1] === 'l' ? 7.5 : p[1] === 'r' ? 16.5 : 12, cy = p[0] === 't' ? 8.5 : p[0] === 'b' ? 15.5 : 12;
  s.innerHTML = `<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle class="fill" cx="${cx}" cy="${cy}" r="2.2"/>`;
  return s;
}
// Reorder: +1 = towards the front (drawn later).
function move(l, dir) {
  const i = layers.indexOf(l), j = i + dir;
  if (j < 0 || j >= layers.length) return;
  [layers[i], layers[j]] = [layers[j], layers[i]];
  saveLayers(); redraw(); renderLayersBox();
}

function vDevices() {
  const ipField = h('input', { class: 'field', placeholder: 'Adresse IP de l’iPhone (ex. 192.168.1.42)', inputmode: 'decimal' });
  const connectIp = () => { const v = ipField.value.trim(); if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) aircam.connectIp(v); else toast('Adresse IP invalide'); };
  ipField.onkeydown = e => { if (e.key === 'Enter') connectIp(); };
  const current = conn.state === 'connected' ? conn.device.id : null;
  return h('div', { class: 'page' },
    h('h1', {}, 'Appareils'),
    h('p', { class: 'sub' }, 'Ouvre AirCam sur l’iPhone : il apparaît ici tout seul, en Wi-Fi (même réseau) ou en USB. AirCam se connecte automatiquement, en USB de préférence.'),
    devices.length ? h('div', { class: 'list' }, devices.map(d => h('div', { class: 'card' + (d.id === current ? ' on' : '') },
      h('div', { class: 'ic' }, icon(d.via === 'usb' ? 'usb' : 'wifi')),
      h('div', { class: 'txt' }, h('b', {}, d.id === current && status ? status.name : d.name),
        h('small', {}, d.via === 'usb' ? 'Câble USB' : `Wi-Fi · ${d.host}`, d.id === current ? ' · connecté' : '')),
      d.id === current ? h('button', { class: 'btn small', onclick: () => aircam.disconnect() }, 'Déconnecter')
        : h('button', { class: 'btn small primary', onclick: () => aircam.connect(d.id) }, 'Connecter'))))
      : h('div', { class: 'empty' }, 'Aucun iPhone trouvé. Vérifie que l’app AirCam est ouverte sur l’iPhone et que le PC et l’iPhone sont sur le même Wi-Fi (ou branche le câble).'),
    h('h2', { class: 'section' }, 'Connexion manuelle'),
    h('div', { class: 'inline' }, ipField, h('button', { class: 'btn', onclick: connectIp }, 'Connecter')),
    h('h2', { class: 'section' }, 'Installer l’app iPhone'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Télécharge ', h('code', {}, 'AirCam.ipa'), ' dans la dernière release GitHub : ', h('a', { onclick: () => window.open('https://github.com/kf5-io/AirCam/releases') }, 'github.com/kf5-io/AirCam/releases'), '.'),
      h('li', {}, 'Installe-la avec ', h('a', { onclick: () => window.open('https://sideloadly.io') }, 'Sideloadly'), ' (iPhone branché, connecte-toi avec ton identifiant Apple).'),
      h('li', {}, 'Sur l’iPhone : Réglages › Général › VPN et gestion de l’appareil › fais confiance à ton identifiant. Active aussi le mode développeur si iOS le demande.'),
      h('li', {}, 'Avec un identifiant Apple gratuit, l’app expire au bout de 7 jours : relance Sideloadly pour la réinstaller.')));
}

function vSettings() {
  return h('div', { class: 'page' },
    h('h1', {}, 'Réglages'),
    h('div', { class: 'list' },
      box('Webcam virtuelle',
        h('div', { class: 'row' }, h('span', {}, vcamInstalled ? 'Installée : « AirCam » apparaît dans la liste des caméras de tes applications.' : 'Pas installée.'),
          h('button', { class: 'btn small', onclick: () => installVcam(!vcamInstalled) }, vcamInstalled ? 'Désinstaller' : 'Installer')),
        h('div', { class: 'row' }, h('span', {}, 'Résolution de sortie'),
          h('div', { style: 'width:200px' }, seg([['720p', '720p'], ['1080p', '1080p']], ui.output, v => setUi('output', v)))),
        h('small', { class: 'muted' }, 'Les applications déjà ouvertes doivent être relancées pour voir la nouvelle résolution ou une caméra fraîchement installée.')),
      box('À propos',
        h('div', {}, h('b', {}, 'AirCam'), ' — projet open source (MIT). ',
          h('a', { onclick: () => window.open('https://github.com/kf5-io/AirCam') }, 'github.com/kf5-io/AirCam')),
        h('small', { class: 'muted' }, 'Webcam virtuelle basée sur softcam (MIT, tshino). Même design que KF Player.'))));
}

async function installVcam(on = true) {
  toast(on ? 'Windows va demander l’autorisation administrateur…' : 'Désinstallation…');
  vcamInstalled = await aircam.vcam.register(on);
  toast(vcamInstalled ? 'Webcam virtuelle installée' : on ? 'Installation annulée' : 'Webcam virtuelle désinstallée');
  render();
}

// ───────── boot ─────────
render();
openVcam();
loadUserLuts().then(() => { if (view === 'adjust') render(); });
aircam.vcam.registered().then(r => { vcamInstalled = r; render(); });
