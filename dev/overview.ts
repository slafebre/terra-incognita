// Dev tool: renders a large area at low resolution to judge terrain across regions.
// Query: ?size=20000&px=900&x=..&y=..
import { SeedStore, SeedView } from '../src/gen/seeds';
import { Terrain, regionKind } from '../src/gen/terrain';

const q = new URLSearchParams(location.search);
const size = Number(q.get('size') ?? 20000);
const px = Number(q.get('px') ?? 900);
const ox = Number(q.get('x') ?? Math.round((Math.random() - 0.5) * 2e6));
const oy = Number(q.get('y') ?? Math.round((Math.random() - 0.5) * 2e6));
const m = size / px;

const store = new SeedStore();
const t = new Terrain(new SeedView(store.payloadFor({ x0: ox, y0: oy, x1: ox + size, y1: oy + size })));
const t0 = performance.now();
const h = new Float32Array(px * px);
const reg = new Float32Array(px * px);
for (let j = 0; j < px; j++)
  for (let i = 0; i < px; i++) {
    h[j * px + i] = t.elevation(ox + i * m, oy + j * m);
    reg[j * px + i] = t.region(ox + i * m, oy + j * m);
  }
const ms = performance.now() - t0;

const c = document.getElementById('c') as HTMLCanvasElement;
c.width = c.height = px;
const ctx = c.getContext('2d')!;
const img = ctx.createImageData(px, px);
const tint: Record<string, number[]> = {
  lowland: [235, 245, 220], hills: [245, 240, 215], lowmountain: [240, 225, 205], alpine: [230, 230, 240],
};
let lo = Infinity, hi = -Infinity;
for (let j = 1; j < px - 1; j++)
  for (let i = 1; i < px - 1; i++) {
    const k = j * px + i;
    lo = Math.min(lo, h[k]); hi = Math.max(hi, h[k]);
    const gx = (h[k + 1] - h[k - 1]) / (2 * m);
    const gy = (h[k + px] - h[k - px]) / (2 * m);
    const dot = (gx * 0.5 + gy * 0.5 + 0.707) / Math.sqrt(gx * gx + gy * gy + 1);
    const s = Math.max(0.25, Math.min(1.15, dot / 0.707));
    const tc = tint[regionKind(reg[k])];
    const contour = Math.floor(h[k] / 50) !== Math.floor(h[k + 1] / 50) || Math.floor(h[k] / 50) !== Math.floor(h[k + px] / 50);
    const glacier = h[k] > 2800;
    for (let ch = 0; ch < 3; ch++) {
      let v = (glacier ? [250, 252, 255][ch] : tc[ch]) * s;
      if (contour) v = v * 0.55 + [160, 90, 40][ch] * 0.45;
      img.data[k * 4 + ch] = v;
    }
    img.data[k * 4 + 3] = 255;
  }
ctx.putImageData(img, 0, 0);
document.getElementById('info')!.textContent =
  `${size / 1000} km, ${m.toFixed(1)} m/px, at ${ox},${oy} — elev ${lo.toFixed(0)}–${hi.toFixed(0)} m — ${ms.toFixed(0)} ms. 50 m contours; tint = region.`;
