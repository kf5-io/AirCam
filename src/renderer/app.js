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
const DEFAULTS = { camera: 'back', resolution: '1080p', fps: 30, torch: false, zoom: 1, exposure: 0, focus: 'auto', background: 'none' };
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
  ctx.drawImage(frame, (W - fw * k) / 2, (H - fh * k) / 2, fw * k, fh * k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  frame.close();
  lastFrame = performance.now();
  pushVcam();
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
  const relayout = !status || st.cameras.join() !== status.cameras.join() || st.hasTorch !== status.hasTorch || st.maxZoom !== status.maxZoom;
  status = st;
  if (st.settings.camera !== settings.camera) { settings.camera = st.settings.camera; store.set('settings', settings); }
  if (relayout && view === 'cam') render(); else updateChip();
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
const NAV = [['cam', 'Caméra', 'cam'], ['devices', 'Appareils', 'phone']];
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
  $('#main').replaceChildren({ cam: vCam, devices: vDevices, settings: vSettings }[view]());
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
function slider(label, min, max, step, value, fmt, oninput) {
  const out = h('output', {}, fmt(value));
  const r = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const paint = () => r.style.setProperty('--p', `${(r.value - min) / (max - min) * 100}%`);
  r.oninput = () => { paint(); out.textContent = fmt(+r.value); oninput(+r.value); };
  paint();
  return h('div', { class: 'row' }, h('span', { style: 'flex:none;width:96px' }, label), r, out);
}
const box = (title, ...kids) => h('div', { class: 'box' }, h('h3', {}, title), ...kids);

let chip = null;
function updateChip() {
  if (!chip) return;
  const c = conn.state === 'connected';
  const parts = [c ? (conn.device.via === 'usb' ? 'USB' : 'Wi-Fi') : 'En attente de l’iPhone'];
  if (status) {
    parts.push(`${status.height}p · ${status.fps} i/s`);
    if (status.battery >= 0) parts.push(`🔋 ${status.battery} %`);
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
      seg([[30, '30 i/s'], [60, '60 i/s']], settings.fps, v => set('fps', v)),
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
aircam.vcam.registered().then(r => { vcamInstalled = r; render(); });
