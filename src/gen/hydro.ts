import { CHUNK } from '../lib/constants';
import { hash3, rng } from '../lib/hash';
import { MinHeap } from '../lib/heap';
import { gnoise } from '../lib/noise';
import { COARSE_SPACINGS, MAX_WARP, type SeedView, TERRAIN_COARSE_MAX } from './seeds';
import { baseField, erodeK, erodeSmax, maxIncisionOf, regionOverrideKey, Terrain, upliftOf } from './terrain';

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
export const WIN_CHUNKS = 2;
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
  /**
   * zPre minus the uplifted terrain truncated at MIN_PRE_S (smooth). The DEM adds back
   * the detail below MIN_PRE_S as full terrain + uplift − (zPre − off).
   */
  off: Float32Array;
}

/**
 * Cost of crossing filled ground, exp(MEANDER_GAIN · noise) with noise from these
 * octaves ([spacing, weight, lattice offset x, y as fractions of the spacing]).
 */
const MEANDER_OCTAVES: [number, number, number, number][] = [
  [128, 0.55, 0.31, 0.77],
  [64, 0.35, 0.53, 0.19],
  [32, 0.2, 0.89, 0.41],
];
const MEANDER_GAIN = 3;
const MEANDER_MIN = 0.25;
const SALT_MEANDER = 0x6f1d2b3a;

/**
 * Meander costs of a chunk's nodes. A pure function of place and the chunk seeds
 * around it (the octaves are at most CHUNK, so their lattice points lie within one
 * chunk), so every window covering the chunk shares them: cached per worker, keyed by
 * those seeds.
 */
const fillCostCache = new Map<string, Float32Array>();
const FILL_COST_CACHE_MAX = 4096;
function chunkFillCost(view: SeedView, cx: number, cy: number): Float32Array {
  const L = view.lattice(CHUNK);
  let key = `${cx},${cy}`;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) key += `,${L.seed(cx + dx, cy + dy)}`;
  let f = fillCostCache.get(key);
  if (f) {
    fillCostCache.delete(key); // refresh LRU position
  } else {
    f = new Float32Array(NODES * NODES);
    const lat = MEANDER_OCTAVES.map(([S, , ox, oy]) => view.shifted(S, ox * S, oy * S));
    for (let j = 0; j < NODES; j++)
      for (let i = 0; i < NODES; i++) {
        const x = (cx * NODES + i) * NODE;
        const y = (cy * NODES + j) * NODE;
        let n = 0;
        for (let o = 0; o < lat.length; o++) n += MEANDER_OCTAVES[o][1] * gnoise(lat[o], SALT_MEANDER + o, x, y);
        // At least MEANDER_MIN: a fill step must still register in float32 heights.
        f[j * NODES + i] = Math.max(MEANDER_MIN, Math.exp(MEANDER_GAIN * n));
      }
    if (fillCostCache.size >= FILL_COST_CACHE_MAX) fillCostCache.delete(fillCostCache.keys().next().value!);
  }
  fillCostCache.set(key, f);
  return f;
}

/** Octaves at or above this spacing are the coarse solve's; the fine solve adds the rest. */
const COARSE_MIN_S = 512;

/**
 * Surface the fine solve erodes, for chunk (cx, cy) at node resolution: the coarse
 * eroded surface plus the terrain detail between MIN_PRE_S and COARSE_MIN_S. Fine
 * solves therefore refine the coarse valley network instead of growing their own,
 * and the displayed terrain agrees with the coarse field roads and settlements plan on.
 */
export function generatePre(cx: number, cy: number, view: SeedView): PreResult {
  const t = new Terrain(view);
  const field = new CoarseField(t, view);
  const zPre = new Float32Array(NODES * NODES);
  const R = new Float32Array(NODES * NODES);
  const off = new Float32Array(NODES * NODES);
  const f = new Float64Array(4);
  for (let j = 0; j < NODES; j++)
    for (let i = 0; i < NODES; i++) {
      const x = cx * CHUNK + i * NODE;
      const y = cy * CHUNK + j * NODE;
      t.fields(x, y, f);
      const k = j * NODES + i;
      R[k] = f[0];
      const mid = t.elevationWith(x, y, f[0], f[1], f[2], f[3], MIN_PRE_S);
      const low = t.elevationWith(x, y, f[0], f[1], f[2], f[3], COARSE_MIN_S);
      zPre[k] = field.z(x, y) + mid - low;
      off[k] = zPre[k] - (mid + upliftOf(f[0]));
    }
  return { zPre, R, off };
}

export function channelSlope(A: number, R: number): number {
  const s = erodeK(R) / Math.sqrt(A);
  const smax = erodeSmax(R);
  return s > smax ? smax : s < S_MIN ? S_MIN : s;
}

// ---------------------------------------------------------------------------
// Coarse estimate

export const COARSE = 128;
/**
 * Coarse solves run on a fixed lattice of overlapping tiles (TILE_N nodes, centres
 * TILE_STRIDE apart) and are blended bilinearly between tile centres. The coarse
 * base level is thus a pure function of the (long-retained) coarse seeds, and every
 * fine solve sees the same values — no per-window disagreement about base level.
 *
 * Known limitation: every tile drains to its own edges, so overlapping tiles
 * disagree (dev/tilespread.ts: ~50 m in lowlands, 120–190 m in hills and mountains),
 * and where they disagree on a valley floor the blend can hold a closed basin, which
 * window solves breach, turn into lakes, or (beyond ~6 km) fill (see coarseBasins).
 * Tried without success: tile edges from a coarser regional solve (tiles agree
 * better, but draining through fewer outlets lifts much of the land onto plateaus,
 * at ~5× the cost); a second pass with edges from the first's blend (worse); tiles
 * solved 5–10 km beyond their blended part (barely better); edges at the base level
 * without the incision clamp (no better).
 */
export const TILE_STRIDE = 80;
const TILE_N = 2 * TILE_STRIDE + 1;
/** World distance from a point to the far edge of any tile that can influence it. */
export const COARSE_REACH = 2 * TILE_STRIDE * COARSE;
const COARSE_AREA = (COARSE * COARSE) / 1e6;
const SCALE = COARSE / NODE;
/** Slow terrain fields are evaluated every this many nodes (TILE_N − 1 must divide). */
const FIELD_NODES = 4;
/** Steepest gradient given to filled coarse depressions (m per m). */
const FLOOR_S = 0.003;

export interface Coarse {
  ox: number; // world x of node 0
  oy: number;
  n: number;
  zE: Float32Array;
  A: Float32Array;
  rec: Int8Array;
}

