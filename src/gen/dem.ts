import { APRON, CELL, DEM_W } from '../lib/constants';
import { smoothstep } from '../lib/noise';
import { DX, DY, NODE, NODES } from './hydro';
import type { SeedView } from './seeds';
import { computeCover, type CoverInputs } from './landcover';
import type { Site } from './settle';
import { terrainGrid, upliftOf } from './terrain';

/** Share of fine terrain detail kept on steep eroded slopes. */
const STEEP_DETAIL = 0.35;

/** Nodes of hydro data needed around a chunk by the DEM stage. */
export const DEM_PAD = 6;
export const DEM_PATCH = NODES + 2 * DEM_PAD;

/** Hydro data for chunk ± DEM_PAD nodes (row-major DEM_PATCH²). */
export interface DemPatch {
  zPre: Float32Array;
  /** See PreResult.off. */
  off: Float32Array;
  zE: Float32Array;
  A: Float32Array;
  rec: Int8Array;
  lake: Float32Array;
  R: Float32Array;
}

export interface DemResult {
  /** Elevation for contours and hillshade (lakes flat at their level). */
  dem: Float32Array;
  /** Lake level minus ground at each vertex (> 0 under water), or -100 away from lakes. */
  water: Float32Array;
  /** Land cover fields, see `computeCover`. */
  cover: Int8Array;
  /** Stream polylines, see `extractStreams`. */
  streams: Float32Array;
  region: number;
}

/** Cubic B-spline weights for fractional offset t (nodes floor-1 .. floor+2). */
function bspline(t: number, out: Float64Array, o: number): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[o] = (1 - 3 * t + 3 * t2 - t3) / 6;
  out[o + 1] = (3 * t3 - 6 * t2 + 4) / 6;
  out[o + 2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  out[o + 3] = t3 / 6;
}

/**
 * Stream head threshold (km²) by region: wetter, steeper uplands start streams
 * sooner. Continuous in R, so a stream can't stop where it crosses into another region.
 */
export function streamThreshold(R: number): number {
  return 0.07 + 0.23 * (1 - smoothstep(0.15, 0.6, R));
}

/**
 * Detail DEM: B-spline-smoothed eroded surface, plus the fine terrain detail
 * (everything zPre lacks) faded out where erosion has carved the land.
 * Un-eroded land therefore equals the full terrain plus regional uplift.
 */
