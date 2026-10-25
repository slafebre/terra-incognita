import { APRON, CELL, CELLS, CHUNK, DEM_W } from '../lib/constants';
import { marchingSquares } from '../lib/contours';
import { smoothPolyline } from '../lib/polyline';
import { COVER } from '../gen/landcover';
import { type Fields, layFields } from '../gen/fields';
import { placePois, type PoiPatch } from '../gen/poi';
import type { SegmentPath } from '../gen/roads';
import type { TownPlan } from '../gen/town';
import { cellCoverage, drawCoverSymbols, FILLS } from './landcover';
import { drawBuildings } from './buildings';
import { clearUnderBuiltUp, drawChurches, drawRoads } from './roads';
import { lineDistance, MW_VERGE } from '../gen/motorway';
import { classifyMotorways, MW_LEVEL, runsOf } from './motorway';
import { drawPois } from './symbols';
import { drawFields } from './fields';
import { coverAt } from './landcover';
import { CONTOURS, STYLE } from './style';

export interface RenderInput {
  cx: number;
  cy: number;
  dem: Float32Array;
  /** Land cover fields from `computeCover`. */
  cover: Int8Array;
  /** Lake depth per vertex (> 0 under water). */
  water: Float32Array;
  /** Stream polylines from `extractStreams`. */
  streams: Float32Array;
  /** Road segments that may cross this chunk. */
  roads: SegmentPath[];
  /** Centre lines of the motorways passing near the chunk (world metres). */
  motorways: Float64Array[];
  /** Plans of settlements (street plans, farmsteads) that may draw into this chunk. */
  plans: TownPlan[];
  /** Fine nodes round the chunk, for its points of interest and field parcels. */
  poi?: PoiPatch;
  /** Lattice edges carrying ways near the chunk ([ax, ay, bx, by] each): its field parcels' blocks. */
  edges: number[][];
  /** Its field parcels as laid out before from the same inputs (they don't depend on the zoom), if any. */
  fields?: Fields;
  /** Raster edge length in device pixels. */
  pxSize: number;
  /** Device pixels per CSS pixel (line widths are specified in CSS px). */
  dpr: number;
}

const az = (STYLE.lightAzimuthDeg * Math.PI) / 180;
const alt = (STYLE.lightAltitudeDeg * Math.PI) / 180;
// World axes: x east, y south. Azimuth is clockwise from north.
const LX = Math.cos(alt) * Math.sin(az);
const LY = -Math.cos(alt) * Math.cos(az);
const LZ = Math.sin(alt);

