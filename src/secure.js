// Encrypted transport shared with the iPhone app (ios/AirCam/Secure.swift).
// Handshake: each side sends "ACv1" + its ephemeral X25519 public key (32 bytes).
// Keys: HKDF-SHA256(shared secret, salt "AirCam v1", info "keys", 64 bytes) → [phone→PC key | PC→phone key].
// Records: [u32 BE length][AES-256-GCM ciphertext + 16-byte tag]; nonce = 4 zero bytes + u64 BE counter per direction.
// (AES-GCM rather than ChaCha20: Electron's BoringSSL has no chacha20-poly1305 cipher.)
// No authentication by design (no PIN): protects against eavesdropping, not against an active man-in-the-middle.
const crypto = require('crypto');

const MAGIC = Buffer.from('ACv1');
const HELLO_LEN = 36;
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');   // DER prefix of an X25519 public key
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex'); // DER prefix of an X25519 private key
const MAX_RECORD = 17 << 20;

/** Ephemeral key pair; `raw` (32 bytes) lets tests use fixed keys. */
function keyPair(raw) {
  const privateKey = raw ? crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' })
    : crypto.generateKeyPairSync('x25519').privateKey;
  const pub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, hello: Buffer.concat([MAGIC, pub]) };
}

/** Keys from our private key and the peer's hello. role: 'pc' | 'phone'. */
function session(privateKey, peerHello, role) {
  if (peerHello.length !== HELLO_LEN || !peerHello.subarray(0, 4).equals(MAGIC)) throw new Error('bad handshake');
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([SPKI, peerHello.subarray(4)]), format: 'der', type: 'spki' });
  const secret = crypto.diffieHellman({ privateKey, publicKey });
  const keys = Buffer.from(crypto.hkdfSync('sha256', secret, 'AirCam v1', 'keys', 64));
  const p2c = keys.subarray(0, 32), c2p = keys.subarray(32);
  const tx = { key: role === 'pc' ? c2p : p2c, n: 0n }, rx = { key: role === 'pc' ? p2c : c2p, n: 0n };
  const nonce = dir => { const b = Buffer.alloc(12); b.writeBigUInt64BE(dir.n, 4); return b; };
  return {
    /** plaintext → record bytes ready to write */
    seal(plain) {
      const c = crypto.createCipheriv('aes-256-gcm', tx.key, nonce(tx), { authTagLength: 16 });
      const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
      tx.n++;
      const h = Buffer.alloc(4); h.writeUInt32BE(body.length);
      return Buffer.concat([h, body]);
    },
    /** one record body (without its length) → plaintext; throws if tampered or out of order */
    open(body) {
      if (body.length < 16) throw new Error('short record');
      const d = crypto.createDecipheriv('aes-256-gcm', rx.key, nonce(rx), { authTagLength: 16 });
      d.setAuthTag(body.subarray(-16));
      const plain = Buffer.concat([d.update(body.subarray(0, -16)), d.final()]); // final() throws if tampered
      rx.n++;
      return plain;
    },
  };
}

/** Splits a TCP byte stream into record bodies. */
class RecordReader {
  constructor(onRecord) { this.onRecord = onRecord; this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_RECORD) throw new Error('record too large');
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.onRecord(body);
    }
  }
}

module.exports = { HELLO_LEN, keyPair, session, RecordReader };