function coarseTile(t: Terrain, view: SeedView, tx: number, ty: number): Coarse {
  const n = TILE_N;
  const ox = tx * TILE_STRIDE * COARSE;
  const oy = ty * TILE_STRIDE * COARSE;
  const N = n * n;
  // Flow randomness from the coarse seeds of the smallest resolved octave.
  const seeds = view.coarse(COARSE_MIN_S);
  const zPre = new Float32Array(N);
  const R = new Float32Array(N);
  const zE = new Float32Array(N);
  const A = new Float32Array(N);
  const rec = new Int8Array(N).fill(REC_NONE);
  const seen = new Uint8Array(N);
  const order = new Int32Array(N);
  const f = new Float64Array(4);
  const heap = new MinHeap(4 * n);

  // Slow fields (region, base level, warp) vary over kilometres: evaluate them every
  // FIELD_NODES nodes and interpolate, as terrainGrid does.
  const fw = (n - 1) / FIELD_NODES + 1;
  const fg = new Float64Array(fw * fw * 4);
  for (let b = 0; b < fw; b++)
    for (let a = 0; a < fw; a++) t.fields(ox + a * FIELD_NODES * COARSE, oy + b * FIELD_NODES * COARSE, fg, (b * fw + a) * 4);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = ox + i * COARSE;
      const y = oy + j * COARSE;
      const a = Math.min(fw - 2, Math.floor(i / FIELD_NODES));
      const b = Math.min(fw - 2, Math.floor(j / FIELD_NODES));
      const u = i / FIELD_NODES - a;
      const v = j / FIELD_NODES - b;
      const g = (b * fw + a) * 4;
      for (let c = 0; c < 4; c++)
        f[c] = (fg[g + c] * (1 - u) + fg[g + 4 + c] * u) * (1 - v) + (fg[g + fw * 4 + c] * (1 - u) + fg[g + fw * 4 + 4 + c] * u) * v;
      R[k] = f[0];
      zPre[k] = t.elevationWith(x, y, f[0], f[1], f[2], f[3], COARSE_MIN_S) + upliftOf(f[0]);
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
      heap.push(q, Math.max(zPre[q], kk + EPS * DIST[d] * SCALE));
    }
  }
  // Stochastic steepest descent on the filled surface, as in window solves: flood
  // order alone draws valleys as straight grid lines. Lower neighbours were popped
  // earlier, so `order` stays receivers-first. Randomness is bound to the node's
  // world position, so overlapping tiles agree.
  const wts = new Float64Array(8);
  for (let o = 0; o < m; o++) {
    const c = order[o];
    if (rec[c] === REC_EXIT) continue;
    const ci = c % n;
    const cj = (c - ci) / n;
    let total = 0;
    for (let d = 0; d < 8; d++) {
      wts[d] = 0;
      const i = ci + DX[d];
      const j = cj + DY[d];
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const drop = key[c] - key[j * n + i];
      if (drop <= 0) continue;
      const sl = drop / DIST[d];
      wts[d] = sl * sl;
      total += wts[d];
    }
    if (total <= 0) continue;
    const gx = tx * TILE_STRIDE + ci;
    const gy = ty * TILE_STRIDE + cj;
    const seed = seeds.seed(Math.floor((gx * COARSE) / COARSE_MIN_S), Math.floor((gy * COARSE) / COARSE_MIN_S));
    let r = (hash3(seed ^ 0x2ec3, gx, gy) / 4294967296) * total;
    for (let d = 0; d < 8; d++) {
      r -= wts[d];
      if (wts[d] > 0 && r <= 0) {
        rec[c] = d;
        break;
      }
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
    const d = DIST[r] * SCALE;
    const S = channelSlope(A[c], R[c]);
    // Filled depressions become graded floors rather than dead flats: fine solves
    // would cross a flat in straight lines.
    zE[c] = Math.max(zE[q] + Math.max(EPS, Math.min(S, FLOOR_S)) * d, Math.min(zPre[c], zE[q] + S * d));
  }
  // Threshold hillslopes in every direction, as window solves do: carving bounds a
  // node only against its receiver, and window solves would otherwise cut the
  // difference away, leaving the coarse field above the land shown. Receivers (and
  // so areas) stay; a last pass in flow order keeps every channel draining.
  // The lower envelope by alternating raster sweeps (a chamfer transform), repeated
  // until nothing changes: far cheaper than a priority queue over every node.
  const step = new Float32Array(N);
  for (let k = 0; k < N; k++) step[k] = erodeSmax(R[k]) * HILL_LIMIT * NODE * SCALE;
  for (let sweep = 0, changed = true; changed && sweep < 16; sweep++) {
    changed = false;
    const fwd = sweep % 2 === 0;
    for (let o = 0; o < N; o++) {
      const q = fwd ? o : N - 1 - o;
      if (rec[q] === REC_EXIT) continue;
      const qi = q % n;
      const qj = (q - qi) / n;
      let z = zE[q];
      // Neighbours already visited in this sweep's order.
      for (let d = fwd ? 4 : 0; d < (fwd ? 8 : 4); d++) {
        const i = qi + DX[d];
        const j = qj + DY[d];
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const cand = zE[j * n + i] + step[q] * (d & 1 ? Math.SQRT2 : 1);
        if (cand < z) z = cand;
      }
      if (z < zE[q] - 1e-3) {
        zE[q] = z;
        changed = true;
      }
    }
  }
  for (let o = 0; o < m; o++) {
    const c = order[o];
    const r = rec[c];
    if (r < 0) continue;
    const q = c + DY[r] * n + DX[r];
    const min = zE[q] + EPS * DIST[r] * SCALE;
    if (zE[c] < min) zE[c] = min;
  }
  return { ox, oy, n, zE, A, rec };
}

/** Cubic B-spline weights for fractional offset t (nodes floor-1 .. floor+2). */
function bsplineW(t: number, out: Float64Array, o: number): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[o] = (1 - 3 * t + 3 * t2 - t3) / 6;
  out[o + 1] = (3 * t3 - 6 * t2 + 4) / 6;
  out[o + 2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  out[o + 3] = t3 / 6;
}

const tileW = new Float64Array(8);

/**
 * Cubic B-spline through the tile's nodes. It smooths rather than interpolates:
 * bilinear would leave the D8 valleys as straight creases along the grid, which
 * fine solves (whose surface starts from this one) would then follow.
 */
function tileZ(c: Coarse, x: number, y: number): number {
  const u = Math.min(c.n - 2.001, Math.max(1, (x - c.ox) / COARSE));
  const v = Math.min(c.n - 2.001, Math.max(1, (y - c.oy) / COARSE));
  const i = Math.floor(u);
  const j = Math.floor(v);
  bsplineW(u - i, tileW, 0);
  bsplineW(v - j, tileW, 4);
  const z = c.zE;
  let s = 0;
  for (let b = 0; b < 4; b++) {
    const row = (j - 1 + b) * c.n + i - 1;
    s += tileW[4 + b] * (tileW[0] * z[row] + tileW[1] * z[row + 1] + tileW[2] * z[row + 2] + tileW[3] * z[row + 3]);
  }
  return s;
}

