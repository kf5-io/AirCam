const test = require('node:test');
const assert = require('node:assert');
const { sps, codecOf, rgbaToBgr } = require('../src/renderer/video');

test('codec string from the SPS of an Annex B keyframe', () => {
  const au = Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 0, 1, 0x65, 0x88]);
  assert.deepStrictEqual([...sps(au)], [0x67, 0x64, 0x00, 0x28, 0xac]);
  assert.strictEqual(codecOf(sps(au)), 'avc1.640028');
  assert.strictEqual(sps(Uint8Array.from([0, 0, 0, 1, 0x41, 1])), null);
});

test('HEVC: SPS found by its 6-bit NAL type, fixed codec string', () => {
  // VPS (32), SPS (33), PPS (34), IDR (19)
  const au = Uint8Array.from([0, 0, 0, 1, 0x40, 1, 0xaa, 0, 0, 0, 1, 0x42, 1, 0xbb, 0, 0, 0, 1, 0x44, 1, 0xcc, 0, 0, 0, 1, 0x26, 1, 0xdd]);
  assert.deepStrictEqual([...sps(au, true)], [0x42, 1, 0xbb]);
  assert.strictEqual(sps(au), null);
  assert.match(codecOf(sps(au, true), true), /^hvc1\./);
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

const { coverCrop, framingTarget, easeCrop } = require('../src/renderer/video');

test('framing: cover crop, face kept inside, zoom limited', () => {
  const full = coverCrop(16 / 9, 9 / 16); // vertical output from a landscape frame
  assert.ok(Math.abs(full.w - (9 / 16) / (16 / 9)) < 1e-9 && full.h === 1);
  const land = coverCrop(16 / 9, 16 / 9);
  assert.deepStrictEqual(land, { x: 0, y: 0, w: 1, h: 1 });
  const face = [.7, .3, .1, .15];
  const t = framingTarget([face], land);
  assert.ok(t.x <= face[0] && t.x + t.w >= face[0] + face[2] && t.y <= face[1] && t.y + t.h >= face[1] + face[3], 'face inside');
  assert.ok(t.h >= 1 / 2.5 - 1e-9, 'zoom ≤ 2.5×');
  assert.ok(Math.abs(t.w / t.h - 1) < 1e-9, 'keeps output aspect (normalized)');
  assert.deepStrictEqual(framingTarget([], land), land);
  const side = [.85, .3, .1, .15], v = framingTarget([side], full); // vertical crop follows a face near the edge
  assert.ok(v.x <= side[0] && v.x + v.w >= side[0] + side[2], 'edge face inside vertical crop');
  const step = easeCrop(land, t, 1 / 30);
  assert.ok(step.w < 1 && step.w > t.w, 'moves part of the way');
});
