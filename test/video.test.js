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

const { parseCube, sampleLut, makeLut, appleLogToLinear, linearToAppleLog, appleLogToRec709, LOOKS } = require('../src/renderer/video');

test('parses a .cube and samples it trilinearly', () => {
  const cube = 'TITLE "id"\n# comment\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
  const lut = parseCube(cube);
  assert.strictEqual(lut.size, 2);
  sampleLut(lut, .25, .5, .75).forEach((v, i) => assert.ok(Math.abs(v - [.25, .5, .75][i]) < 1e-6));
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'));
  assert.throws(() => parseCube('LUT_1D_SIZE 4\n'));
});

test('generated LUT matches its function', () => {
  const lut = makeLut(17, (r, g, b) => [1 - r, g, b]);
  assert.ok(Math.abs(sampleLut(lut, .2, .4, .6)[0] - .8) < 1e-6);
  for (const [, fn] of Object.values(LOOKS)) makeLut(9, fn); // presets stay in range (clamped)
});

test('Apple Log: curve round-trips and mid gray lands mid-screen', () => {
  for (const x of [0, .01, .18, .9, 4]) assert.ok(Math.abs(appleLogToLinear(linearToAppleLog(x)) - x) < 1e-6, String(x));
  const p = linearToAppleLog(.18);
  assert.ok(Math.abs(p - .488) < .005, `18% gray encodes to ${p}`);
  const [r] = appleLogToRec709(p, p, p);
  assert.ok(r > .4 && r < .6, `mid gray displays at ${r}`);
});
