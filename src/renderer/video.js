'use strict';
/* Pure helpers for the video pipeline (loaded by index.html, unit-tested by test/video.test.js). */

// First NAL unit of `type` in an Annex B buffer, without its start code (or null).
function nal(u8, type) {
  for (let i = 0; i + 3 < u8.length; i++) {
    if (u8[i] !== 0 || u8[i + 1] !== 0 || u8[i + 2] !== 1 || (u8[i + 3] & 0x1f) !== type) continue;
    let end = i + 3;
    while (end + 2 < u8.length && !(u8[end] === 0 && u8[end + 1] === 0 && (u8[end + 2] === 1 || u8[end + 2] === 0))) end++;
    return u8.subarray(i + 3, end + 2 < u8.length ? end : u8.length);
  }
  return null;
}
const sps = u8 => nal(u8, 7);
// WebCodecs codec string from the SPS: avc1.PPCCLL (profile, constraint flags, level).
function codecOf(spsNal) {
  const hx = b => b.toString(16).padStart(2, '0');
  return spsNal && spsNal.length >= 4 ? `avc1.${hx(spsNal[1])}${hx(spsNal[2])}${hx(spsNal[3])}` : null;
}
// Canvas RGBA → softcam BGR (24-bit), into a preallocated buffer.
function rgbaToBgr(src, dst) {
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) { dst[j] = src[i + 2]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i]; }
  return dst;
}

if (typeof module !== 'undefined') module.exports = { nal, sps, codecOf, rgbaToBgr };
