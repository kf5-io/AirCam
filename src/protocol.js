// Wire protocol shared with the iPhone app (ios/AirCam/Protocol.swift): [u8 type][u32 BE length][payload].
const MSG = { VIDEO: 0x01, STATUS: 0x02, CONTROL: 0x10, BACKGROUND: 0x11, KEYFRAME: 0x12 };
const PORT = 47800;
const MAX = 16 << 20;

function encode(type, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(5);
  h[0] = type;
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

// Incremental parser: push() TCP chunks, onMessage(type, payload) fires per complete message.
class Parser {
  constructor(onMessage) { this.onMessage = onMessage; this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (len > MAX) throw new Error('message too large');
      if (this.buf.length < 5 + len) break;
      const type = this.buf[0];
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      this.onMessage(type, payload);
    }
  }
}

module.exports = { MSG, PORT, encode, Parser };
