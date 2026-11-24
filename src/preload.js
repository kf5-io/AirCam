const { contextBridge, ipcRenderer } = require('electron');
const koffi = require('koffi');

// Virtual camera (softcam DLL): frames are 24-bit BGR, top-down, width*height*3 bytes.
let lib, cam = null, size = null;
let fn = null;
async function vcamOpen(width, height) {
  if (cam && size.width === width && size.height === height) return true;
  vcamClose();
  if (!fn) {
    const dll = await ipcRenderer.invoke('dll-path');
    if (!dll) return false;
    lib = koffi.load(dll);
    fn = {
      create: lib.func('void* __cdecl scCreateCamera(int, int, float)'),
      remove: lib.func('void __cdecl scDeleteCamera(void*)'),
      send: lib.func('void __cdecl scSendFrame(void*, const uint8_t*)'),
      connected: lib.func('bool __cdecl scIsConnected(void*)'),
    };
  }
  cam = fn.create(width, height, 0); // 0: no pacing, we push frames as they arrive from the phone
  size = { width, height };
  return !!cam;
}
function vcamClose() { if (cam) { fn.remove(cam); cam = null; } }
window.addEventListener('beforeunload', vcamClose);
const softcamInUse = () => !!cam && fn.connected(cam);

// Media Foundation camera (Windows 11, native/mfcam): the media source creates "Global\AirCamMF" while an app
// uses the camera; we write BGRA frames into it. Layout documented in native/mfcam/FrameGenerator.h.
const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32_t, bool, str16)');
const MapViewOfFile = k32.func('void* __stdcall MapViewOfFile(void*, uint32_t, uint32_t, uint32_t, size_t)');
const GetTickCount64 = k32.func('uint64_t __stdcall GetTickCount64()');
const MF_HEADER = 64, MF_MAX = 1920 * 1920, MF_SIZE = MF_HEADER + MF_MAX * 4, FILE_MAP_RW = 0x0002 | 0x0004;
let mf = null, mfTried = 0;
function mfView() {
  if (mf || Date.now() - mfTried < 1000) return mf;
  mfTried = Date.now();
  const h = OpenFileMappingW(FILE_MAP_RW, false, 'Global\\AirCamMF'); // absent until an app opens the camera
  const p = h && MapViewOfFile(h, FILE_MAP_RW, 0, 0, MF_SIZE);
  if (!p) return null;
  const ab = koffi.view(p, MF_SIZE);
  mf = { dv: new DataView(ab), px: new Uint32Array(ab, MF_HEADER) };
  return mf;
}
const mfInUse = () => { const m = mfView(); return !!m && Number(GetTickCount64()) - Number(m.dv.getBigUint64(24, true)) < 2000; };
function mfWrite(rgba, w, h) {
  if (w * h > MF_MAX) return;
  const { dv, px } = mf, src = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
  const seq = dv.getUint32(12, true);
  dv.setUint32(12, (seq | 1) >>> 0, true); // odd: writing
  for (let i = 0; i < src.length; i++) { const v = src[i]; px[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff); } // RGBA → BGRA
  dv.setUint32(0, 0x464D4341, true); dv.setUint32(4, w, true); dv.setUint32(8, h, true);
  dv.setBigUint64(16, BigInt(GetTickCount64()), true);
  dv.setUint32(12, ((seq | 1) + 1) >>> 0, true); // even: done
}
let bgr = null;
function sendRgba(rgba, w, h) {
  if (rgba.length !== w * h * 4) return;
  if (softcamInUse() && size.width === w && size.height === h) {
    if (!bgr || bgr.length !== w * h * 3) bgr = new Uint8Array(w * h * 3);
    const s32 = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h); // one read per pixel (little endian: 0xAABBGGRR)
    for (let i = 0, j = 0; i < s32.length; i++, j += 3) { const v = s32[i]; bgr[j] = (v >>> 16) & 255; bgr[j + 1] = (v >>> 8) & 255; bgr[j + 2] = v & 255; }
    fn.send(cam, bgr);
  }
  if (mfInUse()) mfWrite(rgba, w, h);
}

const on = (ch, f) => ipcRenderer.on(ch, (_e, v) => f(v));
contextBridge.exposeInMainWorld('aircam', {
  onDevices: f => on('devices', f),
  onState: f => on('state', f),
  onStatus: f => on('status', f),
  onVideo: f => on('video', f), // Uint8Array: [flags][u64 pts µs][H.264 Annex B]
  onFaces: f => on('faces', f), // [[x, y, w, h], …] normalized, top-left origin
  connect: id => ipcRenderer.send('connect', id),
  connectIp: host => ipcRenderer.send('connect-ip', host),
  disconnect: () => ipcRenderer.send('disconnect'),
  control: settings => ipcRenderer.send('control', settings),
  keyframe: () => ipcRenderer.send('keyframe'),
  focus: (x, y) => ipcRenderer.send('focus', x, y),
  background: bytes => ipcRenderer.send('background', bytes),
  update: {
    get: () => ipcRenderer.invoke('update-get'),
    on: f => on('update', f),
    check: () => ipcRenderer.send('update-check'),
    install: () => ipcRenderer.send('update-install'),
  },
  profiles: {
    read: () => ipcRenderer.invoke('profiles-read'),
    write: list => ipcRenderer.invoke('profiles-write', list),
  },
  luts: {
    list: () => ipcRenderer.invoke('lut-list'),
    read: name => ipcRenderer.invoke('lut-read', name),
    remove: name => ipcRenderer.invoke('lut-delete', name),
    import: () => ipcRenderer.invoke('lut-import'),
  },
  vcam: {
    registered: () => ipcRenderer.invoke('vcam-registered'),
    register: on => ipcRenderer.invoke('vcam-register', on),
    open: (w, h) => vcamOpen(w, h),
    wanted: () => softcamInUse() || mfInUse(), // an app is reading one of our cameras
    mf: () => mfInUse(), // the experimental Media Foundation camera is being read (it needs RGBA, see send)
    send: (rgba, w, h) => sendRgba(rgba, w, h), // canvas RGBA, top-down
    sendBgr: (bgr, w, h) => { // already packed for softcam on the GPU (renderer/readback.js)
      if (softcamInUse() && size.width === w && size.height === h && bgr.length === w * h * 3) fn.send(cam, bgr);
    },
  },
});
