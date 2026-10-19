import { CHUNK } from '../lib/constants';
import { hash3, rng } from '../lib/hash';
import { MinHeap } from '../lib/heap';
import { COARSE_SPACINGS, MAX_WARP, type SeedView } from './seeds';
import { baseField, erodeK, erodeSmax, maxIncisionOf, Terrain, upliftOf } from './terrain';

/**
 * Hydrology and fluvial erosion — a pure function of the seeds.
 *
 * Works on a 16 m node grid (nodes at world multiples of NODE). Per chunk:
 *
 *  1. `pre`: uplift surface zPre (terrain without octaves < 64 m, plus regional
 *     uplift) and region R.
 *  2. `hydro`: a *window solve* centred on the chunk (±WIN_CHUNKS chunks):
 *     - outlets at the window edge, at the (consistent) coarse eroded base level;
 *       big rivers entering the window injected from the coarse solution;
 *     - priority-flood filling, stochastic routing with place-bound randomness,
 *       then route → accumulate → carve passes (steady-state stream power with
 *       threshold hillslopes: zE = max(zE(rec)+ε·d, min(zPre, zE(rec)+S·d)));
 *     - dammed and natural lakes, valley floors, an all-direction hillslope limiter,
 *       and a final flood that guarantees every node drains.
 *     Only the *core* (chunk ± CORE_PAD nodes) is kept.
 *  3. Elevation at any node is the bilinear blend of the four window solves whose
 *     centres surround it (weights reach zero one chunk from a centre, far from
 *     any window edge). Rivers and lakes come from the window of the node's own
 *     chunk. Solves never depend on each other, so there are no seams from solve
 *     order — only differences between overlapping solves, faded out smoothly.
 */

export const NODE = 16;
export const NODES = CHUNK / NODE; // nodes per chunk edge
export const NODE_AREA = (NODE * NODE) / 1e6; // km²
/** Window radius of a hydro solve, in chunks. */
export const WIN_CHUNKS = 3;
/** Nodes kept around the solved chunk: the support of its blend weight. */
export const CORE_PAD = NODES / 2;
export const CORE = NODES + 2 * CORE_PAD;

/** Receiver codes (besides D8 directions 0..7). */
export const REC_NONE = -1;
export const REC_EXIT = -2;

export const DX = [1, 1, 0, -1, -1, -1, 0, 1];
export const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const DIST = DX.map((dx, i) => Math.hypot(dx, DY[i]) * NODE);

/** Fill gradient (m per m) so that filled flats still drain. */
const EPS = 1e-4;
/** Minimum channel slope. */
const S_MIN = 3e-4;

const MIN_PRE_S = 64;
/** Route → accumulate → carve passes per solve. */
const EROSION_PASSES = 4;
/** A receiver is replaced only by a neighbour this many times steeper. */
const KEEP_RATIO = 1.5;
/** Hillslope limiter allows slightly more than the erosion threshold slope. */
const HILL_LIMIT = 1.15;

/**
 * Blend weight of the window centred on chunk `c` at global node coordinate `g`
 * (one axis): cos² falling from 1 at the chunk centre to 0 one chunk away.
 * Neighbouring weights sum to 1 (cos² + sin²), and unlike a linear tent the slope
 * is zero at both ends, so blended surfaces have no creases along those lines.
 */
export function blendWeight(c: number, g: number): number {
  const t = Math.abs(g - (c * NODES + (NODES - 1) / 2)) / NODES;
  if (t >= 1) return 0;
  const k = Math.cos((Math.PI / 2) * t);
  return k * k;
}

export interface PreResult {
  zPre: Float32Array;
  R: Float32Array;
}