/** Per-vertex shadow amount (0 = none, 1 = full) and slope (m/m). */
export function shadeAndSlope(dem: Float32Array): { shade: Float32Array; slope: Float32Array } {
  const shade = new Float32Array(DEM_W * DEM_W);
  const slope = new Float32Array(DEM_W * DEM_W);
  for (let j = 1; j < DEM_W - 1; j++) {
    for (let i = 1; i < DEM_W - 1; i++) {
      const k = j * DEM_W + i;
      const gx = (dem[k + 1] - dem[k - 1]) / (2 * CELL);
      const gy = (dem[k + DEM_W] - dem[k - DEM_W]) / (2 * CELL);
      const dot = (-gx * LX - gy * LY + LZ) / Math.sqrt(gx * gx + gy * gy + 1);
      const s = 1 - dot / LZ;
      shade[k] = s < 0 ? 0 : s > 1 ? 1 : s;
      slope[k] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return { shade, slope };
}

/** Farmland tests for field parcels, from a chunk's grids (world metres): open land (no woods, rock, heath, marsh or water), and slope. */
export function farmlandTests(cx: number, cy: number, cover: Int8Array, water: Float32Array, slope: Float32Array) {
  const vertex = (x: number, y: number) => {
    const i = Math.min(DEM_W - 1, Math.max(0, Math.round((x - cx * CHUNK) / CELL) + APRON));
    const j = Math.min(DEM_W - 1, Math.max(0, Math.round((y - cy * CHUNK) / CELL) + APRON));
    return j * DEM_W + i;
  };
  const notFarmland = [COVER.forest, COVER.rock, COVER.scree, COVER.glacier, COVER.heath, COVER.wetland];
  return {
    open: (x: number, y: number) => water[vertex(x, y)] <= 0 && notFarmland.every((f) => coverAt(cover, f, x - cx * CHUNK, y - cy * CHUNK) <= 0),
    slope: (x: number, y: number) => slope[vertex(x, y)],
  };
}

/** River width in metres for drainage area A (km²). */
export const riverWidth = (A: number) => 1.1 * Math.pow(A, 0.55);

/** The raster, and the field parcels it laid out (or was given). */
export function renderChunk({ cx, cy, dem, cover, water, streams, roads, motorways: lines, plans, poi, edges, fields: given, pxSize, dpr }: RenderInput): {
  canvas: OffscreenCanvas;
  fields?: Fields;
} {
  // Motorways against the ground (viaducts, tunnels, earthworks); where they run level
  // they clear the woods and fields beside them (under a viaduct and over a tunnel the
  // land runs on).
  const mws = classifyMotorways(lines, poi);
  const motorways = mws.flatMap((m) => runsOf(m, (c) => c === MW_LEVEL));
  const canvas = new OffscreenCanvas(pxSize, pxSize);
  const ctx = canvas.getContext('2d')!;
  const pxPerM = pxSize / CHUNK;
  const { shade, slope } = shadeAndSlope(dem);
  // Built-up land replaces woods and vines under it (the cover here is this render's own copy).
  // (Ramps too: interchanges clear their land.)
  const rampLines = roads.filter((r) => r.ramp).map((r) => Float64Array.from(r.xy));
  clearUnderBuiltUp(cover, plans, cx, cy, [...motorways, ...rampLines]);

  // --- Land cover fills, hillshade, lakes ---------------------------------
  const img = ctx.createImageData(pxSize, pxSize);
  const data = img.data;
  const [pr, pg, pb] = STYLE.paper;
  const k = STYLE.shadeStrength;
  const sr = 1 - STYLE.shadow[0] / 255;
  const sg = 1 - STYLE.shadow[1] / 255;
  const sb = 1 - STYLE.shadow[2] / 255;
  const [wr, wg, wb2] = STYLE.waterFill;
  // Water coverage per pixel (alpha), to keep contours out of lakes; null while the chunk has none.
  let wetMask: ImageData | null = null;
  const pxPerVertex = CELL * pxPerM;
  const col0 = new Int32Array(pxSize);
  const colF = new Float32Array(pxSize);
  for (let p = 0; p < pxSize; p++) {
    const u = APRON + (p + 0.5) / pxPerM / CELL;
    col0[p] = Math.floor(u);
    colF[p] = u - col0[p];
  }
  let o = 0;
  for (let py = 0; py < pxSize; py++) {
    const j = col0[py];
    const fy = colF[py];
    const r0 = j * DEM_W;
    const r1 = r0 + DEM_W;
    for (let px = 0; px < pxSize; px++) {
      const i = col0[px];
      const fx = colF[px];
      const top = shade[r0 + i] + (shade[r0 + i + 1] - shade[r0 + i]) * fx;
      const bot = shade[r1 + i] + (shade[r1 + i + 1] - shade[r1 + i]) * fx;
      const s = (top + (bot - top) * fy) * k;
      // Base colour: paper, or the first land cover fill present (anti-aliased edges).
      let br = pr;
      let bg = pg;
      let bb = pb;
      let left = 1;
      for (const f of FILLS) {
        const a = cellCoverage(cover, f.field, r0, i, fx, fy, pxPerVertex) * left;
        if (a <= 0) continue;
        br += (f.rgb[0] - pr) * a;
        bg += (f.rgb[1] - pg) * a;
        bb += (f.rgb[2] - pb) * a;
        left -= a;
        if (left <= 0.001) break;
      }
      let r = br * (1 - s * sr);
      let g = bg * (1 - s * sg);
      let b = bb * (1 - s * sb);
      const wt = water[r0 + i] + (water[r0 + i + 1] - water[r0 + i]) * fx;
      const wb = water[r1 + i] + (water[r1 + i + 1] - water[r1 + i]) * fx;
      const wv = wt + (wb - wt) * fy;
      if (wv > -0.2) {
        const a = wv >= 0.2 ? 1 : (wv + 0.2) / 0.4;
        r += (wr - r) * a;
        g += (wg - g) * a;
        b += (wb2 - b) * a;
        (wetMask ??= new ImageData(pxSize, pxSize)).data[o + 3] = a * 255;
      }
      data[o++] = r;
      data[o++] = g;
      data[o++] = b;
      data[o++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // --- Adaptive contours ------------------------------------------------
  // Process one cell beyond the chunk on each side so strokes overlap the border.
  const cellSlope = (i: number, j: number) => {
    const a = j * DEM_W + i;
    return (slope[a] + slope[a + 1] + slope[a + DEM_W] + slope[a + DEM_W + 1]) / 4;
  };
  const { byLevel } = marchingSquares(
    dem,
    DEM_W,
    APRON - 1,
    APRON - 1,
    APRON + CELLS + 1,
    APRON + CELLS + 1,
    CONTOURS.interval,
    (L, i, j) => {
      const s = cellSlope(i, j);
      if (s > CONTOURS.slopeDropAll) return false;
      if (L % 50 === 0) return true;
      return L % 10 === 0 ? s <= CONTOURS.slopeDrop10 : s <= CONTOURS.slopeDrop5;
    },
  );

  const scale = CELL * pxPerM;
  const normal = new Path2D();
  const index = new Path2D();
  const ice = new Path2D();
  const onIce = (x: number, y: number) => {
    const i = Math.min(DEM_W - 1, Math.max(0, Math.round(x)));
    const j = Math.min(DEM_W - 1, Math.max(0, Math.round(y)));
    return cover[COVER.glacier * DEM_W * DEM_W + j * DEM_W + i] > 0;
  };
  for (const [L, segs] of byLevel) {
    for (let n = 0; n < segs.length; n += 4) {
      // On glaciers contours are blue (IGN); index lines are not emphasised there.
      const path = onIce((segs[n] + segs[n + 2]) / 2, (segs[n + 1] + segs[n + 3]) / 2) ? ice : L % 25 === 0 ? index : normal;
      path.moveTo((segs[n] - APRON) * scale, (segs[n + 1] - APRON) * scale);
      path.lineTo((segs[n + 2] - APRON) * scale, (segs[n + 3] - APRON) * scale);
    }
  }
  // Lakes hide their contours: stroke them on a layer of their own and erase it under the water fill.
  const layer = wetMask ? new OffscreenCanvas(pxSize, pxSize) : canvas;
  const lctx = layer === canvas ? ctx : layer.getContext('2d')!;
  lctx.lineCap = 'round';
  lctx.lineJoin = 'round';
  lctx.strokeStyle = STYLE.contour;
  lctx.lineWidth = STYLE.contourWidth * dpr;
  lctx.stroke(normal);
  lctx.strokeStyle = STYLE.contourIndex;
  lctx.lineWidth = STYLE.contourIndexWidth * dpr;
  lctx.stroke(index);
  lctx.strokeStyle = STYLE.cover.glacierContour;
  lctx.lineWidth = STYLE.contourWidth * dpr;
  lctx.stroke(ice);
  if (wetMask) {
    const mask = new OffscreenCanvas(pxSize, pxSize);
    mask.getContext('2d')!.putImageData(wetMask, 0, 0);
    lctx.globalCompositeOperation = 'destination-out';
    lctx.drawImage(mask, 0, 0);
    ctx.drawImage(layer, 0, 0);
  }

  drawCoverSymbols(ctx, { cx, cy, dem, water, cover, pxPerM, dpr });

  // Plans may redraw roads through their settlements: theirs replace the network's.
  const redrawn = new Set(plans.flatMap((p) => p.replaced));
  const drawn = [...roads.filter((r) => !redrawn.has(r.key)), ...plans.flatMap((p) => p.roads)];

  // --- Field parcels and hedges (on farmland: no woods, rock, heath, marsh or water) ----
  let fields = given;
  if (poi) {
    if (!fields) {
      const farmland = farmlandTests(cx, cy, cover, water, slope);
      // Not on a motorway or its verges.
      const mwDist = lineDistance([...motorways, ...rampLines], MW_VERGE);
      const open = (x: number, y: number) => farmland.open(x, y) && mwDist(x, y) >= MW_VERGE;
      fields = layFields({ cx, cy, edges, patch: poi, roads: drawn, plans, ...farmland, open });
    }
    drawFields(ctx, fields, cx, cy, pxPerM, dpr);
  }

  // --- Lake shorelines --------------------------------------------------
  const shore = marchingSquares(water, DEM_W, APRON - 1, APRON - 1, APRON + CELLS + 1, APRON + CELLS + 1, 1000, (L) => L === 0);
  const shorePath = new Path2D();
  for (const segs of shore.byLevel.values())
    for (let n = 0; n < segs.length; n += 4) {
      shorePath.moveTo((segs[n] - APRON) * scale, (segs[n + 1] - APRON) * scale);
      shorePath.lineTo((segs[n + 2] - APRON) * scale, (segs[n + 3] - APRON) * scale);
    }
  ctx.strokeStyle = STYLE.waterLine;
  ctx.lineWidth = STYLE.shoreWidth * dpr;
  ctx.stroke(shorePath);

  drawStreams(ctx, streams, pxPerM, dpr);
  drawBuildings(ctx, plans, cx, cy, pxPerM, dpr);
  drawRoads(ctx, drawn, plans.flatMap((p) => p.streets), mws, cx, cy, pxPerM, dpr, water);
  drawChurches(ctx, plans, cx, cy, pxPerM, dpr);
  // Points of interest: the chunk's own (hilltops, wayside crosses, springs) and the plans' (water towers).
  const pois = [...(poi ? placePois({ cx, cy, patch: poi, roads: drawn, plans }) : []), ...plans.flatMap((p) => p.pois)];
  drawPois(ctx, pois, cx, cy, pxPerM, dpr);
  return { canvas, fields };
}

/**
 * Streams as smoothed polylines (quadratic curves through segment midpoints).
 * Each piece is stroked with the width at its control vertex, bucketed into a
 * few Path2Ds; casings for wide rivers are drawn first so confluences merge.
 */
function drawStreams(ctx: OffscreenCanvasRenderingContext2D, s: Float32Array, pxPerM: number, dpr: number): void {
  const buckets = new Map<number, Path2D>();
  const bucket = (w: number) => {
    const key = Math.round(w * 4) / 4;
    let p = buckets.get(key);
    if (!p) buckets.set(key, (p = new Path2D()));
    return p;
  };
  const minW = STYLE.streamMinWidth * dpr;
  for (let o = 0; o < s.length; ) {
    const n = s[o++];
    const xs: number[] = [];
    const ys: number[] = [];
    const as: number[] = [];
    for (let v = 0; v < n; v++) {
      xs.push(s[o++] * pxPerM);
      ys.push(s[o++] * pxPerM);
      as.push(s[o++]);
    }
    smoothPolyline(xs, ys);
    for (let v = 0; v < n - 1; v++) {
      // Piece from the midpoint before vertex v (or v itself at the start) to the midpoint after it.
      const w = Math.max(minW, riverWidth(as[v]) * pxPerM);
      const p = bucket(w);
      const sx = v === 0 ? xs[0] : (xs[v - 1] + xs[v]) / 2;
      const sy = v === 0 ? ys[0] : (ys[v - 1] + ys[v]) / 2;
      const ex = v === n - 2 ? xs[v + 1] : (xs[v] + xs[v + 1]) / 2;
      const ey = v === n - 2 ? ys[v + 1] : (ys[v] + ys[v + 1]) / 2;
      p.moveTo(sx, sy);
      if (v === 0) p.lineTo(ex, ey);
      else p.quadraticCurveTo(xs[v], ys[v], ex, ey);
    }
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const cased = STYLE.streamCasedFrom * dpr;
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  ctx.strokeStyle = STYLE.waterLine;
  for (const [w, p] of sorted) {
    ctx.lineWidth = w < cased ? w : w + 1.1 * dpr;
    ctx.stroke(p);
  }
  ctx.strokeStyle = STYLE.waterFillCss;
  for (const [w, p] of sorted) {
    if (w < cased) continue;
    ctx.lineWidth = w - 0.2 * dpr;
    ctx.stroke(p);
  }
}
