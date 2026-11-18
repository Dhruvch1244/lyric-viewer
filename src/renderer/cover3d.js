'use strict';

/*
  Cover 3D — the depth map behind shaders/cover3d.fs.

  The shader flies a camera over the cover art as a lit relief; this decides
  how far each point of the picture stands out. It is a HEURISTIC, not a
  depth-estimation model: covers are mostly a subject in front of a ground,
  and the subject is usually the brighter, more saturated thing near the
  middle. So depth here is
      a broad shape   0.45 brightness + 0.30 saturation + 0.35 centre bias,
                      blurred hard so the relief is smooth hills, not noise
    + a fine texture  lightly blurred brightness, so faces, letters and
                      edges get their own small relief on top of the hills
  stretched to the full 0..1 range per cover. It runs once per cover, on a
  128x128 copy (~16k pixels, a few milliseconds), never per frame. A real
  monocular-depth model (MiDaS-class, via the inference sidecar) would beat
  it on photos; this needs no download and works on drawn covers too.

  Pure functions plus one DOM helper; the pure part is unit-tested.

  Exposed on window.Cover3D: { buildDepth, boxBlur, prepare, SIZE }.
*/

(function () {
  const SIZE = 128;

  /** In-place separable box blur of a w×h float field, `passes` times. */
  function boxBlur(f, w, h, radius, passes) {
    const tmp = new Float32Array(f.length);
    for (let pass = 0; pass < passes; pass += 1) {
      for (let y = 0; y < h; y += 1) {           // horizontal into tmp
        let acc = 0;
        for (let x = -radius; x <= radius; x += 1) acc += f[y * w + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x += 1) {
          tmp[y * w + x] = acc / (2 * radius + 1);
          const add = Math.min(w - 1, x + radius + 1);
          const sub = Math.max(0, x - radius);
          acc += f[y * w + add] - f[y * w + sub];
        }
      }
      for (let x = 0; x < w; x += 1) {           // vertical back into f
        let acc = 0;
        for (let y = -radius; y <= radius; y += 1) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y += 1) {
          f[y * w + x] = acc / (2 * radius + 1);
          const add = Math.min(h - 1, y + radius + 1);
          const sub = Math.max(0, y - radius);
          acc += tmp[add * w + x] - tmp[sub * w + x];
        }
      }
    }
    return f;
  }

  /**
   * Depth 0..255 for an RGBA image (row-major, w×h). 255 = nearest.
   * @param {Uint8ClampedArray|Uint8Array} rgba
   * @returns {Uint8ClampedArray} one byte per pixel
   */
  function buildDepth(rgba, w, h) {
    const n = w * h;
    const broad = new Float32Array(n);
    const fine = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const x = (i % w) / (w - 1) - 0.5, y = Math.floor(i / w) / (h - 1) - 0.5;
      const centre = Math.max(0, 1 - Math.sqrt(x * x + y * y) * 1.6);
      broad[i] = 0.45 * lum + 0.3 * sat + 0.35 * centre;
      fine[i] = lum;
    }
    boxBlur(broad, w, h, Math.max(2, Math.round(w / 20)), 3);
    boxBlur(fine, w, h, 1, 1);
    let lo = Infinity, hi = -Infinity;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      d[i] = broad[i] * 0.8 + fine[i] * 0.2;
      if (d[i] < lo) lo = d[i];
      if (d[i] > hi) hi = d[i];
    }
    const out = new Uint8ClampedArray(n);
    const span = hi - lo > 1e-6 ? hi - lo : 1;
    for (let i = 0; i < n; i += 1) out[i] = Math.round(((d[i] - lo) / span) * 255);
    return out;
  }

  /** A stand-in cover for a song without art: rings in the accent hue. */
  function placeholder(hue) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 8, 128, 128, 180);
    grad.addColorStop(0, `hsl(${hue} 90% 70%)`);
    grad.addColorStop(0.5, `hsl(${(hue + 40) % 360} 80% 40%)`);
    grad.addColorStop(1, `hsl(${(hue + 200) % 360} 70% 10%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let r = 20; r < 180; r += 22) { g.lineWidth = 3; g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.stroke(); }
    return c;
  }

  /**
   * The two shader pictures for a cover (or a placeholder when there is none).
   * @param {CanvasImageSource|null} image
   * @param {number} hue 0..360, for the placeholder
   * @returns {{cover: HTMLCanvasElement, depth: HTMLCanvasElement}}
   */
  function prepare(image, hue = 260) {
    const src = image || placeholder(hue);
    // The cover itself at 512 for sharpness; the depth at SIZE then scaled up
    // by the GPU's bilinear filter, which smooths it further for free.
    const cover = document.createElement('canvas');
    cover.width = cover.height = 512;
    cover.getContext('2d').drawImage(src, 0, 0, 512, 512);

    const small = document.createElement('canvas');
    small.width = small.height = SIZE;
    const sg = small.getContext('2d', { willReadFrequently: true });
    sg.drawImage(src, 0, 0, SIZE, SIZE);
    const px = sg.getImageData(0, 0, SIZE, SIZE);
    const depth = buildDepth(px.data, SIZE, SIZE);
    for (let i = 0; i < depth.length; i += 1) {
      px.data[i * 4] = px.data[i * 4 + 1] = px.data[i * 4 + 2] = depth[i];
      px.data[i * 4 + 3] = 255;
    }
    sg.putImageData(px, 0, 0);
    return { cover, depth: small };
  }

  window.Cover3D = { buildDepth, boxBlur, prepare, SIZE };
})();
