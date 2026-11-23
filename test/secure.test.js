const test = require('node:test');
const assert = require('node:assert');
const { keyPair, session, RecordReader } = require('../src/secure');

test('both sides derive matching keys; records round-trip in order', () => {
  const pc = keyPair(), phone = keyPair();
  const a = session(pc.privateKey, phone.hello, 'pc'), b = session(phone.privateKey, pc.hello, 'phone');
  const got = [];
  const r = new RecordReader(body => got.push(b.open(body).toString()));
  const wire = Buffer.concat(['un', 'deux', 'trois'].map(s => a.seal(Buffer.from(s))));
  for (let i = 0; i < wire.length; i += 5) r.push(wire.subarray(i, i + 5));
  assert.deepStrictEqual(got, ['un', 'deux', 'trois']);
  assert.strictEqual(a.open(b.seal(Buffer.from('retour')).subarray(4)).toString(), 'retour');
});

test('tampered or replayed records are rejected', () => {
  const pc = keyPair(), phone = keyPair();
  const a = session(pc.privateKey, phone.hello, 'pc'), b = session(phone.privateKey, pc.hello, 'phone');
  const rec = a.seal(Buffer.from('secret')).subarray(4);
  const bad = Buffer.from(rec); bad[0] ^= 1;
  assert.throws(() => b.open(bad));
  const ok = a.seal(Buffer.from('x')).subarray(4); // counter 1, but b still expects 0
  assert.throws(() => b.open(ok));
});

// Fixed vector, also checked by ios/Tests/SecureVector.swift on the macOS CI (CryptoKit interop).
test('known-answer vector (phone key 0x01…, PC key 0x02…)', () => {
  const phone = keyPair(Buffer.alloc(32, 1)), pc = keyPair(Buffer.alloc(32, 2));
  const s = session(phone.privateKey, pc.hello, 'phone');
  const rec = s.seal(Buffer.from('AirCam')).toString('hex');
  assert.strictEqual(pc.hello.subarray(4).toString('hex'), 'ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59');
  assert.strictEqual(rec, '000000166140687ce057365a382c462beb578fe021ce19e83ef3');
});
