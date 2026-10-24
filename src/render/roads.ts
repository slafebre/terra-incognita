import { APRON, CELL, CHUNK, DEM_W } from '../lib/constants';
import { smoothPolyline } from '../lib/polyline';
import { ROAD_C, ROAD_D, ROAD_N, ROAD_P, ROAD_T, type SegmentPath } from '../gen/roads';
import { HAMLET, SITE_RADIUS, type Site } from '../gen/settle';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Road width per class: true map width (m) with a minimum on screen (CSS px). */
const WIDTH_M = [9, 7, 5, 0, 0];
const MIN_PX = [3.2, 2.6, 1.9, 1.0, 0.9];
/** Few passes: heavy smoothing pulls the legs of a hairpin onto each other. */
export const SMOOTH_PASSES = [2, 1, 1, 1, 1];

/** Built-up placeholders (until streets and buildings exist). */
export function drawSites(ctx: Ctx, sites: Site[], cx: number, cy: number, pxPerM: number): void {
  const p = new Path2D();
  for (const s of sites) {
    const x = (s.x - cx * CHUNK) * pxPerM;
    const y = (s.y - cy * CHUNK) * pxPerM;
    const r = SITE_RADIUS[s.rank] * pxPerM;
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = STYLE.builtUp;
  ctx.fill(p);
}

/** Church symbols on villages and towns. */
export function drawChurches(ctx: Ctx, sites: Site[], cx: number, cy: number, pxPerM: number, dpr: number): void {
  ctx.strokeStyle = STYLE.church;
  ctx.fillStyle = STYLE.church;
  ctx.lineWidth = 0.9 * dpr;
  for (const s of sites) {
    if (s.rank >= HAMLET) continue;
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
 * go first, then fills from minor to major, so junctions merge cleanly. Where a
 * way crosses water (`water`: the chunk's lake depth per DEM vertex) it is drawn
 * again on top as a bridge, with parapets either side.
 */
export function drawRoads(ctx: Ctx, roads: SegmentPath[], cx: number, cy: number, pxPerM: number, dpr: number, water: Float32Array): void {
  const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  const bridges = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  /** Over water at chunk pixel (x, y)? Undefined beyond the DEM (another chunk draws that part). */
  const wetAt = (x: number, y: number): boolean | undefined => {
    const i = APRON + Math.round(x / pxPerM / CELL);
    const j = APRON + Math.round(y / pxPerM / CELL);
    return i < 0 || j < 0 || i >= DEM_W || j >= DEM_W ? undefined : water[j * DEM_W + i] > 0;
  };
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
    // Bridges: runs over water, one vertex past either shore. Beyond the DEM the
    // state carries on, so a bridge leaving the chunk isn't capped at its edge.
    const wet: boolean[] = [];
    for (let i = 0; i < n; i++) wet.push(wetAt(xs[i], ys[i]) ?? (i > 0 && wet[i - 1]));
    for (let i = 0; i < n; i++) {
      if (!wet[i]) continue;
      let e = i;
      while (e + 1 < n && wet[e + 1]) e++;
      const s0 = Math.max(0, i - 1);
      const e0 = Math.min(n - 1, e + 1);
      const b = bridges[seg.cls];
      b.moveTo(xs[s0], ys[s0]);
      for (let k = s0 + 1; k <= e0; k++) b.lineTo(xs[k], ys[k]);
      i = e;
    }
  }
  const width = (cls: number) => Math.max(WIDTH_M[cls] * pxPerM, MIN_PX[cls] * dpr);
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
  for (const cls of [ROAD_C, ROAD_D, ROAD_N]) {
    ctx.lineWidth = width(cls) + 2 * STYLE.roads.casingWidth * dpr;
    ctx.stroke(paths[cls]);
  }
  for (const cls of [ROAD_C, ROAD_D, ROAD_N]) {
    ctx.strokeStyle = STYLE.roads.fill[cls];
    ctx.lineWidth = width(cls);
    ctx.stroke(paths[cls]);
  }
  // Bridges, on top: parapets, the gap between them, then the way itself again.
  const { gap, line } = STYLE.roads.bridge;
  ctx.lineCap = 'butt';
  for (const cls of [ROAD_P, ROAD_T, ROAD_C, ROAD_D, ROAD_N]) {
    const b = bridges[cls];
    const cased = cls <= ROAD_C;
    const W = width(cls) + (cased ? 2 * STYLE.roads.casingWidth * dpr : 0);
    ctx.strokeStyle = STYLE.roads.bridge.color;
    ctx.lineWidth = W + 2 * (gap + line) * dpr;
    ctx.stroke(b);
    ctx.strokeStyle = STYLE.roads.bridge.deck;
    ctx.lineWidth = W + 2 * gap * dpr;
    ctx.stroke(b);
    if (cased) {
      ctx.strokeStyle = STYLE.roads.casing;
      ctx.lineWidth = W;
      ctx.stroke(b);
      ctx.strokeStyle = STYLE.roads.fill[cls];
    } else {
      ctx.strokeStyle = cls === ROAD_T ? STYLE.roads.track : STYLE.roads.path;
      if (cls === ROAD_P) ctx.setLineDash([4 * dpr, 3 * dpr]);
    }
    ctx.lineWidth = width(cls);
    ctx.stroke(b);
    ctx.setLineDash([]);
  }
}