/** One tile's own surface at (x, y), unblended (dev/tilespread.ts). */
export const tileZForDebug = (c: Coarse, x: number, y: number) => tileZ(c, x, y);

/** Coarse tiles survive across solves (per worker), keyed by tile + seed hash. */
const tileCache = new Map<string, Coarse>();
/** (A net cell reads ~110–130 tiles; the manager hands workers those of every cell it needs.) */
const TILE_CACHE_MAX = 256;

/**
 * Tiles are shared between workers (the manager's `tile` tasks): one worker makes a
 * tile and returns it with its cache key, the others adopt it. The key holds every
 * seed the tile depends on, so an adopted tile is the one the worker would make.
 */
export function shareCoarseTile(view: SeedView, tx: number, ty: number): { key: string; tile: Coarse } {
  const tile = new CoarseField(new Terrain(view), view).tile(tx, ty);
  return { key: tileKey(view, tx, ty), tile };
}
export function adoptCoarseTile(key: string, tile: Coarse): void {
  if (tileCache.has(key)) return;
  if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
  tileCache.set(key, tile);
}

/** Hash of every coarse seed a tile's terrain can depend on. */
function tileSignature(view: SeedView, tx: number, ty: number): number {
  const s = TILE_STRIDE * COARSE;
  const x0 = tx * s - MAX_WARP;
  const y0 = ty * s - MAX_WARP;
  const x1 = (tx + 2) * s + MAX_WARP;
  const y1 = (ty + 2) * s + MAX_WARP;
  let h = 0x811c9dc5;
  for (const S of COARSE_SPACINGS) {
    if (S > TERRAIN_COARSE_MAX) continue;
    const L = view.coarse(S);
    for (let iy = Math.floor(y0 / S); iy <= Math.floor(y1 / S) + 1; iy++)
      for (let ix = Math.floor(x0 / S); ix <= Math.floor(x1 / S) + 1; ix++) h = hash3(h ^ L.seed(ix, iy), ix, iy);
  }
  return h;
}

/** Identity of a coarse tile object (the tile cache returns the same object for the same surface). */
const tileIds = new WeakMap<object, number>();
let nextTileId = 1;
export const tileId = (o: object) => {
  let id = tileIds.get(o);
  if (id === undefined) tileIds.set(o, (id = nextTileId++));
  return id;
};
/** Coarse heights on the COARSE grid per square between tile centres (see zGrid), per worker. */
const gridCache = new Map<string, Float32Array>();
const GRID_CACHE_MAX = 256;

const tileKey = (view: SeedView, tx: number, ty: number) => `${tx},${ty}:${regionOverrideKey()}:${tileSignature(view, tx, ty)}`;

/**
 * Per worker: the key (seed signature) each tile position was last resolved with. It
 * changes only where the seeds under a tile were forgotten and made anew, and then
 * everything cached from the coarse surface is stale: the epoch moves on.
 */
const tileKeyAt = new Map<number, string>();
let coarseEpoch = 0;
function newCoarseEpoch(): void {
  coarseEpoch++;
  tileKeyAt.clear();
}
/** Changes whenever caches built from the coarse surface (per worker, beyond one task) must be dropped. */
export const coarseEpochNow = () => coarseEpoch;
/**
 * Before reusing such caches with a new payload: moves the epoch on if any tile
 * resolved before has other seeds in this payload. (Tiles the payload doesn't cover
 * are skipped: this task can't read anything that depends on them.)
 */
function checkCoarseSeeds(view: SeedView): void {
  if (tileKeyAt.size > 4096) return newCoarseEpoch();
  for (const [lk, k] of tileKeyAt) {
    const tx = Math.floor(lk / 65536) - 32768;
    const ty = (lk % 65536) - 32768;
    let now: string;
    try {
      now = tileKey(view, tx, ty);
    } catch {
      continue; // seeds not in the payload
    }
    if (now !== k) return newCoarseEpoch();
  }
}

/** Blended coarse eroded surface over a fixed tile lattice. */
export class CoarseField {
  constructor(
    private readonly t: Terrain,
    private readonly view: SeedView,
  ) {}

  private readonly local = new Map<number, Coarse>();
  /** The last tile returned, by key (most lookups repeat it). */
  private lastKey = NaN;
  private last: Coarse | undefined;

  tile(tx: number, ty: number): Coarse {
    const lk = (tx + 32768) * 65536 + ty + 32768;
    if (lk === this.lastKey) return this.last!;
    let hit = this.local.get(lk);
    if (!hit) {
      hit = this.resolve(lk, tx, ty);
      this.local.set(lk, hit);
    }
    this.lastKey = lk;
    this.last = hit;
    return hit;
  }

  /** See checkCoarseSeeds. */
  checkSeeds(): void {
    checkCoarseSeeds(this.view);
  }

  private resolve(lk: number, tx: number, ty: number): Coarse {
    const k = tileKey(this.view, tx, ty);
    const prev = tileKeyAt.get(lk);
    if (prev !== undefined && prev !== k) newCoarseEpoch();
    tileKeyAt.set(lk, k);
    let c = tileCache.get(k);
    if (c) {
      tileCache.delete(k); // refresh LRU position
    } else {
      c = coarseTile(this.t, this.view, tx, ty);
      if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
    }
    tileCache.set(k, c);
    return c;
  }

  /** Coarse eroded elevation from the nearest tile only (smaller reach than `z`). */
  zNearest(x: number, y: number): number {
    return tileZ(this.nearest(x, y), x, y);
  }

  /** Coarse drainage area (km²) at the node nearest (x, y), from the nearest tile. */
  area(x: number, y: number): number {
    const c = this.nearest(x, y);
    const i = Math.min(c.n - 1, Math.max(0, Math.round((x - c.ox) / COARSE)));
    const j = Math.min(c.n - 1, Math.max(0, Math.round((y - c.oy) / COARSE)));
    return c.A[j * c.n + i];
  }

  /** Tile whose centre is nearest to (x, y). */
  nearest(x: number, y: number): Coarse {
    const s = TILE_STRIDE * COARSE;
    return this.tile(Math.round(x / s) - 1, Math.round(y / s) - 1);
  }

