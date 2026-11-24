'use strict';
/* Virtual camera readback (WebGL2): packs the output canvas into softcam's 24-bit BGR (top-down) on the GPU and reads it
   back asynchronously (pixel buffer + fence). The main thread never waits for the GPU and never converts pixels: the
   synchronous getImageData + JS conversion cost ~20 ms per 1080p frame while the GPU was decoding 4K60, capping the
   whole pipeline below 60 i/s. */
const BgrReadback = (() => {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false });
  if (!gl) return null;

  const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0., 1.); }`;
  // Output texel (x, y) holds bytes 4x..4x+3 of BGR row y; byte k is channel k%3 (B, G, R) of pixel k/3.
  // Texture row 0 is the canvas' top row and readPixels starts at framebuffer row 0: memory comes out top-down.
  const FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D src; out vec4 o;
float byteAt(int k, int y) {
  int p = k / 3, c = k - p * 3;
  vec4 px = texelFetch(src, ivec2(p, y), 0);
  return c == 0 ? px.b : c == 1 ? px.g : px.r;
}
void main() {
  int k = int(gl_FragCoord.x) * 4, y = int(gl_FragCoord.y);
  o = vec4(byteAt(k, y), byteAt(k + 1, y), byteAt(k + 2, y), byteAt(k + 3, y));
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

  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); // exact bytes, no color management
  const rb = gl.createRenderbuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, gl.createBuffer());

  let W = 0, H = 0, out = null, busy = false;
  return {
    /** Starts reading `canvas` back; done(bgr, w, h) runs once the GPU is done (bgr is reused: consume it right away).
     *  While a readback is in flight the frame is skipped. false: not possible here (lost context, width not ÷ 4). */
    read(canvas, done) {
      const w = canvas.width, h = canvas.height;
      if (w % 4 || gl.isContextLost()) return false;
      if (busy) return true;
      if (w !== W || h !== H) {
        W = w; H = h;
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w * 3 / 4, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
        // Not STREAM_READ: Chrome's shadow copy for READ buffers never kicked in here and warned on every frame.
        gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 3, gl.STREAM_COPY);
        gl.viewport(0, 0, w * 3 / 4, h);
        out = new Uint8Array(w * h * 3);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, w * 3 / 4, h, gl.RGBA, gl.UNSIGNED_BYTE, 0); // into the pixel buffer: doesn't wait
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      busy = true;
      let tries = 0;
      const poll = () => {
        const st = gl.clientWaitSync(sync, 0, 0);
        if (st === gl.TIMEOUT_EXPIRED && ++tries < 100) { setTimeout(poll, 1); return; } // fences only update between tasks
        gl.deleteSync(sync);
        busy = false;
        if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) { gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out); done(out, w, h); }
      };
      setTimeout(poll, 0);
      return true;
    },
  };
})();