/** Uplift surface and region for chunk (cx, cy) at node resolution. */
export function generatePre(cx: number, cy: number, view: SeedView): PreResult {
  const t = new Terrain(view);
  const zPre = new Float32Array(NODES * NODES);
  const R = new Float32Array(NODES * NODES);
  const f = new Float64Array(4);
  for (let j = 0; j < NODES; j++)
    for (let i = 0; i < NODES; i++) {
      const x = cx * CHUNK + i * NODE;
      const y = cy * CHUNK + j * NODE;
      t.fields(x, y, f);
      const k = j * NODES + i;
      R[k] = f[0];
      zPre[k] = t.elevationWith(x, y, f[0], f[1], f[2], f[3], MIN_PRE_S) + upliftOf(f[0]);
    }
  return { zPre, R };
}

export function channelSlope(A: number, R: number): number {
  const s = erodeK(R) / Math.sqrt(A);
  const smax = erodeSmax(R);
  return s > smax ? smax : s < S_MIN ? S_MIN : s;
}

// ---------------------------------------------------------------------------
// Coarse estimate

export const COARSE = 256;
/**
 * Coarse solves run on a fixed lattice of overlapping tiles (TILE_N nodes, centres
 * TILE_STRIDE apart) and are blended bilinearly between tile centres. The coarse
 * base level is thus a pure function of the (long-retained) coarse seeds, and every
 * fine solve sees the same values — no per-window disagreement about base level.
 */
export const TILE_STRIDE = 40;
const TILE_N = 2 * TILE_STRIDE + 1;
/** World distance from a point to the far edge of any tile that can influence it. */
export const COARSE_REACH = 2 * TILE_STRIDE * COARSE;
const COARSE_AREA = (COARSE * COARSE) / 1e6;

interface Coarse {
  ox: number; // world x of node 0
  oy: number;
  n: number;
  zE: Float32Array;
  A: Float32Array;
  rec: Int8Array;
}

function coarseTile(t: Terrain, tx: number, ty: number): Coarse {
  const n = TILE_N;
  const ox = tx * TILE_STRIDE * COARSE;
  const oy = ty * TILE_STRIDE * COARSE;
  const N = n * n;
  const zPre = new Float32Array(N);
  const R = new Float32Array(N);
  const zE = new Float32Array(N);
  const A = new Float32Array(N);
  const rec = new Int8Array(N).fill(REC_NONE);
  const seen = new Uint8Array(N);
  const order = new Int32Array(N);
  const f = new Float64Array(4);
  const heap = new MinHeap(4 * n);

  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = ox + i * COARSE;
      const y = oy + j * COARSE;
      t.fields(x, y, f);
      R[k] = f[0];
      zPre[k] = t.elevationWith(x, y, f[0], f[1], f[2], f[3], 1024) + upliftOf(f[0]);
      if (i === 0 || j === 0 || i === n - 1 || j === n - 1) {
        const key = Math.max(Math.min(zPre[k], baseField(f[0], f[1])), zPre[k] - maxIncisionOf(f[0]));
        zE[k] = key;
        rec[k] = REC_EXIT;
        seen[k] = 1;
        heap.push(k, key);
      }
    }
  let m = 0;
  const key = new Float32Array(N);
  while (heap.size) {
    const kk = heap.peekKey();
    const c = heap.pop();
    key[c] = kk;
    order[m++] = c;
    const ci = c % n;
    const cj = (c - ci) / n;
    for (let d = 0; d < 8; d++) {
      const i = ci + DX[d];
      const j = cj + DY[d];
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const q = j * n + i;
      if (seen[q]) continue;
      seen[q] = 1;
      rec[q] = (d + 4) & 7; // points back to c
      heap.push(q, Math.max(zPre[q], kk + EPS * DIST[d] * (COARSE / NODE)));
    }
  }
  for (let o = m - 1; o >= 0; o--) {
    const c = order[o];
    A[c] += COARSE_AREA;
    const r = rec[c];
    if (r >= 0) A[c + DY[r] * n + DX[r]] += A[c];
  }
  for (let o = 0; o < m; o++) {
    const c = order[o];
    const r = rec[c];
    if (r < 0) continue;
    const q = c + DY[r] * n + DX[r];
    const d = DIST[r] * (COARSE / NODE);
    const S = channelSlope(A[c], R[c]);
    zE[c] = Math.max(zE[q] + EPS * d, Math.min(zPre[c], zE[q] + S * d));
  }
  return { ox, oy, n, zE, A, rec };
}

