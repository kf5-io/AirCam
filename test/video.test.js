const test = require('node:test');
const assert = require('node:assert');
const { sps, codecOf, rgbaToBgr } = require('../src/renderer/video');

test('codec string from the SPS of an Annex B keyframe', () => {
  const au = Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 0, 1, 0x65, 0x88]);
  assert.deepStrictEqual([...sps(au)], [0x67, 0x64, 0x00, 0x28, 0xac]);
  assert.strictEqual(codecOf(sps(au)), 'avc1.640028');
  assert.strictEqual(sps(Uint8Array.from([0, 0, 0, 1, 0x41, 1])), null);
});

test('RGBA to BGR', () => {
  const out = rgbaToBgr(Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]), new Uint8Array(6));
  assert.deepStrictEqual([...out], [3, 2, 1, 6, 5, 4]);
});
