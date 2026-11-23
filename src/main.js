const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { Bonjour } = require('bonjour-service');
const { MSG, PORT, encode, Parser } = require('./protocol');
const usbmux = require('./usbmux');

// softcam registers a single system-wide camera: a second AirCam would fail to create it.
if (!app.requestSingleInstanceLock()) app.quit();

const CLSID = '{EA0F6050-9B6B-4207-AD34-B86E412C645E}'; // must match .github/workflows/softcam.yml
function dllPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'softcam', 'softcam.dll'),
    path.join(__dirname, '..', 'vendor', 'softcam', 'softcam.dll'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

let win;
const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };

// ───────── discovery: Bonjour (Wi-Fi) + usbmux (USB) ─────────
const devices = new Map(); // id → { id, name, via: 'wifi'|'usb', host?, usbId? }
const pushDevices = () => send('devices', [...devices.values()]);

const bonjour = new Bonjour();
const browser = bonjour.find({ type: 'aircam', protocol: 'tcp' });
browser.on('up', svc => {
  const host = (svc.addresses || []).find(a => net.isIPv4(a)) || svc.referer?.address;
  if (!host) return;
  devices.set('wifi:' + svc.name, { id: 'wifi:' + svc.name, name: svc.name, via: 'wifi', host });
  pushDevices(); autoConnect();
});
browser.on('down', svc => { devices.delete('wifi:' + svc.name); pushDevices(); });

async function pollUsb() {
  const list = await usbmux.listDevices();
  const ids = new Set(list.map(d => 'usb:' + d.serial));
  let changed = false;
  for (const id of devices.keys()) if (id.startsWith('usb:') && !ids.has(id)) { devices.delete(id); changed = true; }
  for (const d of list) {
    const id = 'usb:' + d.serial;
    if (!devices.has(id)) { devices.set(id, { id, name: 'iPhone (USB)', via: 'usb', usbId: d.id }); changed = true; }
    else devices.get(id).usbId = d.id; // DeviceID changes on replug
  }
  if (changed) pushDevices();
  autoConnect();
}
setInterval(pollUsb, 2000);

// ───────── connection to the phone ─────────
let conn = null;      // { sock, dev }
let connecting = false;
let auto = true;      // false after a manual disconnect, until the user picks a device
let lastName = null;  // name reported by the phone, to prefer it next time

function setState(state, extra = {}) { send('state', { state, ...extra }); }

async function connect(dev) {
  if (connecting) return;
  connecting = true;
  disconnect(false);
  try {
    const sock = dev.via === 'usb' ? await usbmux.connect(dev.usbId, PORT) : await new Promise((resolve, reject) => {
      const s = net.connect({ port: PORT, host: dev.host, timeout: 4000 }, () => { s.setTimeout(0); resolve(s); });
      s.once('error', reject);
      s.once('timeout', () => { s.destroy(); reject(new Error('timeout')); });
    });
    sock.setNoDelay(true);
    conn = { sock, dev };
    const parser = new Parser((type, payload) => {
      if (type === MSG.VIDEO) send('video', payload);
      else if (type === MSG.STATUS) {
        try { const st = JSON.parse(payload); lastName = st.name; send('status', st); } catch {}
      }
    });
    sock.on('data', d => { try { parser.push(d); } catch { sock.destroy(); } });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (conn?.sock !== sock) return;
      conn = null;
      setState('disconnected');
      setTimeout(autoConnect, 1000);
    });
    setState('connected', { device: dev });
  } catch {
    setState('disconnected'); // app not open on the phone yet: autoConnect retries on the next poll
  } finally {
    connecting = false;
  }
}

function disconnect(manual = true) {
  if (manual) auto = false;
  if (conn) { const s = conn.sock; conn = null; s.destroy(); setState('disconnected'); }
}

// USB first (more stable, lower latency), then the phone we used last, then any phone.
function autoConnect() {
  if (!auto || connecting) return;
  const all = [...devices.values()];
  const usb = all.find(d => d.via === 'usb');
  if (conn) { if (usb && conn.dev.via === 'wifi') connect(usb); return; }
  const pick = usb || all.find(d => d.name === lastName) || all[0];
  if (pick) connect(pick);
}