  /**
   * `z` at world (gi·COARSE, gj·COARSE), as float32: cached per worker for each
   * square between tile centres, keyed by the four tiles it blends.
   */
  zGrid(gi: number, gj: number): number {
    const a = Math.floor(gi / TILE_STRIDE);
    const b = Math.floor(gj / TILE_STRIDE);
    const key = (a + 32768) * 65536 + b + 32768;
    let g = this.lastGrid;
    if (key !== this.lastGridKey) {
      g = this.grids.get(key);
      if (!g) {
        const ts = [this.tile(a - 1, b - 1), this.tile(a, b - 1), this.tile(a - 1, b), this.tile(a, b)];
        const k = `${a},${b}:${ts.map(tileId).join(',')}`;
        g = gridCache.get(k);
        if (g) gridCache.delete(k); // refresh LRU position
        else {
          g = new Float32Array(TILE_STRIDE * TILE_STRIDE).fill(NaN);
          if (gridCache.size >= GRID_CACHE_MAX) gridCache.delete(gridCache.keys().next().value!);
        }
        gridCache.set(k, g);
        this.grids.set(key, g);
      }
      this.lastGridKey = key;
      this.lastGrid = g;
    }
    const o = (gj - b * TILE_STRIDE) * TILE_STRIDE + gi - a * TILE_STRIDE;
    let z = g![o];
    if (Number.isNaN(z)) z = g![o] = this.z(gi * COARSE, gj * COARSE);
    return z;
  }
  private readonly grids = new Map<number, Float32Array>();
  private lastGridKey = NaN;
  private lastGrid: Float32Array | undefined;

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

export interface CoarseBasins {
  /** Grid cell (i, j) is centred at world ((g0x + i)·COARSE, (g0y + j)·COARSE). */
  g0x: number;
  g0y: number;
  gw: number;
  gh: number;
  /** Lake level of a cell in a lake basin, else NaN. */
  level: Float32Array;
  /** Lowering of the surface (≤ 0, m) along breach channels. */
  cut: Float32Array;
  /** Depth of the coarse fill at each cell (m; > 0 in closed basins). */
  depth: Float32Array;
  /** Basin cells by outcome: 1 lake, 2 breached, 3 too close to the grid's edge, 4 too big to breach. */
  kind: Uint8Array;
}

/**
 * Closed basins of the coarse surface around a window (see LAKE_REACH). A pure
 * function of the coarse surface for every basin clear of the grid's edge, so every
 * window whose blend weight reaches such a basin treats it alike.
 *
 * Deep, compact basins are lakes at their spill level. The others are breached: a
 * channel from the basin's lowest cell to its saddle, over the lowest ground (not
 * the straight line a flat fill would give), and on downhill until the ground falls
 * below it, falling gently all the way, and every pocket of the basin floor carved
 * to drain into it. Channels step between edge-sharing cells only: interpolated
 * across a diagonal step, a cut would leave a dam halfway.
 */
export function coarseBasins(field: CoarseField, x0: number, y0: number, x1: number, y1: number): CoarseBasins {
  const g0x = Math.floor((x0 - LAKE_REACH) / COARSE);
  const g0y = Math.floor((y0 - LAKE_REACH) / COARSE);
  const gw = Math.ceil((x1 + LAKE_REACH) / COARSE) - g0x + 1;
  const gh = Math.ceil((y1 + LAKE_REACH) / COARSE) - g0y + 1;
  const gn = gw * gh;
  const gz = new Float32Array(gn);
  const fill = new Float32Array(gn);
  const seen = new Uint8Array(gn);
  const heap = new MinHeap(4 * (gw + gh));
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      gz[k] = field.zGrid(g0x + i, g0y + j);
      if (i === 0 || j === 0 || i === gw - 1 || j === gh - 1) {
        fill[k] = gz[k];
        seen[k] = 1;
        heap.push(k, gz[k]);
      }
    }
  while (heap.size) {
    const c = heap.pop();
    const ci = c % gw;
    const cj = (c - ci) / gw;
    for (let d = 0; d < 8; d++) {
      const i = ci + DX[d];
      const j = cj + DY[d];
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const q = j * gw + i;
      if (seen[q]) continue;
      seen[q] = 1;
      fill[q] = Math.max(gz[q], fill[c]);
      heap.push(q, fill[q]);
    }
  }

