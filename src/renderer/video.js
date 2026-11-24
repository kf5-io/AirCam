'use strict';
/* Pure helpers for the video pipeline (loaded by index.html, unit-tested by test/video.test.js). */

// First NAL unit of `type` in an Annex B buffer, without its start code (or null). HEVC NAL headers keep the type in bits 1-6.
function nal(u8, type, hevc = false) {
  for (let i = 0; i + 3 < u8.length; i++) {
    if (u8[i] !== 0 || u8[i + 1] !== 0 || u8[i + 2] !== 1 || (hevc ? (u8[i + 3] >> 1) & 0x3f : u8[i + 3] & 0x1f) !== type) continue;
    let end = i + 3;
    while (end + 2 < u8.length && !(u8[end] === 0 && u8[end + 1] === 0 && (u8[end + 2] === 1 || u8[end + 2] === 0))) end++;
    return u8.subarray(i + 3, end + 2 < u8.length ? end : u8.length);
  }
  return null;
}
const sps = (u8, hevc = false) => nal(u8, hevc ? 33 : 7, hevc);
const HEVC_CODEC = 'hvc1.1.6.L153.B0'; // Main, level 5.1 (4K60): the decoder reads the real values from the SPS
// WebCodecs codec string from the SPS: avc1.PPCCLL (profile, constraint flags, level).
function codecOf(spsNal, hevc = false) {
  if (hevc) return HEVC_CODEC;
  const hx = b => b.toString(16).padStart(2, '0');
  return spsNal && spsNal.length >= 4 ? `avc1.${hx(spsNal[1])}${hx(spsNal[2])}${hx(spsNal[3])}` : null;
}
// Canvas RGBA → softcam BGR (24-bit), into a preallocated buffer.
function rgbaToBgr(src, dst) {
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) { dst[j] = src[i + 2]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i]; }
  return dst;
}

// ───────── 3D LUTs ─────────
// A LUT is { size, data: Float32Array } with RGB triplets, red fastest, then green, then blue (.cube order).

/** Parses an Adobe/Resolve .cube 3D LUT. Throws on anything we can't apply faithfully. */
function parseCube(text) {
  let size = 0, min = [0, 0, 0], max = [1, 1, 1];
  const vals = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/), k = p[0].toUpperCase();
    if (k === 'LUT_3D_SIZE') size = parseInt(p[1], 10);
    else if (k === 'LUT_1D_SIZE') throw new Error('LUT 1D non prise en charge (il faut une LUT 3D)');
    else if (k === 'DOMAIN_MIN') min = p.slice(1, 4).map(Number);
    else if (k === 'DOMAIN_MAX') max = p.slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(k)) vals.push(+p[0], +p[1], +p[2]);
  }
  if (!(size >= 2 && size <= 129) || vals.length !== size ** 3 * 3 || vals.some(v => !Number.isFinite(v))) throw new Error('Fichier .cube invalide');
  if (min.some(v => v !== 0) || max.some(v => v !== 1)) throw new Error('Domaine de LUT non standard (DOMAIN_MIN/MAX)');
  return { size, data: Float32Array.from(vals) };
}

/** Trilinear lookup (CPU; used for thumbnails and tests, the GPU does the video). */
function sampleLut({ size, data }, r, g, b) {
  const n = size - 1, f = v => Math.min(n, Math.max(0, v * n));
  const x = f(r), y = f(g), z = f(b), x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(n, x0 + 1), y1 = Math.min(n, y0 + 1), z1 = Math.min(n, z0 + 1), dx = x - x0, dy = y - y0, dz = z - z0;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = (i, j, k) => data[((k * size + j) * size + i) * 3 + c];
    const l = (a, bb, t) => a + (bb - a) * t;
    out[c] = l(l(l(v(x0, y0, z0), v(x1, y0, z0), dx), l(v(x0, y1, z0), v(x1, y1, z0), dx), dy),
      l(l(v(x0, y0, z1), v(x1, y0, z1), dx), l(v(x0, y1, z1), v(x1, y1, z1), dx), dy), dz);
  }
  return out;
}

function makeLut(size, fn) {
  const data = new Float32Array(size ** 3 * 3), n = size - 1;
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = fn(r / n, g / n, b / n);
    data[i++] = Math.min(1, Math.max(0, o[0])); data[i++] = Math.min(1, Math.max(0, o[1])); data[i++] = Math.min(1, Math.max(0, o[2]));
  }
  return { size, data };
}

