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
    inUse: () => !!cam && fn.connected(cam),
    send: bgr => { if (cam && bgr.length === size.width * size.height * 3) fn.send(cam, bgr); },
  },
});