  const level = new Float32Array(gn).fill(NaN);
  const cut = new Float32Array(gn);
  const kind = new Uint8Array(gn);
  const comp = new Int32Array(gn).fill(-1);
  const cells: number[] = [];
  const cost = new Float64Array(gn);
  const from = new Int32Array(gn);
  const D4 = [0, 2, 4, 6];
  const filled = (k: number) => fill[k] - gz[k] > 0;
  for (let s0 = 0; s0 < gn; s0++) {
    if (comp[s0] >= 0 || !filled(s0)) continue;
    // The basin: connected filled cells (cells are in row-major world order, so the
    // lowest-index choices below are the same in every window).
    cells.length = 0;
    cells.push(s0);
    comp[s0] = s0;
    let pit = s0;
    let i0 = gw, i1 = 0, j0 = gh, j1 = 0;
    for (let p = 0; p < cells.length; p++) {
      const c = cells[p];
      const ci = c % gw;
      const cj = (c - ci) / gw;
      i0 = Math.min(i0, ci);
      i1 = Math.max(i1, ci);
      j0 = Math.min(j0, cj);
      j1 = Math.max(j1, cj);
      if (gz[c] < gz[pit] || (gz[c] === gz[pit] && c < pit)) pit = c;
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const q = j * gw + i;
        if (comp[q] >= 0 || !filled(q)) continue;
        comp[q] = s0;
        cells.push(q);
      }
    }
    const m = LAKE_GRID_MARGIN;
    if (i0 < m || j0 < m || i1 >= gw - m || j1 >= gh - m) {
      for (const c of cells) kind[c] = 3;
      continue;
    }
    const depth = fill[pit] - gz[pit];
    if (depth >= LAKE_DEEP && i1 - i0 < LAKE_MAX_CELLS && j1 - j0 < LAKE_MAX_CELLS) {
      for (const c of cells) {
        level[c] = fill[c];
        kind[c] = 1;
      }
      continue;
    }
    // Breach. Saddle: the lowest cell beside the basin (4-neighbours).
    let saddle = -1;
    for (const c of cells) {
      const ci = c % gw;
      const cj = (c - ci) / gw;
      for (const d of D4) {
        const q = (cj + DY[d]) * gw + ci + DX[d];
        if (comp[q] === s0) continue;
        if (saddle < 0 || gz[q] < gz[saddle] || (gz[q] === gz[saddle] && q < saddle)) saddle = q;
      }
    }
    // Cheapest 4-connected path from the pit to the saddle, paying for height above
    // the pit (and a little for length), so it keeps to the basin floor.
    // (Anywhere in the basin's box plus one cell: the basin is 8-connected, a
    // 4-connected path may have to step outside it, paying for the height.)
    for (let j = j0 - 1; j <= j1 + 1; j++) for (let i = i0 - 1; i <= i1 + 1; i++) cost[j * gw + i] = Infinity;
    cost[pit] = 0;
    from[pit] = -1;
    const pq = new MinHeap(64);
    pq.push(pit, 0);
    while (pq.size) {
      const kc = pq.peekKey();
      const c = pq.pop();
      if (kc > cost[c]) continue;
      if (c === saddle) break;
      const ci = c % gw;
      const cj = (c - ci) / gw;
      for (const d of D4) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < i0 - 1 || j < j0 - 1 || i > i1 + 1 || j > j1 + 1) continue;
        const q = j * gw + i;
        const nc = cost[c] + Math.max(0, gz[q] - gz[pit]) + 1;
        if (nc < cost[q]) {
          cost[q] = nc;
          from[q] = c;
          pq.push(q, nc);
        }
      }
    }
    for (const c of cells) kind[c] = 4;
    if (cost[saddle] === Infinity) continue;
    const path: number[] = [];
    for (let c = saddle; c >= 0; c = from[c]) path.push(c);
    path.reverse();
    // On downhill from the saddle (lowest 4-neighbour) until below the channel.
    const onPath = new Set(path);
    for (let n = 0; n < BREACH_MAX_OUT; n++) {
      const c = path[path.length - 1];
      if (gz[c] < gz[pit] - BREACH_FALL * (path.length - 1)) break;
      const ci = c % gw;
      const cj = (c - ci) / gw;
      let next = -1;
      for (const d of D4) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const q = j * gw + i;
        if (comp[q] === s0 || onPath.has(q)) continue;
        if (next < 0 || gz[q] < gz[next]) next = q;
      }
      if (next < 0) break;
      path.push(next);
      onPath.add(next);
    }
    let bi0 = i0, bi1 = i1, bj0 = j0, bj1 = j1;
    for (const c of path) {
      const ci = c % gw;
      const cj = (c - ci) / gw;
      bi0 = Math.min(bi0, ci);
      bi1 = Math.max(bi1, ci);
      bj0 = Math.min(bj0, cj);
      bj1 = Math.max(bj1, cj);
    }
    if (bi1 - bi0 >= BREACH_MAX_CELLS || bj1 - bj0 >= BREACH_MAX_CELLS) continue;
    for (const c of cells) kind[c] = 2;
    // The channel, then every other basin cell drained into it: a priority-flood
    // up from the channel, where a cell lower than the one reaching it (a pocket of
    // the basin floor) has its way back carved down to below it.
    const surf = new Map<number, number>();
    const via = new Map<number, number>();
    const fq = new MinHeap(64);
    for (let p = 0; p < path.length; p++) {
      const c = path[p];
      const t = Math.min(gz[c], gz[pit] - BREACH_FALL * p);
      surf.set(c, t);
      via.set(c, -1);
      fq.push(c, t);
    }
    while (fq.size) {
      const kc = fq.peekKey();
      const c = fq.pop();
      if (kc !== surf.get(c)) continue; // stale entry
      const ci = c % gw;
      const cj = (c - ci) / gw;
      for (let d = 0; d < 8; d++) {
        const q = (cj + DY[d]) * gw + ci + DX[d];
        if (comp[q] !== s0 || surf.has(q)) continue;
        surf.set(q, gz[q]);
        via.set(q, c);
        fq.push(q, gz[q]);
        let t = gz[q] - BREACH_FALL;
        for (let x = c; x >= 0 && surf.get(x)! > t; x = via.get(x)!, t -= BREACH_FALL) {
          surf.set(x, t);
          fq.push(x, t);
        }
      }
    }
    for (const [c, t] of surf) if (t < gz[c]) cut[c] = Math.min(cut[c], t - gz[c]);
  }
  const depth = new Float32Array(gn);
  for (let k = 0; k < gn; k++) depth[k] = fill[k] - gz[k];
  return { g0x, g0y, gw, gh, level, cut, depth, kind };
}

/** Bilinear value of a basin grid array at world (x, y). */
function basinAt(b: CoarseBasins, a: Float32Array, x: number, y: number): number {
  const u = x / COARSE - b.g0x;
  const v = y / COARSE - b.g0y;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const k = j * b.gw + i;
  return (a[k] * (1 - fu) + a[k + 1] * fu) * (1 - fv) + (a[k + b.gw] * (1 - fu) + a[k + b.gw + 1] * fu) * fv;
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
  /** `lakes` kept; `drained`: lakes whose rim was cut away (see below). */
  stats: { lakes: number; drained: number; inflows: number; cyclesBroken: number; fills: number };
}

/** Lake requirements: filled depth and area (nodes). */
const LAKE_MIN_DEPTH = 1.5;
const LAKE_MIN_NODES = 25;
/**
 * Lakes must lie at least this many nodes from the window edge. Every window whose
 * blend weight matters near such a lake then sees the whole basin and agrees about
 * it; bigger basins would be a lake in one window and drained in the next, giving
 * straight, chunk-aligned shores. They stay as filled flats (wetland) instead.
 * Half a chunk with ±2-chunk windows: a whole chunk (as with ±3) dropped about half
 * the lakes of lowland and hills, and straight shores along chunk lines were no rarer.
 */
const LAKE_EDGE_MARGIN = NODES / 2;
/** Chance that a chunk has one dammed lake, by region. */
const LAKES_PER_CHUNK = (R: number) => (R > 0.8 ? 0.12 : R > 0.52 ? 0.05 : R > 0.25 ? 0.06 : 0.07);
/**
 * A lake is drained where its rim ends up this far below its level (m), along at
 * least BREACH_MIN_NODES shore nodes and BREACH_SHARE of its shore.
 */
const LAKE_BREACH = 1;
const BREACH_MIN_NODES = 3;
const BREACH_SHARE = 0.1;
/**
 * Closed basins of the coarse surface (where overlapping coarse tiles disagree, the
 * blend can hold them), found on a world-aligned grid of COARSE cells reaching
 * LAKE_REACH beyond the window; only basins LAKE_GRID_MARGIN cells clear of the
 * grid's edge count. Basins at least LAKE_DEEP deep and at most LAKE_MAX_CELLS across
 * become lakes; the others are breached.
 */
export const LAKE_REACH = 6144;
const LAKE_GRID_MARGIN = 8;
const LAKE_DEEP = 10;
const LAKE_MAX_CELLS = 24;
/** Coarse lakes end where the coarse surface comes within this of their level (m). */
export const LAKE_SHORE_DROP = 0.5;
/** Fine depressions are breached where that cuts at most this deep (m). */
const BREACH_FINE_DEPTH = 4;
/** Fall of a breach channel per cell (m). */
const BREACH_FALL = 0.02;
/** A breach channel ends this many cells past the saddle at most. */
const BREACH_MAX_OUT = 12;
/**
 * Basin and breach channel together span at most LAKE_REACH: every window blending a
 * node within reach then has all of it well inside its grid (whose edge lies
 * LAKE_REACH + 1 km beyond any node it blends), so all of them cut alike. Bigger
 * basins stay filled.
 */
