'use strict';
/* GPU color pipeline (WebGL2): sharpen → 3D LUT (with intensity) → adjustments. Renders a VideoFrame at its native size. */
const Grade = (() => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false });
  if (!gl) return null;

  const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;
  const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D src; uniform sampler3D lut;
uniform float lutMix, lutSize, bri, hue, sat, vib, con, gam, sharp;
uniform vec2 px;
float luma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
void main() {
  vec3 c = texture(src, uv).rgb;
  if (sharp != 0.) {
    vec3 b = (texture(src, uv + vec2(px.x, 0.)).rgb + texture(src, uv - vec2(px.x, 0.)).rgb
            + texture(src, uv + vec2(0., px.y)).rgb + texture(src, uv - vec2(0., px.y)).rgb) * .25;
    c = clamp(c + (c - b) * sharp, 0., 1.);
  }
  if (lutMix > 0.) c = mix(c, texture(lut, c * ((lutSize - 1.) / lutSize) + .5 / lutSize).rgb, lutMix);
  c = clamp((c + bri - .5) * con + .5, 0., 1.);
  c = pow(c, vec3(gam));
  if (hue != 0.) { const vec3 k = vec3(.57735); float ca = cos(hue), sa = sin(hue); c = c * ca + cross(k, c) * sa + k * dot(k, c) * (1. - ca); }
  float l = luma(c);
  c = mix(vec3(l), c, sat);
  if (vib != 0.) { float s = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); c = mix(vec3(l), c, 1. + vib * (1. - s)); }
  o = vec4(clamp(c, 0., 1.), 1.);
}`;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  for (const n of ['src', 'lut', 'lutMix', 'lutSize', 'bri', 'hue', 'sat', 'vib', 'con', 'gam', 'sharp', 'px']) U[n] = gl.getUniformLocation(prog, n);
  gl.uniform1i(U.src, 0);
  gl.uniform1i(U.lut, 1);

  const tex = (target, unit) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, t);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(target, p, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  tex(gl.TEXTURE_2D, 0);
  tex(gl.TEXTURE_3D, 1);
  let lutSize = 0;

  return {
    canvas,
    /** lut: { size, data } or null */
    setLut(lut) {
      lutSize = lut ? lut.size : 0;
      if (!lut) return;
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
    },
    /** p: { lutMix, bri, hue, sat, vib, con, gam, sharp } in shader units */
    render(frame, p) {
      const w = frame.displayWidth, h = frame.displayHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.uniform1f(U.lutMix, lutSize ? p.lutMix : 0);
      gl.uniform1f(U.lutSize, lutSize || 1);
      for (const k of ['bri', 'hue', 'sat', 'vib', 'con', 'gam', 'sharp']) gl.uniform1f(U[k], p[k]);
      gl.uniform2f(U.px, 1 / w, 1 / h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    },
  };
})();
