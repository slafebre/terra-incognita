// Dev tool: motorways over a large area of the coarse surface, to judge their density and line.
// Query: ?size=48000&x=..&y=..&seed=n&raw=1&R=0.2 (raw: also the line where the gate is closed; R: region forced)
import { COARSE, CoarseField } from '../src/gen/hydro';
import { lakesOf } from '../src/gen/lakes';
import { MW_CELL, MW_GRADE, MW_RMIN, Motorways, tightestRadius } from '../src/gen/motorway';
import { NET_REACH } from '../src/gen/roads';
import { expand, SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements, TOWN, VILLAGE } from '../src/gen/settle';
import { regionKind, setRegionOverride, Terrain } from '../src/gen/terrain';

const q = new URLSearchParams(location.search);
const size = Number(q.get('size') ?? 128000);
const seed = q.has('seed') ? Number(q.get('seed')) : undefined;
const ox = Number(q.get('x') ?? Math.round((Math.random() - 0.5) * 2e6));
const oy = Number(q.get('y') ?? Math.round((Math.random() - 0.5) * 2e6));
const showRaw = q.has('raw');
if (q.has('R')) setRegionOverride(Number(q.get('R')));
/** Canvas pixels and metres per pixel. */
const px = 2000;
const m = size / px;

const info = document.getElementById('info')!;
const polyLen = (xy: ArrayLike<number>) => {
  let L = 0;
  for (let k = 2; k < xy.length; k += 2) L += Math.hypot(xy[k] - xy[k - 2], xy[k + 1] - xy[k - 1]);
  return L;
};
setTimeout(run, 20);

