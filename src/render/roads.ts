import { APRON, CELL, CHUNK, DEM_W } from '../lib/constants';
import { COVER, COVER_SCALE } from '../gen/landcover';
import { smoothPolyline } from '../lib/polyline';
import { lineDistance, MW_RAMP_WIDTH, MW_VERGE, MW_WIDTH } from '../gen/motorway';
import { ringDisc, ROAD_C, ROAD_D, ROAD_N, ROAD_P, ROAD_T, type SegmentPath } from '../gen/roads';
import { VILLAGE } from '../gen/settle';
import { LANE, type Street, type TownPlan } from '../gen/town';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Road width per class: true map width (m) with a minimum on screen (CSS px). */
export const WIDTH_M = [9, 7, 5, 0, 0];
export const MIN_PX = [3.2, 2.6, 1.9, 1.0, 0.9];
/** Streets and lanes inside villages and towns: narrower than C roads. */
export const STREET_M = [4.5, 3.5];
export const STREET_PX = [1.6, 1.3];
/** Few passes: heavy smoothing pulls the legs of a hairpin onto each other. */
export const SMOOTH_PASSES = [2, 1, 1, 1, 1];

/** Cover cleared under built-up land, and this many metres beyond its edge (a soft margin). */
const CLEAR_EDGE = 6;
/** Classes built-up land replaces: woods, vines, marsh and heath (not rock or ice). */
const CLEARED = [COVER.forest, COVER.vineyard, COVER.wetland, COVER.heath];

/**
 * Clears the cover fields (in place) under the built-up strips of the plans and under
 * motorways and their verges, so no trees or vines show through: each field is held
 * below the signed distance to the strip's edge.
 */
