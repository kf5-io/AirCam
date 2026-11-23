const test = require('node:test');
const assert = require('node:assert');
const { MSG, encode, Parser } = require('../src/protocol');

test('parser reassembles messages split across chunks', () => {
  const got = [];
  const p = new Parser((t, b) => got.push([t, b.toString()]));
  const wire = Buffer.concat([encode(MSG.STATUS, Buffer.from('{"a":1}')), encode(MSG.VIDEO, Buffer.from('xyz')), encode(MSG.KEYFRAME)]);
  for (let i = 0; i < wire.length; i += 3) p.push(wire.subarray(i, i + 3));
  assert.deepStrictEqual(got, [[MSG.STATUS, '{"a":1}'], [MSG.VIDEO, 'xyz'], [MSG.KEYFRAME, '']]);
});

test('parser rejects oversized length', () => {
  const p = new Parser(() => {});
  assert.throws(() => p.push(Buffer.from([1, 0xff, 0xff, 0xff, 0xff])));
});