function run(): void {
  const rect = { x0: ox, y0: oy, x1: ox + size, y1: oy + size };
  const store = new SeedStore(seed);
  const view = new SeedView(store.payloadFor(rect, expand(rect, NET_REACH)));
  const t = new Terrain(view);
  const field = new CoarseField(t, view);
  const set = new Settlements(field, t, view);
  const mw = new Motorways(field, t, set, view);

  const t0 = performance.now();
  // Coarse surface on its own grid.
  const gi0 = Math.floor(ox / COARSE);
  const gj0 = Math.floor(oy / COARSE);
  const gw = Math.ceil(size / COARSE) + 2;
  const z = new Float32Array(gw * gw);
  for (let j = 0; j < gw; j++) for (let i = 0; i < gw; i++) z[j * gw + i] = field.zGrid(gi0 + i, gj0 + j);
  const tTerrain = performance.now() - t0;

  const t1 = performance.now();
  const pieces = mw.piecesIn(ox, oy, ox + size, oy + size);
  const tRoute = performance.now() - t1;

  const c = document.getElementById('c') as HTMLCanvasElement;
  c.width = c.height = px;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(px, px);
  const lakes = lakesOf(field);
  const tint: Record<string, number[]> = {
    lowland: [235, 245, 220], hills: [245, 240, 215], lowmountain: [240, 225, 205], alpine: [230, 230, 240],
  };
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const wx = ox + x * m;
      const wy = oy + y * m;
      const fi = wx / COARSE - gi0;
      const fj = wy / COARSE - gj0;
      const i = Math.min(gw - 2, Math.max(1, Math.round(fi)));
      const j = Math.min(gw - 2, Math.max(1, Math.round(fj)));
      const k = j * gw + i;
      const gx = (z[k + 1] - z[k - 1]) / (2 * COARSE);
      const gy = (z[k + gw] - z[k - gw]) / (2 * COARSE);
      const dot = (gx * 0.5 + gy * 0.5 + 0.707) / Math.sqrt(gx * gx + gy * gy + 1);
      const s = Math.max(0.25, Math.min(1.15, dot / 0.707));
      const tc = tint[regionKind(t.region(wx, wy))];
      const contour = Math.floor(z[k] / 50) !== Math.floor(z[k + 1] / 50) || Math.floor(z[k] / 50) !== Math.floor(z[k + gw] / 50);
      const o = (y * px + x) * 4;
      let col = tc.map((v) => v * s);
      if (contour) col = col.map((v, ch) => v * 0.6 + [160, 90, 40][ch] * 0.4);
      if (field.area(wx, wy) > 25) col = [90, 150, 220];
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  // Lakes, sampled coarsely above: fill the blocks.
  ctx.fillStyle = 'rgb(150, 200, 240)';
  for (let y = 0; y < px; y += 4)
    for (let x = 0; x < px; x += 4) if (lakes.wet(ox + x * m, oy + y * m)) ctx.fillRect(x - 2, y - 2, 4, 4);

  const toPx = (wx: number, wy: number): [number, number] => [(wx - ox) / m, (wy - oy) / m];
  const poly = (xy: ArrayLike<number>) => {
    ctx.beginPath();
    for (let k = 0; k < xy.length; k += 2) {
      const [x, y] = toPx(xy[k], xy[k + 1]);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  };
  // Motorway cell grid.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.lineWidth = 1;
  for (let g = Math.ceil(ox / MW_CELL) * MW_CELL; g < ox + size; g += MW_CELL) {
    const [x] = toPx(g, 0);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, px);
    ctx.stroke();
  }
  for (let g = Math.ceil(oy / MW_CELL) * MW_CELL; g < oy + size; g += MW_CELL) {
    const [, y] = toPx(0, g);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(px, y);
    ctx.stroke();
  }
  // The raw line: dropped stretches, coloured by why.
  const whyCol: Record<string, string> = {
    gate: 'rgba(40, 40, 40, 0.6)', alpine: 'rgb(130, 0, 200)', sharp: 'rgb(230, 120, 0)', loop: 'rgb(0, 150, 0)', saddle: 'rgb(0, 160, 160)', stub: 'rgb(220, 0, 0)',
  };
  const whyKm: Record<string, number> = {};
  for (let cj = Math.floor(oy / MW_CELL); cj <= Math.floor((oy + size) / MW_CELL); cj++)
    for (let ci = Math.floor(ox / MW_CELL); ci <= Math.floor((ox + size) / MW_CELL); ci++)
      for (const r of mw.rawIn(ci, cj)) {
        if (!r.why) continue;
        whyKm[r.why] = (whyKm[r.why] ?? 0) + polyLen(r.base) / 1000;
        if (!showRaw) continue;
        ctx.strokeStyle = whyCol[r.why];
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 8]);
        poly(r.base);
        ctx.stroke();
      }
  ctx.setLineDash([]);
  // Kept pieces: their raw line thin, the routed motorway thick.
  for (const p of pieces) {
    ctx.strokeStyle = 'rgba(80, 40, 120, 0.6)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 8]);
    poly(p.base);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const p of pieces) {
    ctx.strokeStyle = 'rgb(40, 20, 30)';
    ctx.lineWidth = 11;
    poly(p.xy);
    ctx.stroke();
  }
  for (const p of pieces) {
    ctx.strokeStyle = 'rgb(200, 40, 110)';
    ctx.lineWidth = 7;
    poly(p.xy);
    ctx.stroke();
  }
  for (const p of pieces)
    for (const [an, end] of [[p.a, p.endA], [p.b, p.endB]] as const)
      if (end) {
        const [x, y] = toPx(an.x, an.y);
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, 2 * Math.PI);
        ctx.fill();
      }
  // Curves tighter than the minimum: orange rings, listed in the console.
  let tight = 0;
  for (const p of pieces) {
    const r = tightestRadius(p.xy, 200);
    if (r >= MW_RMIN) continue;
    tight++;
    const mi = 2 * Math.floor(p.xy.length / 4);
    const [x, y] = toPx(p.xy[mi], p.xy[mi + 1]);
    ctx.strokeStyle = 'rgb(255, 140, 0)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(x, y, 40, 0, 2 * Math.PI);
    ctx.stroke();
    console.log(`tight ${r.toFixed(0)} m: piece ${p.key} at ${p.xy[mi].toFixed(0)},${p.xy[mi + 1].toFixed(0)}, ${p.xy.length / 2} points, base ${p.base.length / 2}`);
  }
  // Settlements.
  for (const s of set.sitesIn(VILLAGE, ox, oy, ox + size, oy + size)) {
    const [x, y] = toPx(s.x, s.y);
    ctx.fillStyle = 'rgb(150, 30, 30)';
    ctx.fillRect(x - 3, y - 3, 6, 6);
  }
  for (const s of set.sitesIn(TOWN, ox, oy, ox + size, oy + size)) {
    const [x, y] = toPx(s.x, s.y);
    ctx.fillStyle = 'rgb(150, 30, 30)';
    ctx.fillRect(x - 9, y - 9, 18, 18);
  }

  // Statistics over the pieces whose middle lies in the area.
  let km = 0;
  let ends = 0;
  let rmin = Infinity;
  let over = 0;
  let gmax = 0;
  let gAt = '';
  let sampled = 0;
  let over1k = 0;
  let sampled1k = 0;
  const inside = (x: number, y: number) => x >= ox && x < ox + size && y >= oy && y < oy + size;
  for (const p of pieces) {
    const mid = p.xy.length / 2;
    const mi = 2 * Math.floor(mid / 2);
    if (!inside(p.xy[mi], p.xy[mi + 1])) continue;
    km += polyLen(p.xy) / 1000;
    ends += (p.endA ? 1 : 0) + (p.endB ? 1 : 0);
    rmin = Math.min(rmin, tightestRadius(p.xy, 200));
    // Grade on the coarse surface over 200 m.
    for (let k = 16; k < p.xy.length; k += 16) {
      const g = Math.abs(field.z(p.xy[k], p.xy[k + 1]) - field.z(p.xy[k - 16], p.xy[k - 15])) / 200;
      if (g > gmax) {
        gmax = g;
        gAt = `${p.xy[k].toFixed(0)},${p.xy[k + 1].toFixed(0)} (piece ${p.key})`;
      }
      sampled++;
      if (g > 1.5 * MW_GRADE) over++;
    }
    // …and over 1 km (cuttings and embankments even out shorter bumps).
    for (let k = 80; k < p.xy.length; k += 16) {
      const g = Math.abs(field.z(p.xy[k], p.xy[k + 1]) - field.z(p.xy[k - 80], p.xy[k - 79])) / 1000;
      sampled1k++;
      if (g > 1.5 * MW_GRADE) over1k++;
    }
  }
  console.log(`steepest 200 m step ${(100 * gmax).toFixed(1)} % at ${gAt}`);
  const area = (size / 1000) ** 2;
  info.textContent =
    `${size / 1000} km at ${ox},${oy}${seed === undefined ? '' : ` seed ${seed}`} — terrain ${tTerrain.toFixed(0)} ms, motorways ${tRoute.toFixed(0)} ms, ${mw.unrouted} pieces unrouted\n` +
    `${km.toFixed(1)} km of motorway (${((100 * km) / area).toFixed(2)} km per 100 km²), ${ends} ends; ` +
    `tightest radius ${rmin.toFixed(0)} m (min ${MW_RMIN}; ${tight} pieces tighter, ringed); grade over ${(150 * MW_GRADE).toFixed(0)} % on ${((100 * over) / Math.max(1, sampled)).toFixed(1)} % of 200 m steps, max ${(100 * gmax).toFixed(1)} %; over 1 km: ${((100 * over1k) / Math.max(1, sampled1k)).toFixed(1)} %\n` +
    `dropped line: ${Object.entries(whyKm).map(([w, v]) => `${w} ${v.toFixed(0)} km`).join(', ')}\n` +
    `thick: motorway; dashed: its noise line${showRaw ? '; dropped: grey gate, purple alpine, orange sharp, green loop, teal saddle, red stub' : ' (?raw=1 for dropped stretches)'}; dots: ends; squares: towns`;
}