export function generateDem(cx: number, cy: number, view: SeedView, p: DemPatch, sites: Site[] = []): DemResult {
  const full = terrainGrid(cx, cy, view).dem;
  const dem = new Float32Array(DEM_W * DEM_W);
  const water = new Float32Array(DEM_W * DEM_W);
  // Separable B-spline weights per row / column. Vertex v maps to patch node coordinate
  // DEM_PAD + (v - APRON) * CELL / NODE.
  const idx = new Int32Array(DEM_W);
  const wts = new Float64Array(DEM_W * 4);
  const near = new Int32Array(DEM_W);
  const frac = new Float64Array(DEM_W);
  for (let v = 0; v < DEM_W; v++) {
    const u = DEM_PAD + ((v - APRON) * CELL) / NODE;
    const f = Math.floor(u);
    idx[v] = f;
    bspline(u - f, wts, v * 4);
    near[v] = f;
    frac[v] = u - f;
  }
  const W = DEM_PATCH;
  const U = p.R.map(upliftOf);
  const lakeMask = p.lake.map((l) => (Number.isNaN(l) ? 0 : 1));
  const spline = (g: Float32Array, i: number, j: number) => {
    let s = 0;
    for (let b = 0; b < 4; b++) {
      const row = (idx[j] - 1 + b) * W;
      const wy = wts[j * 4 + b];
      for (let a = 0; a < 4; a++) s += wy * wts[i * 4 + a] * g[row + idx[i] - 1 + a];
    }
    return s;
  };

  // Slope of the eroded surface per node (central differences), splined per vertex
  // like everything else so neighbouring chunks agree exactly.
  const nodeSlope = new Float32Array(W * W);
  const nodeGx = new Float32Array(W * W);
  const nodeGy = new Float32Array(W * W);
  const nodeTpi = new Float32Array(W * W);
  for (let j = 1; j < W - 1; j++)
    for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      const gx = (p.zE[k + 1] - p.zE[k - 1]) / (2 * NODE);
      const gy = (p.zE[k + W] - p.zE[k - W]) / (2 * NODE);
      nodeSlope[k] = Math.sqrt(gx * gx + gy * gy);
      nodeGx[k] = gx;
      nodeGy[k] = gy;
    }
  // Topographic position: node minus the mean of its 5×5 neighbourhood (valleys < 0).
  for (let j = 2; j < W - 2; j++)
    for (let i = 2; i < W - 2; i++) {
      let sum = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) sum += p.zE[(j + dj) * W + i + di];
      nodeTpi[j * W + i] = p.zE[j * W + i] - sum / 25;
    }

  // Pass 1: smoothed eroded surface.
  const zEs = new Float32Array(DEM_W * DEM_W);
  const zPs = new Float32Array(DEM_W * DEM_W);
  const Us = new Float32Array(DEM_W * DEM_W);
  const offs = new Float32Array(DEM_W * DEM_W);
  for (let j = 0; j < DEM_W; j++)
    for (let i = 0; i < DEM_W; i++) {
      const o = j * DEM_W + i;
      zEs[o] = spline(p.zE, i, j);
      zPs[o] = spline(p.zPre, i, j);
      Us[o] = spline(U, i, j);
      offs[o] = spline(p.off, i, j);
    }

  // Pass 2: add fine detail back. Carved land loses it (smooth valleys), but steep
  // eroded hillsides keep some, so they don't read as perfect planes.
  for (let j = 0; j < DEM_W; j++) {
    for (let i = 0; i < DEM_W; i++) {
      const o = j * DEM_W + i;
      const carved = zPs[o] - zEs[o];
      const slope = spline(nodeSlope, i, j);
      const mask = Math.max(1 - smoothstep(0.5, 6, carved), STEEP_DETAIL * smoothstep(0.25, 0.7, slope));
      // Fine detail = full terrain minus the (uplifted) terrain truncated where the
      // hydrology's surface stops.
      const detail = full[o] + Us[o] - (zPs[o] - offs[o]);
      let z = zEs[o] + detail * mask;

      // Lake level from the four surrounding nodes (dilates lakes by up to one node).
      const k = near[j] * W + near[i];
      let level = -Infinity;
      for (const q of [k, k + 1, k + W, k + W + 1]) if (p.lake[q] > level) level = p.lake[q];
      if (level > -Infinity) {
        // Shoreline: where the ground rises above the level, or where the smoothed
        // lake mask ends (avoids blocky node-grid edges), whichever comes first.
        const ground = Math.min(full[o] + Us[o] + offs[o], z);
        water[o] = Math.min(level - ground, (spline(lakeMask, i, j) - 0.3) * 40);
        if (z < level && water[o] > 0) z = level;
        else if (z < level) z = level + 0.05;
      } else water[o] = -100;
      dem[o] = z;
    }
  }

  // Land cover from smooth, node-based terrain descriptors.
  const n = DEM_W * DEM_W;
  const inp: CoverInputs = {
    dem,
    water,
    R: new Float32Array(n),
    slope: new Float32Array(n),
    gx: new Float32Array(n),
    gy: new Float32Array(n),
    tpi: new Float32Array(n),
  };
  for (let j = 0; j < DEM_W; j++)
    for (let i = 0; i < DEM_W; i++) {
      const o = j * DEM_W + i;
      inp.R[o] = spline(p.R, i, j);
      inp.slope[o] = spline(nodeSlope, i, j);
      inp.gx[o] = spline(nodeGx, i, j);
      inp.gy[o] = spline(nodeGy, i, j);
      inp.tpi[o] = spline(nodeTpi, i, j);
    }
  const cover = computeCover(cx, cy, view, inp, sites);

  const c = DEM_PAD + NODES / 2;
  return { dem, water, cover, streams: extractStreams(p), region: p.R[c * W + c] };
}

/**
 * Stream network inside the patch as polylines split at heads and confluences.
 * Format: [n, x0, y0, A0, x1, y1, A1, ...] repeated; x/y in chunk-local metres.
 */
export function extractStreams(p: DemPatch): Float32Array {
  const W = DEM_PATCH;
  const N = W * W;
  const next = new Int32Array(N).fill(-1);
  const indeg = new Uint8Array(N);
  const target = (k: number) => {
    const r = p.rec[k];
    if (r < 0) return -1;
    const i = (k % W) + DX[r];
    const j = Math.floor(k / W) + DY[r];
    return i < 0 || j < 0 || i >= W || j >= W ? -1 : j * W + i;
  };
  // Stream heads by threshold; then everything downstream of a stream is a stream
  // too, until it reaches a lake.
  const isStream = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (p.A[k] < streamThreshold(p.R[k]) || isStream[k]) continue;
    for (let c = k, n = 0; c >= 0 && !isStream[c] && n < N; c = target(c), n++) {
      isStream[c] = 1;
      if (!Number.isNaN(p.lake[c])) break;
    }
  }
  for (let k = 0; k < N; k++) {
    if (!isStream[k]) continue;
    const q = target(k);
    if (q < 0) continue;
    if (!Number.isNaN(p.lake[k]) && !Number.isNaN(p.lake[q])) continue; // inside a lake
    next[k] = q;
    indeg[q]++;
  }
  const out: number[] = [];
  const ox = DEM_PAD * NODE;
  const push = (k: number) => out.push((k % W) * NODE - ox, Math.floor(k / W) * NODE - ox, p.A[k]);
  for (let k = 0; k < N; k++) {
    if (next[k] < 0 || indeg[k] === 1) continue;
    const start = out.length;
    out.push(0);
    push(k);
    let cur = k;
    let n = 1;
    for (;;) {
      const q = next[cur];
      push(q);
      n++;
      if (next[q] < 0 || indeg[q] !== 1) break;
      cur = q;
    }
    out[start] = n;
  }
  return new Float32Array(out);
}