export function clearUnderBuiltUp(cover: Int8Array, plans: TownPlan[], cx: number, cy: number, motorways: Float64Array[] = []): void {
  const N = DEM_W * DEM_W;
  const ox = cx * CHUNK - APRON * CELL;
  const oy = cy * CHUNK - APRON * CELL;
  // Signed distance (m) to the nearest strip's edge, where within reach.
  const dist = new Float32Array(N).fill(Infinity);
  // Built-up strips, and motorways with their verges.
  const strips: { xy: ArrayLike<number>; depth: number }[] = [...plans.flatMap((pl) => pl.frontage), ...motorways.map((xy) => ({ xy, depth: MW_VERGE }))];
  for (const f of strips) {
    const reach = f.depth + CLEAR_EDGE;
    for (let k = 2; k < f.xy.length; k += 2) {
      const ax = f.xy[k - 2] - ox;
      const ay = f.xy[k - 1] - oy;
      const dx = f.xy[k] - ox - ax;
      const dy = f.xy[k + 1] - oy - ay;
      const i0 = Math.max(0, Math.floor((Math.min(ax, ax + dx) - reach) / CELL));
      const i1 = Math.min(DEM_W - 1, Math.ceil((Math.max(ax, ax + dx) + reach) / CELL));
      const j0 = Math.max(0, Math.floor((Math.min(ay, ay + dy) - reach) / CELL));
      const j1 = Math.min(DEM_W - 1, Math.ceil((Math.max(ay, ay + dy) + reach) / CELL));
      if (i0 > i1 || j0 > j1) continue;
      const l2 = dx * dx + dy * dy || 1e-9;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const px = i * CELL - ax;
          const py = j * CELL - ay;
          const t = Math.max(0, Math.min(1, (px * dx + py * dy) / l2));
          const d = Math.hypot(px - t * dx, py - t * dy) - f.depth;
          const o = j * DEM_W + i;
          if (d < dist[o]) dist[o] = d;
        }
    }
  }
  for (let o = 0; o < N; o++) {
    const d = dist[o];
    if (d >= CLEAR_EDGE) continue;
    // 0 at the soft margin's outer edge, negative inside: the class ends there.
    const v = Math.round(Math.max(-127, ((d - CLEAR_EDGE) / CLEAR_EDGE) * COVER_SCALE));
    for (const c of CLEARED) if (cover[c * N + o] > v) cover[c * N + o] = v;
  }
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
    if (s.rank > VILLAGE) continue; // hamlets have none
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
 * go first — streets, C roads, interchange ramps, D and N roads, motorways — then the fills in the same
 * order, so junctions merge cleanly (a ramp into the main road it leaves and the motorway
 * it joins; minor roads go under ramps, as under the motorway). Where a way crosses water (`water`: the chunk's lake depth per DEM vertex) it
 * is drawn again on top as a bridge, with parapets either side; so is a way over a
 * motorway (experimental).
 */
export function drawRoads(
  ctx: Ctx,
  roads: SegmentPath[],
  streets: Street[],
  motorways: Float64Array[],
  cx: number,
  cy: number,
  pxPerM: number,
  dpr: number,
  water: Float32Array,
): void {
  const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  const streetPaths = [new Path2D(), new Path2D()];
  // Unsmoothed: streets are crooked, their kinks are meant.
  for (const s of streets) trace(streetPaths[s.cls], s.xy, cx, cy, pxPerM, 0);
  const bridges = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  /** Over water at chunk pixel (x, y)? Undefined beyond the DEM (another chunk draws that part). */
  const wetAt = (x: number, y: number): boolean | undefined => {
    const i = APRON + Math.round(x / pxPerM / CELL);
    const j = APRON + Math.round(y / pxPerM / CELL);
    return i < 0 || j < 0 || i >= DEM_W || j >= DEM_W ? undefined : water[j * DEM_W + i] > 0;
  };
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  const ramps = new Path2D();
  for (const seg of roads) {
    const n = seg.xy.length / 2;
    if (n < 2) continue;
    if (seg.ramp) {
      trace(ramps, seg.xy, cx, cy, pxPerM, 0);
      continue;
    }
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
  const mw = STYLE.roads.motorway;
  const rampW = Math.max(MW_RAMP_WIDTH * pxPerM, mw.rampMinPx * dpr);
  const mwW = Math.max(MW_WIDTH * pxPerM, mw.minPx * dpr);
  const casing = 2 * STYLE.roads.casingWidth * dpr;
  const motorway = motorwayPaths(motorways, cx, cy, pxPerM, water);
  // Casings.
  ctx.strokeStyle = STYLE.roads.casing;
  for (const cls of [LANE, 0]) {
    ctx.lineWidth = streetWidth(cls) + casing;
    ctx.stroke(streetPaths[cls]);
  }
  ctx.lineWidth = width(ROAD_C) + casing;
  ctx.stroke(paths[ROAD_C]);
  ctx.lineWidth = rampW + casing;
  ctx.stroke(ramps);
  for (const cls of [ROAD_D, ROAD_N]) {
    ctx.lineWidth = width(cls) + casing;
    ctx.stroke(paths[cls]);
  }
  ctx.lineWidth = mwW + casing;
  ctx.stroke(motorway.path);
  // Fills.
  ctx.strokeStyle = STYLE.roads.fill[ROAD_C];
  for (const cls of [LANE, 0]) {
    ctx.lineWidth = streetWidth(cls);
    ctx.stroke(streetPaths[cls]);
  }
  ctx.strokeStyle = STYLE.roads.fill[ROAD_C];
  ctx.lineWidth = width(ROAD_C);
  ctx.stroke(paths[ROAD_C]);
  // Ramps over minor roads (they belong to the motorway), under the main roads they join.
  ctx.strokeStyle = mw.fill;
  ctx.lineWidth = rampW;
  ctx.stroke(ramps);
  for (const cls of [ROAD_D, ROAD_N]) {
    ctx.strokeStyle = STYLE.roads.fill[cls];
    ctx.lineWidth = width(cls);
    ctx.stroke(paths[cls]);
  }
  ctx.strokeStyle = mw.fill;
  ctx.lineWidth = mwW;
  ctx.stroke(motorway.path);
  ctx.strokeStyle = mw.median;
  ctx.lineWidth = mw.medianWidth * dpr;
  ctx.stroke(motorway.path);
  // Bridges, on top: ways over water, motorways over water, then ways over motorways.
  drawBridges(ctx, bridges, pxPerM, dpr);
  if (!motorways.length) return;
  const { gap, line } = STYLE.roads.bridge;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = STYLE.roads.bridge.color;
  ctx.lineWidth = mwW + casing + 2 * (gap + line) * dpr;
  ctx.stroke(motorway.bridges);
  ctx.strokeStyle = STYLE.roads.bridge.deck;
  ctx.lineWidth = mwW + casing + 2 * gap * dpr;
  ctx.stroke(motorway.bridges);
  ctx.strokeStyle = STYLE.roads.casing;
  ctx.lineWidth = mwW + casing;
  ctx.stroke(motorway.bridges);
  ctx.strokeStyle = mw.fill;
  ctx.lineWidth = mwW;
  ctx.stroke(motorway.bridges);
  ctx.strokeStyle = mw.median;
  ctx.lineWidth = mw.medianWidth * dpr;
  ctx.stroke(motorway.bridges);
  drawBridges(ctx, overpasses(roads, motorways, cx, cy, pxPerM), pxPerM, dpr);
}

/** Bridges by class, on top: parapets, the gap between them, then the way itself again. */
function drawBridges(ctx: Ctx, bridges: Path2D[], pxPerM: number, dpr: number): void {
  const width = (cls: number) => Math.max(WIDTH_M[cls] * pxPerM, MIN_PX[cls] * dpr);
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

/** Motorways' centre lines in chunk pixels, and the runs of them over water (as drawRoads' bridges). */
function motorwayPaths(lines: Float64Array[], cx: number, cy: number, pxPerM: number, water: Float32Array): { path: Path2D; bridges: Path2D } {
  const path = new Path2D();
  const bridges = new Path2D();
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  for (const xy of lines) {
    const n = xy.length / 2;
    if (n < 2) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      xs.push((xy[2 * i] - ox) * pxPerM);
      ys.push((xy[2 * i + 1] - oy) * pxPerM);
    }
    path.moveTo(xs[0], ys[0]);
    for (let i = 1; i < n; i++) path.lineTo(xs[i], ys[i]);
    // Bridges: runs over water, one point past either shore.
    const wet: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const gi = APRON + Math.round(xs[i] / pxPerM / CELL);
      const gj = APRON + Math.round(ys[i] / pxPerM / CELL);
      const inside = gi >= 0 && gj >= 0 && gi < DEM_W && gj < DEM_W;
      wet.push(inside ? water[gj * DEM_W + gi] > 0 : i > 0 && wet[i - 1]);
    }
    for (let i = 0; i < n; i++) {
      if (!wet[i]) continue;
      let e = i;
      while (e + 1 < n && wet[e + 1]) e++;
      const s0 = Math.max(0, i - 1);
      const e0 = Math.min(n - 1, e + 1);
      bridges.moveTo(xs[s0], ys[s0]);
      for (let k = s0 + 1; k <= e0; k++) bridges.lineTo(xs[k], ys[k]);
      i = e;
    }
  }
  return { path, bridges };
}

/**
 * Ways over a motorway, by class: the runs of each within its half width (and a little),
 * one point past either side, smoothed as drawRoads draws them (not the ramps).
 */
function overpasses(roads: SegmentPath[], lines: Float64Array[], cx: number, cy: number, pxPerM: number): Path2D[] {
  const over = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  const reach = MW_WIDTH / 2 + OVERPASS_MARGIN;
  const near = lineDistance(lines, reach + 1);
  // Roundabouts a motorway runs into (where it ends): the roads leaving them don't pass over it.
  const toRing = lineDistance(lines, 64);
  const termini = roads.filter((r) => r.ring).map((r) => ringDisc(r.xy)).filter(([x, y, r]) => toRing(x, y) < r + 5);
  const atTerminus = (x: number, y: number) => termini.some(([tx, ty, r]) => Math.hypot(x - tx, y - ty) < r + reach + 8);
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  for (const seg of roads) {
    const n = seg.xy.length / 2;
    if (n < 2 || seg.ramp) continue;
    const hit: boolean[] = [];
    let any = false;
    for (let i = 0; i < n; i++) {
      const h = near(seg.xy[2 * i], seg.xy[2 * i + 1]) < reach && !atTerminus(seg.xy[2 * i], seg.xy[2 * i + 1]);
      hit.push(h);
      any ||= h;
    }
    if (!any) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      xs.push((seg.xy[2 * i] - ox) * pxPerM);
      ys.push((seg.xy[2 * i + 1] - oy) * pxPerM);
    }
    for (let pass = 0; pass < SMOOTH_PASSES[seg.cls]; pass++) smoothPolyline(xs, ys);
    for (let i = 0; i < n; i++) {
      if (!hit[i]) continue;
      let e = i;
      while (e + 1 < n && hit[e + 1]) e++;
      const s0 = Math.max(0, i - 1);
      const e0 = Math.min(n - 1, e + 1);
      over[seg.cls].moveTo(xs[s0], ys[s0]);
      for (let k = s0 + 1; k <= e0; k++) over[seg.cls].lineTo(xs[k], ys[k]);
      i = e;
    }
  }
  return over;
}

/** Ways cross a motorway on a bridge over this much more than its half width (m). */
const OVERPASS_MARGIN = 4;