const BREACH_MAX_CELLS = LAKE_REACH / COARSE;
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

/** Valley floors: distance (m) of node offsets up to FLOOR_RAD nodes. */
const FLOOR_RAD = Math.ceil((FLOOR_MAX_HALF + WALL_FOOT + 3 * NODE) / NODE);
const FLOOR_SIDE = 2 * FLOOR_RAD + 1;
const FLOOR_DIST = new Float64Array(FLOOR_SIDE * FLOOR_SIDE);
for (let dj = -FLOOR_RAD; dj <= FLOOR_RAD; dj++)
  for (let di = -FLOOR_RAD; di <= FLOOR_RAD; di++) FLOOR_DIST[(dj + FLOOR_RAD) * FLOOR_SIDE + di + FLOOR_RAD] = Math.hypot(di, dj) * NODE;

/**
 * Indices 0..n-1 ordered by height z (index order on ties; -0 counts as 0), by a
 * stable radix sort on the float32 bits.
 */
function sortByHeight(z: Float32Array, n: number): Uint32Array {
  const f = new Float32Array(n);
  for (let k = 0; k < n; k++) f[k] = z[k] + 0; // -0 → 0
  const u = new Uint32Array(f.buffer);
  // Order-preserving map of float bits to unsigned integers.
  for (let k = 0; k < n; k++) u[k] = u[k] & 0x80000000 ? ~u[k] >>> 0 : (u[k] | 0x80000000) >>> 0;
  let idx = new Uint32Array(n);
  let tmp = new Uint32Array(n);
  for (let k = 0; k < n; k++) idx[k] = k;
  const count = new Uint32Array(2048);
  for (let shift = 0; shift < 32; shift += 11) {
    count.fill(0);
    for (let k = 0; k < n; k++) count[(u[idx[k]] >>> shift) & 2047]++;
    for (let b = 0, sum = 0; b < 2048; b++) {
      const c = count[b];
      count[b] = sum;
      sum += c;
    }
    for (let k = 0; k < n; k++) tmp[count[(u[idx[k]] >>> shift) & 2047]++] = idx[k];
    [idx, tmp] = [tmp, idx];
  }
  return idx;
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
  // Column and row of every node, and the index offset of each direction (no % or /
  // in the hot loops).
  const col = new Int32Array(N);
  const row = new Int32Array(N);
  for (let k = 0; k < N; k++) {
    col[k] = k % w;
    row[k] = (k - col[k]) / w;
  }
  const OFS = DX.map((dx, d) => DY[d] * w + dx);
  const recIdx = (k: number): number => {
    const r = rec[k];
    if (r < 0) return -1;
    const i = col[k] + DX[r];
    const j = row[k] + DY[r];
    if (i < 0 || j < 0 || i >= w || j >= h) return -1;
    return k + OFS[r];
  };
  // Randomness is tied to place, not to the solve: overlapping solves must agree on
  // how a node routes and where lakes are. Seeds come from each chunk's seed.
  const nodeSeeds = view.lattice(NODE);
  const nodeRand = (k: number) => nodeSeeds.seed(gx + col[k], gy + row[k]) / 4294967296;
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

  // Filled ground (flats behind dams too deep to breach) drains along the cheapest way
  // to its spill point. At uniform cost that is a straight line, the same for every
  // stream entering the flat, so they crossed it side by side in parallel straight
  // lines. A smoothly varying cost makes them wander and gather into the cheap
  // corridors, as streams do on a floodplain. Bound to place, like all randomness here.
  const fillCost = new Float32Array(N);
  for (let ccy = 0; ccy < h / NODES; ccy++)
    for (let ccx = 0; ccx < w / NODES; ccx++) {
      const f = chunkFillCost(view, gx / NODES + ccx, gy / NODES + ccy);
      for (let j = 0; j < NODES; j++) fillCost.set(f.subarray(j * NODES, (j + 1) * NODES), (ccy * NODES + j) * w + ccx * NODES);
    }

  // --- Closed coarse basins (see coarseBasins) --------------------------------------
  // Breach channels cut into the surface this solve erodes; lakes come after erosion.
  const basins = coarseBasins(field, x0, y0, x1, y1);
  for (let k = 0; k < N; k++) {
    const c = basinAt(basins, basins.cut, worldX(k % w), worldY(Math.floor(k / w)));
    if (c < 0) zPre[k] += c;
  }

  // Depressions are breached rather than filled where that cuts no deeper than
  // BREACH_FINE_DEPTH (the fine terrain detail leaves dams of a metre or two along
  // coarse valleys and breach channels, and filling behind them leaves flats that
  // streams cross in straight lines). Deeper ones fill (and may become lakes).
  const breachable = (q: number, c: number, d: number): boolean => {
    let t = zPre[q] - EPS * DIST[d];
    for (let x = c; key[x] > t; ) {
      if (zPre[x] - t > BREACH_FINE_DEPTH) return false;
      const r = rec[x];
      if (r < 0) return true;
      t -= EPS * DIST[r];
      x += OFS[r];
    }
    return true;
  };

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
    const ci = col[c];
    const cj = row[c];
    for (let d = 0; d < 8; d++) {
      const i = ci + DX[d];
      const j = cj + DY[d];
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const q = j * w + i;
      if (seen[q]) continue;
      seen[q] = 1;
      rec[q] = (d + 4) & 7;
      key[q] = Math.max(zPre[q], kc + EPS * DIST[d] * fillCost[q]);
      if (key[q] > zPre[q] && breachable(q, c, d)) {
        // Shallow dam: carve the way out down below q instead of filling behind it.
        key[q] = zPre[q];
        let t = zPre[q] - EPS * DIST[d];
        for (let x = c; key[x] > t; ) {
          key[x] = t;
          const r = rec[x];
          if (r < 0) break;
          t -= EPS * DIST[r];
          x += OFS[r];
        }
      }
      heap.push(q, key[q]);
    }
  }
  // Carved ways are part of the surface eroded from here on.
  for (let k = 0; k < N; k++) if (key[k] < zPre[k]) zPre[k] = key[k];

  const awayFromEdge = (nodes: number[]) =>
    nodes.every((k) => {
      const i = k % w;
      const j = (k - i) / w;
      return i >= LAKE_EDGE_MARGIN && j >= LAKE_EDGE_MARGIN && i < w - LAKE_EDGE_MARGIN && j < h - LAKE_EDGE_MARGIN;
    });

  // --- Receivers: stochastic steepest descent on the filled surface -----------
  // Flood order alone gives straight D8 lines on smooth slopes. A random lower
  // neighbour weighted by slope² lets flow lines wander and merge (dendritic).
  const wts = new Float64Array(8);
  for (let o = 0; o < m; o++) {
    const c = order[o];
    if (rec[c] === REC_EXIT) continue;
    const ci = col[c];
    const cj = row[c];
    let total = 0;
    for (let d = 0; d < 8; d++) {
      wts[d] = 0;
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
  /** Receiver index of each node (recIdx), as of the last buildOrder. */
  const ri = new Int32Array(N);
  /** Receivers-before-donors order via a donor-stack traversal from base nodes. O(N). */
  const buildOrder = (): number => {
    donorStart.fill(0);
    for (let k = 0; k < N; k++) {
      const q = recIdx(k);
      ri[k] = q;
      if (q >= 0) donorStart[q + 1]++;
    }
    for (let k = 0; k < N; k++) donorStart[k + 1] += donorStart[k];
    donorFill.set(donorStart.subarray(0, N));
    for (let k = 0; k < N; k++) {
      const q = ri[k];
      if (q >= 0) donors[donorFill[q]++] = k;
    }
    let n = 0;
    for (let k = 0; k < N; k++) {
      if (ri[k] >= 0) continue;
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
      const ci = col[c];
      const cj = row[c];
      let bestD = -1;
      let bestS = 0;
      if (ci > 0 && cj > 0 && ci < w - 1 && cj < h - 1) {
        for (let d = 0; d < 8; d++) {
          const sl = (zE[c] - zE[c + OFS[d]]) / DIST[d];
          if (sl > bestS) {
            bestS = sl;
            bestD = d;
          }
        }
      } else
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
      const q = ri[c];
      if (q >= 0) A[q] += A[c];
    }
  };
  // channelSlope's region parameters, per node.
  const kR = new Float64Array(N);
  const smaxR = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    kR[k] = erodeK(R[k]);
    smaxR[k] = erodeSmax(R[k]);
  }
  const carve = () => {
    for (let o = 0; o < m; o++) {
      const c = order[o];
      if (!Number.isNaN(lake[c])) continue;
      const q = ri[c];
      if (q < 0) continue; // outlet or pit
      const d = DIST[rec[c]];
      const s = kR[c] / Math.sqrt(A[c]);
      const S = s > smaxR[c] ? smaxR[c] : s < S_MIN ? S_MIN : s; // channelSlope
      zE[c] = Math.max(zE[q] + EPS * d * fillCost[c], Math.min(zPre[c], zE[q] + S * d));
    }
  };
  // Breaching lowered nodes the flood had already settled: order afresh.
  m = buildOrder();
  for (let it = 0; it < EROSION_PASSES; it++) {
    if (it > 0) {
      routeSteepest();
      m = buildOrder();
    }
    accumulate();
    carve();
  }

  /** Eroded height of lake nodes before they became lake. */
  const preLake = new Float32Array(N);
  // --- Dammed lakes ------------------------------------------------------------
  // Erosion drains almost every depression, but real valleys hold lakes behind
  // riegels, moraines and landslides. Every chunk in the window gets the same
  // (seeded) chance and dam height in every solve that covers it.
  let lakes = 0;
  const damSites = new Set<number>();
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
        const ci = col[c];
        const cj = row[c];
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
      if (!ok || members.length < LAKE_MIN_NODES || !awayFromEdge(members)) continue;
      for (const c of members) {
        preLake[c] = zE[c];
        zE[c] = level;
        lake[c] = level;
        const pc = parent.get(c)!;
        for (let d = 0; d < 8; d++) if (c + OFS[d] === pc) rec[c] = d;
      }
      damSites.add(site);
      lakes++;
    }

  // --- Coarse lakes ------------------------------------------------------------------
  // Deep, compact basins of the coarse surface (see coarseBasins). A node is lake
  // where a lake cell at or next to it has a level above both the node's starting
  // surface and, clearly, the coarse surface (beyond the basin the fine detail can
  // dip below the level, and past the spill the coarse floor is graded within
  // centimetres of it). Per node, without connectivity, so no window sees it
  // differently. These lakes are never drained (that is decided per window).
  const coarseLake = new Uint8Array(N);
  // (Most windows have none.)
  const anyCoarseLake = basins.level.some((L) => !Number.isNaN(L));
  for (let k = 0; anyCoarseLake && k < N; k++) {
    if (!Number.isNaN(lake[k])) continue;
    const x = worldX(k % w);
    const y = worldY(Math.floor(k / w));
    const gi = Math.round(x / COARSE) - basins.g0x;
    const gj = Math.round(y / COARSE) - basins.g0y;
    let L = NaN;
    for (let d = -1; d < 8 && Number.isNaN(L); d++) L = basins.level[d < 0 ? gj * basins.gw + gi : (gj + DY[d]) * basins.gw + gi + DX[d]];
    if (Number.isNaN(L) || zPre[k] >= L || field.z(x, y) >= L - LAKE_SHORE_DROP) continue;
    preLake[k] = zE[k];
    zE[k] = L;
    lake[k] = L;
    coarseLake[k] = 1;
  }

  // --- Natural lakes: large filled depressions -----------------------------------
  // Found on the flood-filled uneroded surface (`key`), not the eroded one. A closed
  // depression's fill level is set by its own saddle, so every solve that sees the
  // whole basin (away from its edge) finds the same lake at the same level. On the
  // eroded surface it depended on how deep each solve, with its own truncated
  // catchments, cut the outflow notch: neighbouring solves disagreed, and lakes ended
  // at chunk lines.
  const comp = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  const members: number[] = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (comp[s0] >= 0 || !Number.isNaN(lake[s0]) || key[s0] - zPre[s0] <= 0.3) continue;
    members.length = 0;
    stack.push(s0);
    comp[s0] = s0;
    let depth = 0;
    let level = -Infinity;
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      depth = Math.max(depth, key[c] - zPre[c]);
      level = Math.max(level, key[c]);
      const ci = col[c];
      const cj = row[c];
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const q = j * w + i;
        if (comp[q] >= 0 || !Number.isNaN(lake[q]) || key[q] - zPre[q] <= 0.3) continue;
        comp[q] = s0;
        stack.push(q);
      }
    }
    if (members.length < LAKE_MIN_NODES || depth < LAKE_MIN_DEPTH || !awayFromEdge(members)) continue;
    for (const c of members) {
      preLake[c] = zE[c];
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
    const smax = smaxR[c];
    const rad = Math.ceil((half + WALL_FOOT + 3 * NODE) / NODE);
    const ci = col[c];
    const cj = row[c];
    const zc = zE[c];
    for (let dj = -rad; dj <= rad; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= h) continue;
      for (let di = -rad; di <= rad; di++) {
        const i = ci + di;
        if (i < 0 || i >= w) continue;
        const q = j * w + i;
        if (!Number.isNaN(lake[q])) continue;
        const dist = FLOOR_DIST[(dj + FLOOR_RAD) * FLOOR_SIDE + di + FLOOR_RAD];
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
  // Channels are lowered too (and re-routed into the lower ground): otherwise a side
  // stream left perched above a newly carved valley stands as a one-node wall.
  // Channels beside a lake keep their course, so inflows and outflows stay intact.
  const limStep = new Float64Array(N);
  for (let k = 0; k < N; k++) limStep[k] = smaxR[k] * HILL_LIMIT;
  const limitHillslopes = () => {
    const nearLake = new Uint8Array(N);
    for (let c = 0; c < N; c++) {
      if (Number.isNaN(lake[c])) continue;
      const ci = col[c];
      const cj = row[c];
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i >= 0 && j >= 0 && i < w && j < h) nearLake[j * w + i] = 1;
      }
    }
    // Nodes that are never lowered (fixed for the whole pass: lakes, rec and A don't
    // change here other than rec of nodes that may be lowered).
    const fixed = new Uint8Array(N);
    for (let q = 0; q < N; q++) fixed[q] = !Number.isNaN(lake[q]) || rec[q] === REC_EXIT || (A[q] >= CHANNEL_A && nearLake[q]) ? 1 : 0;
    // Lowest first: every node in height order (index order on ties), merged with a
    // heap of the nodes lowered since. Pops in the same order as one heap holding them
    // all (lowered nodes were pushed later, so they lose ties), at a fraction of the cost.
    const sorted = sortByHeight(zE, N);
    const sortedKey = new Float64Array(N);
    for (let p = 0; p < N; p++) sortedKey[p] = zE[sorted[p]];
    const lim = new MinHeap(1024);
    for (let p = 0; ; ) {
      let c: number;
      let kz: number;
      if (p < N && (!lim.size || sortedKey[p] <= lim.peekKey())) {
        c = sorted[p];
        kz = sortedKey[p++];
      } else if (lim.size) {
        kz = lim.peekKey();
        c = lim.pop();
      } else break;
      if (kz !== zE[c]) continue; // stale entry
      const ci = col[c];
      const cj = row[c];
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const q = j * w + i;
        if (fixed[q]) continue;
        const cand = zE[c] + limStep[q] * DIST[d];
        if (cand < zE[q] - 1e-3) {
          zE[q] = cand;
          rec[q] = (d + 4) & 7;
          lowered[q] = 1;
          lim.push(q, zE[q]); // the stored (float32) value, so the stale check matches
        }
      }
    }
  };
  limitHillslopes();

  // --- Breached lakes ------------------------------------------------------------
  // Valley floors and the limiter lower the land around lakes, never the lakes. Where
  // that cuts through a lake's rim, the lake would hang above its surroundings (and
  // meet a neighbouring solve without it at a cliff). Drain such lakes, and let the
  // limiter lower their beds towards the breach. A low node or two is just the
  // outflow leaving through its notch (a mountain stream drops metres per node), so a
  // rim counts as cut only where a real part of the shore lies low.
  let drained = 0;
  {
    const done = new Uint8Array(N);
    const shoreSeen = new Uint8Array(N);
    const members: number[] = [];
    const shore: number[] = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (done[s0] || Number.isNaN(lake[s0]) || coarseLake[s0]) continue;
      const level = lake[s0];
      members.length = 0;
      shore.length = 0;
      members.push(s0);
      done[s0] = 1;
      for (let p = 0; p < members.length; p++) {
        const c = members[p];
        const ci = col[c];
        const cj = row[c];
        for (let d = 0; d < 8; d++) {
          const i = ci + DX[d];
          const j = cj + DY[d];
          if (i < 0 || j < 0 || i >= w || j >= h) continue;
          const q = j * w + i;
          if (lake[q] === level) {
            if (!done[q]) {
              done[q] = 1;
              members.push(q);
            }
          } else if (Number.isNaN(lake[q]) && !damSites.has(q) && !shoreSeen[q]) {
            shoreSeen[q] = 1;
            shore.push(q);
          }
        }
      }
      let low = 0;
      for (const q of shore) {
        if (zE[q] < level - LAKE_BREACH) low++;
        shoreSeen[q] = 0;
      }
      if (low < Math.max(BREACH_MIN_NODES, BREACH_SHARE * shore.length)) continue;
      // The bed goes back to the eroded ground (left at the level, it would stand
      // as a dead-flat plateau, crossed by straight streams).
      for (const c of members) {
        lake[c] = NaN;
        zE[c] = preLake[c];
      }
      drained++;
    }
    if (drained) limitHillslopes();
  }

  // Land beside a lake can't sit below its level (except the outflowing river).
  for (let c = 0; c < N; c++) {
    if (!lowered[c] || A[c] >= CHANNEL_A) continue;
    const ci = col[c];
    const cj = row[c];
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
    // Nodes whose receivers fall strictly all the way to an outlet keep them. (The
    // flood alone would keep a receiver only if reached first, and across a flat
    // the front reaches most nodes before their receivers: it re-routed every
    // stream there into a straight line from the outlet.)
    const drains = new Uint8Array(N); // 0 unknown, 1 reaches an outlet, 2 doesn't
    const chain: number[] = [];
    for (let k0 = 0; k0 < N; k0++) {
      if (drains[k0]) continue;
      chain.length = 0;
      let x = k0;
      let ok: number;
      for (;;) {
        if (drains[x]) {
          ok = drains[x];
          break;
        }
        if (rec[x] === REC_EXIT) {
          ok = 1;
          break;
        }
        chain.push(x);
        drains[x] = 2; // provisional: guards against cycles
        const q = recIdx(x);
        // Strictly downhill, or on across one lake (flat at its level).
        if (q < 0 || !(zE[q] < zE[x] || (lake[q] === lake[x] && zE[q] === zE[x]))) {
          ok = 2;
          break;
        }
        x = q;
      }
      for (const c of chain) drains[c] = ok;
    }
    const fill = new MinHeap(4 * (w + h));
    const done = new Uint8Array(N);
    for (let k = 0; k < N; k++)
      if (rec[k] === REC_EXIT) {
        done[k] = 1;
        fill.push(k, zE[k]);
      }
    while (fill.size) {
      const c = fill.pop();
      const ci = col[c];
      const cj = row[c];
      for (let d = 0; d < 8; d++) {
        const i = ci + DX[d];
        const j = cj + DY[d];
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const q = j * w + i;
        if (done[q]) continue;
        done[q] = 1;
        const tq = recIdx(q);
        const keep = drains[q] === 1 || (tq >= 0 && done[tq] && zE[tq] < zE[q]);
        if (!keep) {
          const min = zE[c] + EPS * DIST[d] * fillCost[q];
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
  return { core, stats: { lakes: lakes - drained, drained, inflows, cyclesBroken, fills } };
}
