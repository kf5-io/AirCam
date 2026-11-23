// Minimal usbmux client: talks to Apple's "Apple Mobile Device" service (iTunes / Apple Devices app)
// on 127.0.0.1:27015 to list USB iPhones and open a TCP tunnel to a port on the phone.
const net = require('net');
const plist = require('plist');

let tag = 0;
function request(sock, obj) {
  const body = Buffer.from(plist.build({ ...obj, ProgName: 'AirCam', ClientVersionString: 'AirCam' }));
  const h = Buffer.alloc(16);
  h.writeUInt32LE(16 + body.length, 0);
  h.writeUInt32LE(1, 4); // protocol version 1 = plist
  h.writeUInt32LE(8, 8); // message type 8 = plist
  h.writeUInt32LE(++tag, 12);
  sock.write(Buffer.concat([h, body]));
}

// Reads one plist reply; any bytes after it (tunnel data) are pushed back into the socket.
function reply(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (err, val) => { sock.off('data', onData); sock.off('error', done); sock.off('close', onClose); err ? reject(err) : resolve(val); };
    const onClose = () => done(new Error('usbmux closed'));
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < buf.readUInt32LE(0)) return;
      const len = buf.readUInt32LE(0);
      sock.pause();
      if (buf.length > len) sock.unshift(buf.subarray(len));
      try { done(null, plist.parse(buf.subarray(16, len).toString('utf8'))); } catch (e) { done(e); }
    };
    sock.on('data', onData); sock.once('error', done); sock.once('close', onClose);
  });
}

function open() {
  return new Promise((resolve, reject) => {
    const s = net.connect(27015, '127.0.0.1', () => { s.off('error', reject); resolve(s); });
    s.once('error', reject);
  });
}

/** USB-connected devices: [{ id, serial }]. Empty when the Apple service isn't installed/running. */
async function listDevices() {
  let s;
  try {
    s = await open();
    request(s, { MessageType: 'ListDevices' });
    const r = await reply(s);
    return (r.DeviceList || []).filter(d => d.Properties?.ConnectionType === 'USB')
      .map(d => ({ id: d.DeviceID, serial: d.Properties.SerialNumber }));
  } catch { return []; } finally { s?.destroy(); }
}

/** Opens a raw TCP tunnel to `port` on the device. Rejects if nothing listens there (app closed). */
async function connect(id, port) {
  const s = await open();
  request(s, { MessageType: 'Connect', DeviceID: id, PortNumber: ((port & 0xff) << 8) | (port >> 8) }); // port in network byte order
  const r = await reply(s).catch(e => { s.destroy(); throw e; });
  if (r.Number !== 0) { s.destroy(); throw new Error(`usbmux connect refused (${r.Number})`); }
  s.resume();
  return s;
}

module.exports = { listDevices, connect };