// Apple Log curve (Apple Log Profile white paper), Rec.2020 primaries.
const AL = { R0: -0.05641088, Rt: 0.01, c: 47.28711236, b: 0.00964052, g: 0.08550479, d: 0.69336945 };
const AL_PT = AL.c * (AL.Rt - AL.R0) ** 2;
const appleLogToLinear = P => P <= 0 ? AL.R0 : P < AL_PT ? Math.sqrt(P / AL.c) + AL.R0 : 2 ** ((P - AL.d) / AL.g) - AL.b;
const linearToAppleLog = R => R < AL.R0 ? 0 : R < AL.Rt ? AL.c * (R - AL.R0) ** 2 : AL.g * Math.log2(R + AL.b) + AL.d;
const srgbOetf = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
const srgbEotf = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const aces = x => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14); // filmic tone map (Narkowicz fit)
function appleLogToRec709(r, g, b) {
  const [R, G, B] = [r, g, b].map(appleLogToLinear);
  const lin = [1.6605 * R - 0.5876 * G - 0.0728 * B, -0.1246 * R + 1.1329 * G - 0.0083 * B, -0.0182 * R - 0.1006 * G + 1.1187 * B]; // 2020 → 709
  return lin.map(x => srgbOetf(Math.min(1, aces(Math.max(0, x) * 0.8))));
}

// House looks (display-referred input). Free to use, generated on the fly.
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const scurve = (x, k) => x + k * x * (1 - x) * (2 * x - 1) * -1; // k > 0: more contrast
const LOOKS = {
  warm: ['Chaud', (r, g, b) => [scurve(r * 1.06 + .02, .15), g * 1.01, b * .88]],
  cold: ['Froid', (r, g, b) => [r * .9, g * .99, scurve(b * 1.06 + .03, .15)]],
  bw: ['Noir et blanc', (r, g, b) => { const l = scurve(lum(r, g, b), .45); return [l, l, l]; }],
  teal: ['Teal & Orange', (r, g, b) => {
    const l = lum(r, g, b), t = l * l * (3 - 2 * l); // shadows teal, highlights orange
    const sat = c => l + (c - l) * 1.15;
    return [sat(r) + (t - .5) * .12, sat(g) + (t - .5) * .02, sat(b) - (t - .5) * .16].map(c => scurve(c, .25));
  }],
  vintage: ['Vintage', (r, g, b) => {
    const l = lum(r, g, b), d = c => .07 + (l + (c - l) * .75) * .86; // faded blacks, softer colors
    return [d(r) * 1.05, d(g), d(b) * .9];
  }],
};

// ───────── framing (crop rectangle in normalized source coordinates) ─────────
/** Largest centered crop of the output aspect `ar` (w/h) inside a source of aspect `srcAr`. */
function coverCrop(srcAr, ar) {
  const w = Math.min(1, ar / srcAr), h = Math.min(1, srcAr / ar);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}
/** Center Stage-like target: keeps every face in frame, heads in the upper third, never zooms past 2.5×. */
function framingTarget(faces, full) {
  if (!faces.length) return full;
  const x0 = Math.min(...faces.map(f => f[0])), y0 = Math.min(...faces.map(f => f[1]));
  const x1 = Math.max(...faces.map(f => f[0] + f[2])), y1 = Math.max(...faces.map(f => f[1] + f[3]));
  const k = full.w / full.h; // crop aspect stays the output aspect
  const h = Math.min(full.h, Math.max(full.h / 2.5, (y1 - y0) / .3, (x1 - x0) / .6 / k));
  const w = h * k;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 + h * .12; // faces a bit above center
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }; // may pan over the whole source, not just the centered crop
}
/** Moves `cur` towards `target`; dt in seconds. Small moves are ignored so the frame doesn't swim. */
function easeCrop(cur, target, dt, tau = .45) {
  if (!cur) return { ...target };
  const d = Math.max(Math.abs(cur.x - target.x), Math.abs(cur.y - target.y), Math.abs(cur.w - target.w));
  if (d < .015) return cur;
  const t = 1 - Math.exp(-dt / tau);
  return { x: cur.x + (target.x - cur.x) * t, y: cur.y + (target.y - cur.y) * t, w: cur.w + (target.w - cur.w) * t, h: cur.h + (target.h - cur.h) * t };
}

if (typeof module !== 'undefined') module.exports = {
  HEVC_CODEC,
  coverCrop, framingTarget, easeCrop,
  nal, sps, codecOf, rgbaToBgr, parseCube, sampleLut, makeLut, appleLogToLinear, linearToAppleLog, appleLogToRec709, srgbEotf, LOOKS,
};