function tileZ(c: Coarse, x: number, y: number): number {
  const u = Math.min(c.n - 1.001, Math.max(0, (x - c.ox) / COARSE));
  const v = Math.min(c.n - 1.001, Math.max(0, (y - c.oy) / COARSE));
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const k = j * c.n + i;
  const z = c.zE;
  return (z[k] * (1 - fu) + z[k + 1] * fu) * (1 - fv) + (z[k + c.n] * (1 - fu) + z[k + c.n + 1] * fu) * fv;
}

/** Coarse tiles survive across solves (per worker), keyed by tile + seed hash. */
const tileCache = new Map<string, Coarse>();
const TILE_CACHE_MAX = 24;

/** Hash of every coarse seed a tile's terrain can depend on. */
function tileSignature(view: SeedView, tx: number, ty: number): number {
  const s = TILE_STRIDE * COARSE;
  const x0 = tx * s - MAX_WARP;
  const y0 = ty * s - MAX_WARP;
  const x1 = (tx + 2) * s + MAX_WARP;
  const y1 = (ty + 2) * s + MAX_WARP;
  let h = 0x811c9dc5;
  for (const S of COARSE_SPACINGS) {
    const L = view.lattice(S);
    for (let iy = Math.floor(y0 / S); iy <= Math.floor(y1 / S) + 1; iy++)
      for (let ix = Math.floor(x0 / S); ix <= Math.floor(x1 / S) + 1; ix++) h = hash3(h ^ L.seed(ix, iy), ix, iy);
  }
  return h;
}

/** Blended coarse eroded surface over a fixed tile lattice. */
class CoarseField {
  constructor(
    private readonly t: Terrain,
    private readonly view: SeedView,
  ) {}

  private readonly local = new Map<string, Coarse>();

  tile(tx: number, ty: number): Coarse {
    const lk = `${tx},${ty}`;
    const hit = this.local.get(lk);
    if (hit) return hit;
    const k = `${lk}:${tileSignature(this.view, tx, ty)}`;
    let c = tileCache.get(k);
    if (c) {
      tileCache.delete(k); // refresh LRU position
    } else {
      c = coarseTile(this.t, tx, ty);
      if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
    }
    tileCache.set(k, c);
    this.local.set(lk, c);
    return c;
  }

  /** Tile whose centre is nearest to (x, y). */
  nearest(x: number, y: number): Coarse {
    const s = TILE_STRIDE * COARSE;
    return this.tile(Math.round(x / s) - 1, Math.round(y / s) - 1);
  }

  z(x: number, y: number): number {
    const s = TILE_STRIDE * COARSE;
    const a = Math.floor(x / s);
    const b = Math.floor(y / s);
    const fu = x / s - a;
    const fv = y / s - b;
    // Tile (a-1) is centred at a·s, tile a at (a+1)·s.
    return (
      (1 - fu) * (1 - fv) * tileZ(this.tile(a - 1, b - 1), x, y) +
      fu * (1 - fv) * tileZ(this.tile(a, b - 1), x, y) +
      (1 - fu) * fv * tileZ(this.tile(a - 1, b), x, y) +
      fu * fv * tileZ(this.tile(a, b), x, y)
    );
  }
}

// ---------------------------------------------------------------------------
// Window solve

export interface HydroWindow {
  /** Global node coordinates of window node (0, 0). */
  gx: number;
  gy: number;
  w: number;
  h: number;
  zPre: Float32Array;
  R: Float32Array;
}

/** What a window solve keeps: chunk ± CORE_PAD nodes (CORE² each). */
export interface HydroCore {
  zE: Float32Array;
  A: Float32Array;
  rec: Int8Array;
  lake: Float32Array;
}