// ───────── virtual camera registration (regsvr32, needs admin once) ─────────
function vcamRegistered() {
  return new Promise(resolve => {
    execFile('reg', ['query', `HKCR\\CLSID\\${CLSID}\\InprocServer32`, '/ve'], (err, out) => {
      const dll = dllPath();
      resolve(!err && !!dll && out.toLowerCase().includes(dll.toLowerCase()));
    });
  });
}
function vcamRegister(on) {
  const dll = dllPath();
  if (!dll) return Promise.resolve(false);
  const q = s => `'${s.replace(/'/g, "''")}'`; // PowerShell single-quoted literal
  const args = [...(on ? [] : ['/u']), '/s', `"${dll}"`].map(q).join(',');
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-Command',
    `Start-Process regsvr32.exe -ArgumentList ${args} -Verb RunAs -Wait`], () => vcamRegistered().then(resolve)));
}

// ───────── window ─────────
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    backgroundColor: '#07070a',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 38 },
    title: 'AirCam',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // sandbox off: the preload loads the virtual camera DLL (koffi). backgroundThrottling off: keep feeding
    // the virtual camera while the window is minimized.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => { pushDevices(); setState(conn ? 'connected' : 'disconnected', conn ? { device: conn.dev } : {}); });
}

// ───────── LUT library: .cube files copied into <userData>/luts ─────────
const lutDir = () => { const d = path.join(app.getPath('userData'), 'luts'); fs.mkdirSync(d, { recursive: true }); return d; };
const lutFile = name => { // only plain .cube file names inside lutDir
  const f = path.basename(String(name));
  if (!/\.cube$/i.test(f)) throw new Error('not a .cube');
  return path.join(lutDir(), f);
};
ipcMain.handle('lut-list', () => fs.readdirSync(lutDir()).filter(f => /\.cube$/i.test(f)).sort((a, b) => a.localeCompare(b)));
ipcMain.handle('lut-read', (_e, name) => fs.readFileSync(lutFile(name), 'utf8'));
ipcMain.handle('lut-delete', (_e, name) => fs.rmSync(lutFile(name), { force: true }));
ipcMain.handle('lut-import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Importer des LUT', filters: [{ name: 'LUT 3D (.cube)', extensions: ['cube'] }], properties: ['openFile', 'multiSelections'] });
  const added = [];
  for (const src of r.canceled ? [] : r.filePaths) {
    if (fs.statSync(src).size > 50 << 20) continue; // 50 MB: far above any real .cube
    let name = path.basename(src), i = 2;
    while (fs.existsSync(path.join(lutDir(), name))) name = path.basename(src).replace(/(\.cube)$/i, ` (${i++})$1`);
    fs.copyFileSync(src, path.join(lutDir(), name));
    added.push(name);
  }
  return added;
});

ipcMain.handle('dll-path', () => dllPath());
ipcMain.handle('vcam-registered', () => vcamRegistered());
ipcMain.handle('vcam-register', (_e, on) => vcamRegister(!!on));
ipcMain.on('connect', (_e, id) => { const d = devices.get(id); if (d) { auto = true; connect(d); } });
ipcMain.on('connect-ip', (_e, host) => {
  if (!net.isIP(String(host))) return;
  auto = true;
  const d = { id: 'ip:' + host, name: host, via: 'wifi', host };
  devices.set(d.id, d); pushDevices(); connect(d);
});
ipcMain.on('disconnect', () => disconnect(true));
ipcMain.on('control', (_e, settings) => { if (conn) conn.sock.write(encode(MSG.CONTROL, Buffer.from(JSON.stringify(settings)))); });
ipcMain.on('keyframe', () => { if (conn) conn.sock.write(encode(MSG.KEYFRAME)); });
ipcMain.on('background', (_e, bytes) => {
  if (conn && bytes?.length && bytes.length < 16 << 20) conn.sock.write(encode(MSG.BACKGROUND, Buffer.from(bytes)));
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { createWindow(); pollUsb(); });
app.on('window-all-closed', () => { bonjour.destroy(); app.quit(); });
