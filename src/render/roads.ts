import { CHUNK } from '../lib/constants';
import { smoothPolyline } from '../lib/polyline';
import { ROAD_C, ROAD_D, ROAD_N, ROAD_P, ROAD_T, type SegmentPath } from '../gen/roads';
import { SITE_RADIUS, VILLAGE, type Site } from '../gen/settle';
import { LANE, type Street, type TownPlan } from '../gen/town';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Road width per class: true map width (m) with a minimum on screen (CSS px). */
const WIDTH_M = [9, 7, 5, 0, 0];
const MIN_PX = [3.2, 2.6, 1.9, 1.0, 0.9];
/** Streets and lanes inside villages and towns: narrower than C roads. */
const STREET_M = [4.5, 3.5];
const STREET_PX = [1.6, 1.3];
/** Few passes: heavy smoothing pulls the legs of a hairpin onto each other. */
const SMOOTH_PASSES = [2, 1, 1, 1, 1];

/** Built-up placeholders for hamlets and farms (villages and towns have plans). */
export function drawSites(ctx: Ctx, sites: Site[], cx: number, cy: number, pxPerM: number): void {
  const p = new Path2D();
  for (const s of sites) {
    if (s.rank <= VILLAGE) continue;
    const x = (s.x - cx * CHUNK) * pxPerM;
    const y = (s.y - cy * CHUNK) * pxPerM;
    const r = SITE_RADIUS[s.rank] * pxPerM;
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = STYLE.builtUp;
  ctx.fill(p);
}

/**
 * Built-up land of villages and towns: a strip along their streets and the roads
 * through them. Strips are drawn opaque into a layer, then laid down translucent
 * once, so overlaps don't darken.
 */
export function drawBuiltUp(ctx: Ctx, plans: TownPlan[], cx: number, cy: number, pxPerM: number): void {
  if (!plans.length) return;
  const layer = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height);
  const lc = layer.getContext('2d')!;
  lc.lineCap = 'round';
  lc.lineJoin = 'round';
  lc.strokeStyle = STYLE.builtUpLayer;
  for (const pl of plans)
    for (const f of pl.frontage) {
      const p = new Path2D();
      trace(p, f.xy, cx, cy, pxPerM, 0);
      lc.lineWidth = 2 * f.depth * pxPerM;
      lc.stroke(p);
    }
  ctx.save();
  ctx.globalAlpha = STYLE.builtUpAlpha;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/** Appends a polyline (world metres) to `p` in chunk pixels, smoothed `passes` times. */
function trace(p: Path2D, xy: Float32Array, cx: number, cy: number, pxPerM: number, passes: number): void {
  const n = xy.length / 2;
  if (n < 2) return;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    xs.push((xy[2 * i] - cx * CHUNK) * pxPerM);
    ys.push((xy[2 * i + 1] - cy * CHUNK) * pxPerM);
  }
  for (let pass = 0; pass < passes; pass++) smoothPolyline(xs, ys);
  p.moveTo(xs[0], ys[0]);
  for (let i = 1; i < n - 1; i++) p.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
  p.lineTo(xs[n - 1], ys[n - 1]);
}

/** Church symbols at the centres of villages and towns. */
export function drawChurches(ctx: Ctx, plans: TownPlan[], cx: number, cy: number, pxPerM: number, dpr: number): void {
  ctx.strokeStyle = STYLE.church;
  ctx.fillStyle = STYLE.church;
  ctx.lineWidth = 0.9 * dpr;
  for (const s of plans) {
    const x = (s.x - cx * CHUNK) * pxPerM;
    const y = (s.y - cy * CHUNK) * pxPerM;
    const r = 2.2 * dpr;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y - r - 3.5 * dpr);
    ctx.lineTo(x, y - r);
    ctx.moveTo(x - 1.6 * dpr, y - r - 2.2 * dpr);
    ctx.lineTo(x + 1.6 * dpr, y - r - 2.2 * dpr);
    ctx.stroke();
  }
}

/**
 * Roads: each fine segment is smoothed with its endpoints fixed (they're shared
 * waypoints), so segments drawn by neighbouring chunks meet exactly. All casings
 * go first, then fills from minor to major, so junctions merge cleanly.
 */
export function drawRoads(ctx: Ctx, roads: SegmentPath[], streets: Street[], cx: number, cy: number, pxPerM: number, dpr: number): void {
  const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  const streetPaths = [new Path2D(), new Path2D()];
  for (const s of streets) trace(streetPaths[s.cls], s.xy, cx, cy, pxPerM, 1);
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  for (const seg of roads) {
    const n = seg.xy.length / 2;
    if (n < 2) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      xs.push((seg.xy[2 * i] - ox) * pxPerM);
      ys.push((seg.xy[2 * i + 1] - oy) * pxPerM);
    }
    // Wider curves for bigger roads: repeated smoothing ≈ a wider kernel.
    for (let pass = 0; pass < SMOOTH_PASSES[seg.cls]; pass++) smoothPolyline(xs, ys);
    const p = paths[seg.cls];
    p.moveTo(xs[0], ys[0]);
    for (let i = 1; i < n - 1; i++) p.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
    p.lineTo(xs[n - 1], ys[n - 1]);
  }
  const width = (cls: number) => Math.max(WIDTH_M[cls] * pxPerM, MIN_PX[cls] * dpr);
  const streetWidth = (cls: number) => Math.max(STREET_M[cls] * pxPerM, STREET_PX[cls] * dpr);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Footpaths (dashed) and tracks (thin solid) first, uncased, under the roads.
  ctx.strokeStyle = STYLE.roads.path;
  ctx.lineWidth = width(ROAD_P);
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.stroke(paths[ROAD_P]);
  ctx.setLineDash([]);
  ctx.strokeStyle = STYLE.roads.track;
  ctx.lineWidth = width(ROAD_T);
  ctx.stroke(paths[ROAD_T]);
  ctx.strokeStyle = STYLE.roads.casing;
  for (const cls of [LANE, 0]) {
    ctx.lineWidth = streetWidth(cls) + 2 * STYLE.roads.casingWidth * dpr;
    ctx.stroke(streetPaths[cls]);
  }
  for (const cls of [ROAD_C, ROAD_D, ROAD_N]) {
    ctx.lineWidth = width(cls) + 2 * STYLE.roads.casingWidth * dpr;
    ctx.stroke(paths[cls]);
  }
  ctx.strokeStyle = STYLE.roads.fill[ROAD_C];
  for (const cls of [LANE, 0]) {
    ctx.lineWidth = streetWidth(cls);
    ctx.stroke(streetPaths[cls]);
  }
  for (const cls of [ROAD_C, ROAD_D, ROAD_N]) {
    ctx.strokeStyle = STYLE.roads.fill[cls];
    ctx.lineWidth = width(cls);
    ctx.stroke(paths[cls]);
  }
}