export interface HydroResult {
  core: HydroCore;
  stats: { lakes: number; inflows: number; cyclesBroken: number; fills: number };
}

/** Lake requirements: filled depth and area (nodes). */
const LAKE_MIN_DEPTH = 1.5;
const LAKE_MIN_NODES = 25;
/** Chance that a chunk has one dammed lake, by region. */
const LAKES_PER_CHUNK = (R: number) => (R > 0.8 ? 0.12 : R > 0.52 ? 0.05 : R > 0.25 ? 0.06 : 0.07);
/** Valley floors for channels with A above this (km²). */
const FLOOR_MIN_A = 0.5;
const FLOOR_MAX_HALF = 180;
const WALL_FOOT = 40;
/** Nodes with at least this drainage area (km²) are treated as channels. */
const CHANNEL_A = 0.04;

/** Valley floor half-width coefficient (m per sqrt(km²)) and floor gradient, by region. */
function floorParams(R: number): [number, number] {
  // lowland: broad floodplains; hills/low mountains: narrow floors; alpine: glacial U-floors.
  if (R < 0.25) return [34, 0.004];
  if (R < 0.52) return [24, 0.008];
  if (R < 0.8) return [17, 0.012];
  return [26, 0.018];
}

export function solveHydro(win: HydroWindow, cx: number, cy: number, view: SeedView): HydroResult {
  const { w, h, gx, gy, zPre, R } = win;
  const N = w * h;
  const t = new Terrain(view);
  const field = new CoarseField(t, view);
  const coarse = field.nearest((cx + 0.5) * CHUNK, (cy + 0.5) * CHUNK);

  const zE = new Float32Array(N);
  const A = new Float32Array(N);
  const rec = new Int8Array(N).fill(REC_NONE);
  const lake = new Float32Array(N).fill(NaN);
  const inflow = new Float32Array(N);
  const isInflow = new Uint8Array(N);
  const seen = new Uint8Array(N);
  const order = new Int32Array(N);
  const key = new Float64Array(N);
  const heap = new MinHeap(4 * (w + h));

  const worldX = (i: number) => (gx + i) * NODE;
  const worldY = (j: number) => (gy + j) * NODE;
  const onEdge = (i: number, j: number) => i === 0 || j === 0 || i === w - 1 || j === h - 1;
  const recIdx = (k: number): number => {
    const r = rec[k];
    if (r < 0) return -1;
    const i = (k % w) + DX[r];
    const j = Math.floor(k / w) + DY[r];
    if (i < 0 || j < 0 || i >= w || j >= h) return -1;
    return j * w + i;
  };
  // Randomness is tied to place, not to the solve: overlapping solves must agree on
  // how a node routes and where lakes are. Seeds come from each chunk's seed.
  const nodeSeeds = view.lattice(NODE);
  const nodeRand = (k: number) => nodeSeeds.seed(gx + (k % w), gy + Math.floor(k / w)) / 4294967296;
  const chunkSeeds = view.lattice(CHUNK);

  // --- Big rivers entering the window (from the coarse solution) -------------
  const x0 = worldX(0);
  const y0 = worldY(0);
  const x1 = worldX(w - 1);
  const y1 = worldY(h - 1);
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  let inflows = 0;
  for (let k = 0; k < coarse.n * coarse.n; k++) {
    const r = coarse.rec[k];
    if (r < 0 || coarse.A[k] < 2) continue;
    const ci = k % coarse.n;
    const cj = (k - ci) / coarse.n;
    const ax = coarse.ox + ci * COARSE;
    const ay = coarse.oy + cj * COARSE;
    const bx = ax + DX[r] * COARSE;
    const by = ay + DY[r] * COARSE;
    if (inside(ax, ay) || !inside(bx, by)) continue;
    const ei = Math.round((Math.min(x1, Math.max(x0, ax)) - x0) / NODE);
    const ej = Math.round((Math.min(y1, Math.max(y0, ay)) - y0) / NODE);
    let best = -1;
    for (let s = -8; s <= 8; s++) {
      const vertical = ei === 0 || ei === w - 1;
      const i = vertical ? ei : Math.min(w - 1, Math.max(0, ei + s));
      const j = vertical ? Math.min(h - 1, Math.max(0, ej + s)) : ej;
      const q = j * w + i;
      if (best < 0 || zPre[q] < zPre[best]) best = q;
    }
    inflow[best] += coarse.A[k];
    isInflow[best] = 1;
    inflows++;
  }

  // --- Outlets and priority-flood ---------------------------------------------
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      if (!onEdge(i, j)) continue;
      const k = j * w + i;
      if (isInflow[k]) continue;
      const z = Math.max(Math.min(zPre[k], field.z(worldX(i), worldY(j))), zPre[k] - maxIncisionOf(R[k]));
      zE[k] = z;
      rec[k] = REC_EXIT;
      seen[k] = 1;
      key[k] = z;
      heap.push(k, z);
    }
  let m = 0;
  while (heap.size) {
    const c = heap.pop();
    order[m++] = c;
    const kc = key[c];
    const ci = c % w;
    const cj = (c - ci) / w;
    for (let d = 0; d < 8; d++) {
      const i = ci + DX[d];
      const j = cj + DY[d];
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const q = j * w + i;
      if (seen[q]) continue;
      seen[q] = 1;
      rec[q] = (d + 4) & 7;
      key[q] = Math.max(zPre[q], kc + EPS * DIST[d]);
      heap.push(q, key[q]);
    }
  }

  // --- Receivers: stochastic steepest descent on the filled surface -----------
  // Flood order alone gives straight D8 lines on smooth slopes. A random lower
  // neighbour weighted by slope² lets flow lines wander and merge (dendritic).
  for (let o = 0; o < m; o++) {
    const c = order[o];
    if (rec[c] === REC_EXIT) continue;
    const ci = c % w;
    const cj = (c - ci) / w;
    let total = 0;
    const wts = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let d = 0; d < 8; d++) {
      const i = ci + DX[d];
      const j = cj + DY[d];
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const drop = key[c] - key[j * w + i];
      if (drop <= 0) continue;
      const sl = drop / DIST[d];
      wts[d] = sl * sl;
      total += wts[d];
    }
    if (total <= 0) continue;
    let r = nodeRand(c) * total;
    for (let d = 0; d < 8; d++) {
      r -= wts[d];
      if (wts[d] > 0 && r <= 0) {
        rec[c] = d;
        break;
      }
    }
  }

  // --- Erosion passes ------------------------------------------------------------
  let cyclesBroken = 0;
  const donorStart = new Int32Array(N + 1);
  const donorFill = new Int32Array(N);
  const donors = new Int32Array(N);
  /** Receivers-before-donors order via a donor-stack traversal from base nodes. O(N). */
  const buildOrder = (): number => {
    donorStart.fill(0);
    for (let k = 0; k < N; k++) {
      const q = recIdx(k);
      if (q >= 0) donorStart[q + 1]++;
    }
    for (let k = 0; k < N; k++) donorStart[k + 1] += donorStart[k];
    donorFill.set(donorStart.subarray(0, N));
    for (let k = 0; k < N; k++) {
      const q = recIdx(k);
      if (q >= 0) donors[donorFill[q]++] = k;
    }
    let n = 0;
    for (let k = 0; k < N; k++) {
      if (recIdx(k) >= 0) continue;
      order[n++] = k;
      for (let p = n - 1; p < n; p++) {
        const c = order[p];
        for (let e = donorStart[c]; e < donorStart[c + 1]; e++) order[n++] = donors[e];
      }
    }
    if (n !== N) {
      // Shouldn't happen (receivers always point strictly downhill); be safe anyway.
      const inOrder = new Uint8Array(N);
      for (let o = 0; o < n; o++) inOrder[order[o]] = 1;
      for (let k = 0; k < N; k++)
        if (!inOrder[k]) {
          rec[k] = REC_NONE;
          cyclesBroken++;
          return buildOrder();
        }
    }
    return n;
  };
  const routeSteepest = () => {
    for (let c = 0; c < N; c++) {
      if (rec[c] === REC_EXIT || !Number.isNaN(lake[c])) continue;
      const ci = c % w;
      const cj = (c - ci) / w;
      let bestD = -1;
      let bestS = 0;
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const sl = (zE[c] - zE[j * w + i]) / DIST[d];
        if (sl > bestS) {
          bestS = sl;
          bestD = d;
        }
      }
      // Keep the current receiver while it's still downhill and not clearly worse:
      // on flats all slopes tie, and re-picking would snap streams to grid lines.
      const cur = rec[c];
      if (cur >= 0 && bestD >= 0 && cur !== bestD) {
        const i = ci + DX[cur];
        const j = cj + DY[cur];
        if (i >= 0 && j >= 0 && i < w && j < h) {
          const sl = (zE[c] - zE[j * w + i]) / DIST[cur];
          if (sl > 0 && sl * KEEP_RATIO >= bestS) continue;
        }
      }
      rec[c] = bestD >= 0 ? bestD : REC_NONE;
    }
  };
  const accumulate = () => {
    A.fill(0);
    for (let o = m - 1; o >= 0; o--) {
      const c = order[o];
      A[c] += NODE_AREA + inflow[c];
      const q = recIdx(c);
      if (q >= 0) A[q] += A[c];
    }
  };
  const carve = () => {
    for (let o = 0; o < m; o++) {
      const c = order[o];
      if (!Number.isNaN(lake[c])) continue;
      const q = recIdx(c);
      if (q < 0) continue; // outlet or pit
      const d = DIST[rec[c]];
      const S = channelSlope(A[c], R[c]);
      zE[c] = Math.max(zE[q] + EPS * d, Math.min(zPre[c], zE[q] + S * d));
    }
  };
  for (let it = 0; it < EROSION_PASSES; it++) {
    if (it > 0) {
      routeSteepest();
      m = buildOrder();
    }
    accumulate();
    carve();
  }

  // --- Dammed lakes ------------------------------------------------------------
  // Erosion drains almost every depression, but real valleys hold lakes behind
  // riegels, moraines and landslides. Every chunk in the window gets the same
  // (seeded) chance and dam height in every solve that covers it.
  let lakes = 0;
  for (let ccy = 0; ccy < h / NODES; ccy++)
    for (let ccx = 0; ccx < w / NODES; ccx++) {
      const qcx = gx / NODES + ccx;
      const qcy = gy / NODES + ccy;
      const rand = rng(chunkSeeds.seed(qcx, qcy) ^ 0x6c616b65);
      const own0 = ccy * NODES * w + ccx * NODES;
      const Rc = R[own0 + (NODES / 2) * w + NODES / 2];
      if (rand() >= LAKES_PER_CHUNK(Rc)) continue;
      // Site: the candidate channel node with the smallest place-bound random value.
      let site = -1;
      let siteR = Infinity;
      for (let j = 0; j < NODES; j++)
        for (let i = 0; i < NODES; i++) {
          const k = own0 + j * w + i;
          if (!Number.isNaN(lake[k]) || A[k] < 0.2 || A[k] > 40 || recIdx(k) < 0) continue;
          const r = nodeRand(k);
          if (r < siteR) {
            siteR = r;
            site = k;
          }
        }
      if (site < 0) continue;
      const [h0, h1] = Rc > 0.8 ? [6, 25] : Rc > 0.52 ? [3, 12] : Rc > 0.25 ? [2, 6] : [1.5, 4];
      const level = zE[site] + h0 + rand() * (h1 - h0);
      const parent = new Map<number, number>([[site, site]]);
      const members: number[] = [];
      const queue = [site];
      let ok = true;
      while (queue.length && ok) {
        const c = queue.pop()!;
        const ci = c % w;
        const cj = (c - ci) / w;
        for (let d = 0; d < 8 && ok; d++) {
          const i = ci + DX[d];
          const j = cj + DY[d];
          if (i < 0 || j < 0 || i >= w || j >= h) {
            ok = false; // reaches the window edge: can't tell where it spills
            break;
          }
          const q = j * w + i;
          if (parent.has(q) || zE[q] >= level) continue;
          if (zE[q] <= zE[site]) {
            // Lower ground beside the lake, other than below the dam itself: it leaks.
            if (c !== site && recIdx(site) !== q) ok = false;
            continue;
          }
          if (members.length > 4000) {
            ok = false;
            break;
          }
          parent.set(q, c);
          members.push(q);
          queue.push(q);
        }
      }
      if (!ok || members.length < LAKE_MIN_NODES) continue;
      for (const c of members) {
        zE[c] = level;
        lake[c] = level;
        const pc = parent.get(c)!;
        for (let d = 0; d < 8; d++) if ((Math.floor(c / w) + DY[d]) * w + (c % w) + DX[d] === pc) rec[c] = d;
      }
      lakes++;
    }

  // --- Natural lakes: large filled depressions -----------------------------------
  const comp = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  const members: number[] = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (comp[s0] >= 0 || !Number.isNaN(lake[s0]) || zE[s0] - zPre[s0] <= 0.3) continue;
    members.length = 0;
    stack.push(s0);
    comp[s0] = s0;
    let depth = 0;
    let level = -Infinity;
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      depth = Math.max(depth, zE[c] - zPre[c]);
      level = Math.max(level, zE[c]);
      const ci = c % w;
      const cj = (c - ci) / w;
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const q = j * w + i;
        if (comp[q] >= 0 || !Number.isNaN(lake[q]) || zE[q] - zPre[q] <= 0.3) continue;
        comp[q] = s0;
        stack.push(q);
      }
    }
    if (members.length < LAKE_MIN_NODES || depth < LAKE_MIN_DEPTH) continue;
    for (const c of members) {
      zE[c] = level;
      lake[c] = level;
    }
    lakes++;
  }

  // --- Valley floors around big rivers ---------------------------------------
  const lowered = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (A[c] < FLOOR_MIN_A || !Number.isNaN(lake[c])) continue;
    const [kw, slope] = floorParams(R[c]);
    const half = Math.min(FLOOR_MAX_HALF, kw * Math.sqrt(A[c]));
    if (half < NODE) continue;
    const smax = erodeSmax(R[c]);
    const rad = Math.ceil((half + WALL_FOOT + 3 * NODE) / NODE);
    const ci = c % w;
    const cj = (c - ci) / w;
    const zc = zE[c];
    for (let dj = -rad; dj <= rad; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= h) continue;
      for (let di = -rad; di <= rad; di++) {
        const i = ci + di;
        if (i < 0 || i >= w) continue;
        const q = j * w + i;
        if (!Number.isNaN(lake[q])) continue;
        const dist = Math.hypot(di, dj) * NODE;
        // Floor, then a concave foot (slope ramps up over WALL_FOOT) into the valley wall.
        const e = dist - half;
        const wall = e <= 0 ? 0 : e < WALL_FOOT ? (smax * e * e) / (2 * WALL_FOOT) : smax * (e - WALL_FOOT / 2);
        const target = zc + slope * dist + wall;
        if (target < zE[q]) {
          zE[q] = target;
          lowered[q] = 1;
        }
      }
    }
  }

  // --- Threshold hillslopes in every direction ----------------------------------
  // Carving bounds each node only against its own receiver, so ridges between a
  // deep valley and a hanging one can keep 100 m steps. Lower every hillslope node
  // to at most Smax·d above any neighbour (lower envelope from low points).
  {
    const lim = new MinHeap(N);
    for (let k = 0; k < N; k++) lim.push(k, zE[k]);
    while (lim.size) {
      const kz = lim.peekKey();
      const c = lim.pop();
      if (kz !== zE[c]) continue; // stale entry
      const ci = c % w;
      const cj = (c - ci) / w;
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const q = j * w + i;
        if (!Number.isNaN(lake[q]) || A[q] >= CHANNEL_A || rec[q] === REC_EXIT) continue;
        const cand = zE[c] + erodeSmax(R[q]) * HILL_LIMIT * DIST[d];
        if (cand < zE[q] - 1e-3) {
          zE[q] = cand;
          rec[q] = (d + 4) & 7;
          lowered[q] = 1;
          lim.push(q, zE[q]); // the stored (float32) value, so the stale check matches
        }
      }
    }
  }

  // Land beside a lake can't sit below its level (except the outflowing river).
  for (let c = 0; c < N; c++) {
    if (!lowered[c] || A[c] >= CHANNEL_A) continue;
    const ci = c % w;
    const cj = (c - ci) / w;
    for (let d = 0; d < 8; d++) {
      const i = ci + DX[d];
      const j = cj + DY[d];
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const L = lake[j * w + i];
      if (!Number.isNaN(L) && zE[c] < L + 0.3) zE[c] = L + 0.3;
    }
  }
  // Lowered channels must still run downhill (downstream first).
  for (let o = 0; o < m; o++) {
    const c = order[o];
    if (!lowered[c] || A[c] < CHANNEL_A) continue;
    const q = recIdx(c);
    if (q < 0) continue;
    const lim = zE[q] + EPS * DIST[rec[c]];
    if (zE[c] < lim) zE[c] = lim;
  }

  // --- Final drainage guarantee ----------------------------------------------
  // Post-processing can leave nodes without a lower neighbour; water collecting
  // there would draw streams that just stop. A last priority-flood from the outlets
  // fills such pits by a hair and routes them on; downhill receivers to already
  // settled nodes are kept, so every receiver points at an earlier-settled node.
  let fills = 0;
  {
    const fill = new MinHeap(4 * (w + h));
    const done = new Uint8Array(N);
    for (let k = 0; k < N; k++)
      if (rec[k] === REC_EXIT) {
        done[k] = 1;
        fill.push(k, zE[k]);
      }
    while (fill.size) {
      const c = fill.pop();
      const ci = c % w;
      const cj = (c - ci) / w;
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const q = j * w + i;
        if (done[q]) continue;
        done[q] = 1;
        const tq = recIdx(q);
        const keep = tq >= 0 && done[tq] && zE[tq] < zE[q];
        if (!keep) {
          const min = zE[c] + EPS * DIST[d];
          if (zE[q] < min) {
            if (min - zE[q] > 0.5) fills++;
            zE[q] = min;
            if (!Number.isNaN(lake[q])) lake[q] = zE[q];
          }
          rec[q] = (d + 4) & 7;
        }
        fill.push(q, zE[q]);
      }
    }
  }
  m = buildOrder();
  accumulate();

  // --- Output: the core ----------------------------------------------------------
  const off = WIN_CHUNKS * NODES - CORE_PAD;
  const core: HydroCore = {
    zE: new Float32Array(CORE * CORE),
    A: new Float32Array(CORE * CORE),
    rec: new Int8Array(CORE * CORE),
    lake: new Float32Array(CORE * CORE),
  };
  for (let j = 0; j < CORE; j++)
    for (let i = 0; i < CORE; i++) {
      const k = (off + j) * w + off + i;
      const o = j * CORE + i;
      core.zE[o] = zE[k];
      core.A[o] = A[k];
      core.rec[o] = rec[k];
      core.lake[o] = lake[k];
    }
  return { core, stats: { lakes, inflows, cyclesBroken, fills } };
}
