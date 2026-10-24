import { CHUNK } from '../lib/constants';
import { hash3 } from '../lib/hash';
import { MinHeap } from '../lib/heap';
import { smoothstep } from '../lib/noise';
import { coarseEpochNow, type CoarseField, NODE } from './hydro';
import { lakesOf } from './lakes';
import {
  MAX_GRADE,
  MAX_LEN,
  NET_CELL,
  type NetCell,
  ROAD_C,
  ROAD_D,
  ROAD_N,
  ROAD_P,
  ROAD_T,
  type RoadClass,
  type RoadEdge,
  type RoadPatch,
  type Rival,
  WEDGE,
  rngEdge,
  type SegmentPath,
  type SegmentTask,
} from './roads';
import { FARM, HAMLET, type Site, type Settlements, TOWN, VILLAGE } from './settle';
import type { Terrain } from './terrain';

/**
 * Road network on a shared lattice. All roads are made of the edges of one graph:
 * a triangular lattice of vertices every LATTICE m, each jittered by a hash of its
 * position (never far enough to make edges cross). Roads can only meet at vertices,
 * so they cannot overlap, braid or cross without a junction.
 *
 *  1. Edge costs per road class: length, a soft penalty for slope against the
 *     class's limit (judged on the coarse surface over 500 m: at the scale of one
 *     edge it does not predict the map's slopes), cheaper on valley floors, a small
 *     bridge charge across streams, dear across the lakes of closed coarse basins
 *     (lakes.ts), plus a fixed tie-break so best paths are unique.
 *  2. Main roads: for each town pair (N) and village pair (D) of the relative-
 *     neighbourhood graphs, the cheapest path inside a fixed corridor around the
 *     pair, turns costing a little. The corridor makes it the same in every cell.
 *  3. Hamlet roads: the cheapest-path forest grown out from the main network; each
 *     hamlet's road follows it back, so nearby hamlets' roads merge like streams.
 *  4. Shortcuts: neighbouring settlements that the roads so far join only by a long
 *     way round get a direct minor road, or a footpath where a road would be too steep.
 *  5. Farm roads: grown like hamlet roads, from all roads so far.
 *  6. Links: neighbouring settlements, farms included, that the roads join only by
 *     a long way round get a track, or a footpath where a track would be too steep.
 *  7. Tracks: scattered points far from any road get a track back to the network,
 *     grown as one forest so nearby tracks merge.
 *
 * Output: every used lattice edge, owned by the cell holding its midpoint. Geometry
 * comes later (routeCurves): one smooth curve per edge, through the two vertices,
 * with directions at each vertex shared by the roads that continue through it, then
 * shifted up to 32 m sideways to fit the fine terrain. Tracks and footpaths are
 * drawn as straight runs instead, a few edges at a time, bent to an easy grade.
 */

export const LATTICE = 150;
const ROW = (LATTICE * Math.sqrt(3)) / 2;
/** Vertex jitter radius: well below the 0.29 × spacing at which triangles could flip. */
const JITTER = 0.22 * LATTICE;

/** Valley floors (drainage area ramp, km²) cost up to VALLEY_BONUS less. */
const VALLEY_AREA = [0.3, 4];
const VALLEY_BONUS = 0.3;
/** Turning by θ at a vertex costs TURN_COST × (1 − cos θ) (m); a sharp turn (cos θ < SHARP_COS,
 * the lattice's 120°) costs SHARP_TURN — on steep ground the fine routing makes the hairpins. */
const TURN_COST = 25;
const SHARP_COS = -0.2;
const SHARP_TURN = 400;
/** Main-road corridor: vertices with |pa| + |pb| ≤ CORRIDOR × d + CORRIDOR_EXTRA. */
const CORRIDOR = 1.3;
const CORRIDOR_EXTRA = 1000;
/** Forests reach this far (m) from the network: hamlets, then farms. The cost cap is
 * looser (steep ground costs several × its length): a remote hamlet still gets a road. */
const HAMLET_REACH = 3500;
const FARM_REACH = 1800;
const COST_CAP = 25;

/** Shortcuts: settlement pairs this far apart (m) whose way round by road is longer than
 * SHORT_RATIO × the distance; their path may be SHORT_DETOUR × it, edges up to
 * SHORT_STEEP × the class limit (else a footpath is tried). */
const SHORT_MIN = 400;
const SHORT_MAX = 2000;
const SHORT_RATIO = 2;
const SHORT_DETOUR = 1.6;
const SHORT_STEEP = 1.3;
const SHORT_EXTRA = 400;
/** A footpath (shortcut or link) may wind this much more: across a slope it follows the contours. */
const PATH_DETOUR = 1.4;
/** Links: as shortcuts, between any neighbouring settlements (farms included), as a
 * track or else a footpath. */
const LINK_MIN = 250;
const LINK_MAX = 1200;
const LINK_RATIO = 1.8;
const LINK_DETOUR = 1.5;
const LINK_EXTRA = 400;
/** How far (m) a link's path may stray from its midpoint: half its corridor's |pa| + |pb|. */
const LINK_HALF = (CORRIDOR * LINK_MAX + LINK_EXTRA) / 2;
/**
 * Grade a class would rather keep to (slope penalties of the network and of the fine
 * routing): the limit itself for roads; tracks and footpaths, driven and walked slowly,
 * traverse a slope along its contours rather than climb it straight.
 */
const EASY_GRADE = [MAX_GRADE[ROAD_N], MAX_GRADE[ROAD_D], MAX_GRADE[ROAD_C], 0.1, 0.18];
/** Tracks: share of vertices that want one, if no road within TRACK_GAP (m); not above
 * TRACK_ALT (m), nor where every way out is steeper than TRACK_STEEP; reach (m). */
const TRACK_DENSITY = 0.14;
const TRACK_GAP = 200;
const TRACK_ALT = 2300;
const TRACK_STEEP = 0.5;
const TRACK_REACH = 1200;
/** A track (or track link) whose way averages a slope penalty above this (× length) is left out. */
const TRACK_STEEPNESS = 6;
/** On ground steeper than TRACK_SPACE_SLOPE (500 m baseline), track seeds keep TRACK_SPACE (m) apart. */
const TRACK_SPACE = 300;
const TRACK_SPACE_SLOPE = 0.15;
/** Track density falls by up to TRACK_THIN over this range of slope (500 m baseline). */
const TRACK_THIN = 0.85;
const TRACK_THIN_SLOPE = [0.1, 0.35];

/** Spatial hash of points for radius queries. */
class Grid<T extends { x: number; y: number }> {
  private readonly cells = new Map<string, T[]>();
  constructor(
    items: T[],
    private readonly G: number,
  ) {
    for (const t of items) {
      const k = `${Math.floor(t.x / G)},${Math.floor(t.y / G)}`;
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k)!.push(t);
    }
  }
  near(x: number, y: number, r: number): T[] {
    const out: T[] = [];
    const G = this.G;
    for (let j = Math.floor((y - r) / G); j <= Math.floor((y + r) / G); j++)
      for (let i = Math.floor((x - r) / G); i <= Math.floor((x + r) / G); i++)
        for (const t of this.cells.get(`${i},${j}`) ?? []) if (Math.hypot(t.x - x, t.y - y) <= r) out.push(t);
    return out;
  }
}

/** Dev only: when set, main-road paths are collected here. */
export let DEBUG_PATHS: { k: RoadClass; edges: [number, number][]; field: CoarseField }[] | undefined;
/** Dev only: the terrain of the last cell built while DEBUG_PATHS is on. */
export let DEBUG_TERRAIN: Terrain | undefined;
export const debugPaths = (on: boolean) => (DEBUG_PATHS = on ? [] : undefined);
export { edgeCost, edgeGrade, neighbours };

const OFF = 1 << 20;
const SPAN = 1 << 21;
/** Vertex (i, j) packed into one number. */
const pack = (i: number, j: number) => (i + OFF) * SPAN + (j + OFF);
const vi = (v: number) => Math.floor(v / SPAN) - OFF;
const vj = (v: number) => v - Math.floor(v / SPAN) * SPAN - OFF; // (exact; % on doubles is slow)

/** Jittered world position of vertex v. */
export function vertexPos(v: number): [number, number] {
  const i = vi(v);
  const j = vj(v);
  const h = hash3(0x1a77ce, i, j);
  const a = ((h & 0xffff) / 65536) * 2 * Math.PI;
  const r = Math.sqrt((h >>> 16) / 65536) * JITTER;
  return [(i + (j & 1) * 0.5) * LATTICE + r * Math.cos(a), j * ROW + r * Math.sin(a)];
}

const NB_EVEN: [number, number][] = [[1, 0], [-1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]];
const NB_ODD: [number, number][] = [[1, 0], [-1, 0], [0, -1], [1, -1], [0, 1], [1, 1]];
function neighbours(v: number): number[] {
  const i = vi(v);
  const j = vj(v);
  return ((j & 1) !== 0 ? NB_ODD : NB_EVEN).map(([di, dj]) => pack(i + di, j + dj));
}

/** Nearest vertex to (x, y). */
export function nearestVertex(x: number, y: number): number {
  const j0 = Math.round(y / ROW);
  let best = 0;
  let bd = Infinity;
  for (let j = j0 - 1; j <= j0 + 1; j++) {
    const i0 = Math.round(x / LATTICE - (j & 1) * 0.5);
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      const v = pack(i, j);
      const [px, py] = vertexPos(v);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
  }
  return best;
}

/** Vertices whose positions fall in a rectangle. */
function verticesIn(r: { x0: number; y0: number; x1: number; y1: number }): number[] {
  const out: number[] = [];
  for (let j = Math.floor((r.y0 - JITTER) / ROW); j <= Math.ceil((r.y1 + JITTER) / ROW); j++)
    for (let i = Math.floor((r.x0 - JITTER) / LATTICE) - 1; i <= Math.ceil((r.x1 + JITTER) / LATTICE); i++) {
      const v = pack(i, j);
      const [x, y] = vertexPos(v);
      if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) out.push(v);
    }
  return out;
}

const edgeKey = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);

/**
 * Net caches, per worker and shared by every cell it builds (neighbouring cells look
 * at much the same land): terrain at vertices, edge terrain and costs, paths between
 * site pairs. All are pure functions of the coarse surface, so they hold until its
 * seeds change (coarseEpochNow; latticeCell checks a new payload's seeds).
 */
const caches = {
  epoch: -1,
  vertex: new Map<number, { x: number; y: number; z: number; area: number; valley: number; wet: boolean }>(),
  cost: new Map<number, number>(),
  terrain: new Map<number, { grade: number; local: number; stream: number }>(),
  path: new Map<string, [number, number][] | null>(),
};
/** Entries kept per cache at most (all are dropped beyond it). */
const NET_CACHE_MAX = 1_500_000;
/**
 * Beyond this many vertex and edge entries, a cell first drops those of vertices more
 * than NET_KEEP from it (a neighbouring cell reads little beyond that).
 */
const NET_PRUNE_AT = 600_000;
const NET_KEEP = 16000;
function pruneNetCaches(x0: number, y0: number, x1: number, y1: number): void {
  const c = netCaches();
  if (c.vertex.size + c.cost.size + c.terrain.size < NET_PRUNE_AT) return;
  const far = (v: number) => {
    const x = vi(v) * LATTICE;
    const y = vj(v) * ROW;
    return x < x0 - NET_KEEP || x > x1 + NET_KEEP || y < y0 - NET_KEEP || y > y1 + NET_KEEP;
  };
  for (const v of c.vertex.keys()) if (far(v)) c.vertex.delete(v);
  for (const k of c.cost.keys()) if (far(Math.floor(Math.floor(k / 5) / 9))) c.cost.delete(k);
  for (const k of c.terrain.keys()) if (far(Math.floor(k / 9))) c.terrain.delete(k);
}
function netCaches(): typeof caches {
  const e = coarseEpochNow();
  if (caches.epoch !== e || caches.cost.size > NET_CACHE_MAX || caches.vertex.size > NET_CACHE_MAX) {
    caches.vertex.clear();
    caches.cost.clear();
    caches.terrain.clear();
    caches.path.clear();
    caches.epoch = e;
  }
  return caches;
}

/** Terrain at vertices. */
function vdata(field: CoarseField, v: number) {
  const m = netCaches().vertex;
  let d = m.get(v);
  if (!d) {
    const [x, y] = vertexPos(v);
    const area = field.area(x, y);
    d = { x, y, z: field.z(x, y), area, valley: smoothstep(VALLEY_AREA[0], VALLEY_AREA[1], area), wet: lakesOf(field).wet(x, y) };
    m.set(v, d);
  }
  return d;
}

/** Direction from vertex v to its neighbour w, 0..8 (4 is v itself). */
const dirCode = (v: number, w: number) => (vj(w) - vj(v) + 1) * 3 + (vi(w) - vi(v) + 1);
/** Cost of edge u–v for a road class (symmetric). */
function edgeCost(field: CoarseField, u: number, v: number, cls: RoadClass): number {
  const m = netCaches().cost;
  const lo = Math.min(u, v);
  const ck = (lo * 9 + dirCode(lo, Math.max(u, v))) * 5 + cls;
  const hit = m.get(ck);
  if (hit !== undefined) return hit;
  const c = edgeCostRaw(field, u, v, cls);
  m.set(ck, c);
  return c;
}
/**
 * Coarse terrain along edge u–v. The coarse surface does not predict the map's
 * slopes at the scale of one edge (the detailed erosion that makes them only runs
 * near the view), so steepness is judged over a longer baseline: the slope along
 * the edge's direction across SLOPE_BASE m around its middle; also between its own
 * vertices (`local`). Plus whether it crosses a stream (much more drainage under its
 * middle than at its ends).
 */
const SLOPE_BASE = 500;
function edgeTerrain(field: CoarseField, u: number, v: number): { grade: number; local: number; stream: number } {
  const m = netCaches().terrain;
  const lo = Math.min(u, v);
  const key = lo * 9 + dirCode(lo, Math.max(u, v));
  let r = m.get(key);
  if (r) return r;
  const a = vdata(field, u);
  const b = vdata(field, v);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = ((b.x - a.x) / len) * (SLOPE_BASE / 2);
  const dy = ((b.y - a.y) / len) * (SLOPE_BASE / 2);
  const mid = field.area(mx, my);
  r = {
    grade: Math.abs(field.z(mx + dx, my + dy) - field.z(mx - dx, my - dy)) / SLOPE_BASE,
    local: Math.abs(b.z - a.z) / len,
    stream: mid > 2 * Math.max(a.area, b.area) ? mid : 0,
  };
  m.set(key, r);
  return r;
}
/** Coarse gradient around edge u–v, along it, over SLOPE_BASE. */
function edgeGrade(field: CoarseField, u: number, v: number): number {
  return edgeTerrain(field, u, v).grade;
}
/**
 * The gradient class `cls` sees on edge u–v: tracks and footpaths also the slope
 * between the edge's own vertices — the long baseline, reaching across a valley
 * floor, reads a valley side as gentle.
 */
function classGrade(field: CoarseField, u: number, v: number, cls: RoadClass): number {
  const t = edgeTerrain(field, u, v);
  return cls >= ROAD_T ? Math.max(t.grade, t.local) : t.grade;
}
/**
 * Slope penalty weight and cap (× length) by class: soft — at this scale it is only a
 * tendency. Tracks and footpaths are capped much higher: under a low cap, an edge
 * steeper still costs less per metre of height, and they ran straight down the slope
 * instead of across it.
 */
const SLOPE_W = 1.5;
const SLOPE_CAP = [6, 6, 6, 30, 12];
/** Crossing a stream draining more than BRIDGE_AREA km² costs a bridge (m), more for a river. */
const BRIDGE_AREA = 1;
const BRIDGE_COST = 40;
/** Coarse lakes: water costs LAKE_W × its length, plus LAKE_BRIDGE (m) per crossing (as the
 * fine routing, which goes round lakes the network can't see). Sampled at LAKE_SAMPLES points. */
const LAKE_W = 12;
const LAKE_BRIDGE = 150;
const LAKE_SAMPLES = 5;
function edgeCostRaw(field: CoarseField, u: number, v: number, cls: RoadClass): number {
  const a = vdata(field, u);
  const b = vdata(field, v);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const { stream } = edgeTerrain(field, u, v);
  const g = classGrade(field, u, v, cls);
  let c = len * Math.min(SLOPE_CAP[cls], 1 + SLOPE_W * (g / EASY_GRADE[cls]) ** 2);
  if (stream > BRIDGE_AREA) c += BRIDGE_COST * (1 + Math.log10(stream / BRIDGE_AREA));
  c *= 1 - (VALLEY_BONUS * (a.valley + b.valley)) / 2;
  // Water under the edge (after the valley discount: lakes lie on valley floors).
  // An edge leaving the shore pays half a crossing.
  const lakes = lakesOf(field);
  let wet = (a.wet ? 1 : 0) + (b.wet ? 1 : 0);
  for (let s = 1; s < LAKE_SAMPLES - 1; s++) {
    const t = s / (LAKE_SAMPLES - 1);
    if (lakes.wet(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) wet++;
  }
  if (wet) c += (len * LAKE_W * wet) / LAKE_SAMPLES + (wet < LAKE_SAMPLES ? LAKE_BRIDGE / 2 : 0);
  const lo = Math.min(u, v);
  const hi = Math.max(u, v);
  c *= 1 + 0.01 * (hash3(hash3(0x7e1d9, vi(lo), vj(lo)), vi(hi), vj(hi)) / 4294967296);
  return c;
}
/** No edge costs less than this × its length (for A* estimates). */
const MIN_FACTOR = 1 - VALLEY_BONUS;

export function latticeCell(gx: number, gy: number, field: CoarseField, set: Settlements, terrain?: Terrain): NetCell {
  if (DEBUG_PATHS) DEBUG_TERRAIN = terrain;
  field.checkSeeds();
  const debugSeen = new Set<string>();
  const x0 = gx * NET_CELL;
  const y0 = gy * NET_CELL;
  const x1 = x0 + NET_CELL;
  const y1 = y0 + NET_CELL;
  pruneNetCaches(x0, y0, x1, y1);
  const inBoxXY = (x: number, y: number, m: number) => x >= x0 - m && x < x1 + m && y >= y0 - m && y < y1 + m;
  const inBox = (s: { x: number; y: number }, m: number) => inBoxXY(s.x, s.y, m);
  const sitesIn = (rank: 0 | 1 | 2 | 3, m: number) => set.sitesIn(rank, x0 - m, y0 - m, x1 + m, y1 + m);
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const pos = (v: number) => vdata(field, v);

  // Regions (margins around the cell): farm roads that may pass through the cell,
  // the hamlet roads they grow from, the main roads those grow from.
  // Each stage grows from the previous one, so each needs the previous known a bit
  // further out: tracks that may cross the cell, the roads and links they grow from
  // (and keep away from), the farm roads that decide the links, the shortcuts and
  // hamlet roads those grow from, the main roads below.
  const trackM = TRACK_REACH;
  const trackForestM = trackM + TRACK_REACH;
  const linkM = trackForestM + LINK_HALF;
  const farmM = linkM + (LINK_RATIO * LINK_MAX) / 2;
  const farmForestM = farmM + FARM_REACH;
  const shortM = farmForestM + SHORT_MAX / 2;
  const hamletM = shortM + (SHORT_RATIO * SHORT_MAX) / 2;
  const hamletForestM = hamletM + HAMLET_REACH;
  const mainM = hamletForestM;

  const cls = new Map<string, { u: number; v: number; c: RoadClass }>();
  const use = (u: number, v: number, c: RoadClass) => {
    const k = edgeKey(u, v);
    const e = cls.get(k);
    if (!e) cls.set(k, { u, v, c });
    else if (c < e.c) e.c = c;
  };

  // 2. Main roads.
  const corridorR = CORRIDOR * MAX_LEN[ROAD_N] + CORRIDOR_EXTRA;
  const towns = sitesIn(TOWN, mainM + corridorR);
  const villages = sitesIn(VILLAGE, mainM + corridorR);
  /** Cheapest path a → b for class k inside the pair's corridor, turns included; its edges, or null. */
  /** Cheapest path a → b for class k inside the pair's corridor, turns included; its edges, or null. */
  const corridorPath = (k: RoadClass, a: { x: number; y: number }, b: { x: number; y: number }, extra = CORRIDOR_EXTRA): [number, number][] | null => {
    // A pure function of the pair: cached per worker, neighbouring cells reuse it.
    const ck = `${k}|${a.x},${a.y}|${b.x},${b.y}|${extra}`;
    const paths = netCaches().path;
    // (Dev: each path once per cell, whether or not an earlier cell found it.)
    const debug = (p: [number, number][] | null) => {
      if (p && k <= ROAD_D && DEBUG_PATHS && !debugSeen.has(ck)) {
        debugSeen.add(ck);
        DEBUG_PATHS.push({ k, edges: p, field });
      }
    };
    if (paths.has(ck)) {
      const hit = paths.get(ck)!;
      debug(hit);
      return hit;
    }
    const d = dist(a, b);
    const reach = CORRIDOR * d + extra;
    const va = nearestVertex(a.x, a.y);
    const vb = nearestVertex(b.x, b.y);
    // The corridor's box, indexed locally; states are local index × 9 + the code of
    // the direction the vertex was entered from (4 = the start), for turn costs.
    const R = reach / 2 + LATTICE;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const vi0 = Math.floor((mx - R) / LATTICE) - 2;
    const vj0 = Math.floor((my - R) / ROW) - 2;
    const ni = Math.ceil((mx + R) / LATTICE) + 2 - vi0 + 1;
    const nj = Math.ceil((my + R) / ROW) + 2 - vj0 + 1;
    const N = ni * nj;
    const loc = (v: number) => {
      const p0 = vi(v) - vi0;
      const q0 = vj(v) - vj0;
      return p0 < 0 || q0 < 0 || p0 >= ni || q0 >= nj ? -1 : q0 * ni + p0;
    };
    const glob = (l: number) => pack((l % ni) + vi0, Math.floor(l / ni) + vj0);
    const px = new Float64Array(N).fill(NaN);
    const py = new Float64Array(N);
    const inside = new Int8Array(N); // 0 unknown, 1 in, 2 out
    const ec = new Float64Array(N * 6).fill(-1); // edge costs by vertex and direction
    const len = new Float64Array(N * 6).fill(-1); // and lengths
    const at = (l: number) => {
      if (Number.isNaN(px[l])) {
        const q = pos(glob(l));
        px[l] = q.x;
        py[l] = q.y;
      }
    };
    const la = loc(va);
    const lb = loc(vb);
    let out: [number, number][] | null = null;
    if (la >= 0 && lb >= 0) {
      at(lb);
      const bx = px[lb];
      const by = py[lb];
      const cost = new Float64Array(N * 9).fill(Infinity);
      const prev = new Int32Array(N * 9).fill(-1);
      const done = new Uint8Array(N * 9);
      const heap = new MinHeap(256);
      at(la);
      cost[la * 9 + 4] = 0;
      heap.push(la * 9 + 4, MIN_FACTOR * Math.hypot(px[la] - bx, py[la] - by));
      let goal = -1;
      while (heap.size) {
        const st = heap.pop();
        if (done[st]) continue;
        done[st] = 1;
        const code = st % 9;
        const l = (st - code) / 9;
        if (l === lb) {
          goal = st;
          break;
        }
        const p0 = l % ni;
        const q0 = (l - p0) / ni;
        let lf = -1;
        if (code !== 4) {
          const fp = p0 + (code % 3) - 1;
          const fq = q0 + Math.floor(code / 3) - 1;
          if (fp >= 0 && fq >= 0 && fp < ni && fq < nj) lf = fq * ni + fp;
        }
        at(l);
        const c0 = cost[st];
        // The incoming edge, for turn costs.
        let ux = 0;
        let uy = 0;
        let lenIn = 0;
        if (lf >= 0) {
          at(lf);
          ux = px[l] - px[lf];
          uy = py[l] - py[lf];
          lenIn = Math.hypot(ux, uy);
        }
        const nb = ((q0 + vj0) & 1) !== 0 ? NB_ODD : NB_EVEN;
        for (let dd = 0; dd < 6; dd++) {
          const wp = p0 + nb[dd][0];
          const wq = q0 + nb[dd][1];
          if (wp < 0 || wq < 0 || wp >= ni || wq >= nj) continue;
          const lw = wq * ni + wp;
          if (lw === lf) continue;
          if (inside[lw] === 0) {
            at(lw);
            inside[lw] = Math.hypot(px[lw] - a.x, py[lw] - a.y) + Math.hypot(px[lw] - b.x, py[lw] - b.y) <= reach ? 1 : 2;
          }
          if (inside[lw] === 2) continue;
          let e = ec[l * 6 + dd];
          if (e < 0) e = ec[l * 6 + dd] = edgeCost(field, glob(l), glob(lw), k);
          let c = c0 + e;
          if (lf >= 0) {
            const wx = px[lw] - px[l];
            const wy = py[lw] - py[l];
            let lenOut = len[l * 6 + dd];
            if (lenOut < 0) lenOut = len[l * 6 + dd] = Math.hypot(wx, wy);
            const cos = (ux * wx + uy * wy) / (lenIn * lenOut);
            c += cos < SHARP_COS ? SHARP_TURN : TURN_COST * (1 - cos);
          }
          const ns = lw * 9 + (q0 - wq + 1) * 3 + (p0 - wp + 1);
          if (c >= cost[ns]) continue;
          cost[ns] = c;
          prev[ns] = st;
          heap.push(ns, c + MIN_FACTOR * Math.hypot(px[lw] - bx, py[lw] - by));
        }
      }
      if (goal >= 0) {
        out = [];
        for (let st = goal; prev[st] >= 0; st = prev[st]) out.push([glob((prev[st] - (prev[st] % 9)) / 9), glob((st - (st % 9)) / 9)]);
      }
    }
    if (paths.size > 20000) paths.delete(paths.keys().next().value!);
    paths.set(ck, out);
    debug(out);
    return out;
  };
  const mainPath = (k: RoadClass, a: Site, b: Site) => {
    for (const [u, v] of corridorPath(k, a, b) ?? []) use(u, v, k);
  };
  /** Does the pair's corridor reach the main-road region? */
  const relevant = (a: Site, b: Site) => {
    const r = (CORRIDOR * dist(a, b) + CORRIDOR_EXTRA) / 2;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return mx + r >= x0 - mainM && mx - r < x1 + mainM && my + r >= y0 - mainM && my - r < y1 + mainM;
  };
  for (const a of towns)
    for (const b of towns)
      if (a.id < b.id && dist(a, b) <= MAX_LEN[ROAD_N] && relevant(a, b) && rngEdge(a, b, towns)) mainPath(ROAD_N, a, b);
  const tv = [...towns, ...villages];
  for (const a of tv)
    for (const b of tv) {
      if (a.id >= b.id || (a.rank === TOWN && b.rank === TOWN)) continue;
      if (dist(a, b) <= MAX_LEN[ROAD_D] && relevant(a, b) && rngEdge(a, b, tv)) mainPath(ROAD_D, a, b);
    }

  /**
   * Cheapest-path forest grown from `sources` over the vertices within margin m;
   * returns each reached vertex's next vertex towards the network.
   */
  /**
   * Cheapest-path forest grown from `sources` over the vertices within margin m, with
   * the heading in the state so turning costs as on main roads (a sharp turn at a
   * vertex is dear: turning on steep ground is left to the fine routing). Returns the
   * way from a vertex back to the network.
   */
  const forest = (sources: Set<number>, m: number, reach: number, k: RoadClass, targets: number[]): ((v: number) => number[]) => {
    // Vertices of the box, indexed locally; states are local index × 9 + direction code.
    const vi0 = Math.floor((x0 - m - JITTER) / LATTICE) - 2;
    const vi1 = Math.ceil((x1 + m + JITTER) / LATTICE) + 2;
    const vj0 = Math.floor((y0 - m - JITTER) / ROW) - 2;
    const vj1 = Math.ceil((y1 + m + JITTER) / ROW) + 2;
    const ni = vi1 - vi0 + 1;
    const nj = vj1 - vj0 + 1;
    const loc = (v: number) => {
      const a = vi(v) - vi0;
      const b = vj(v) - vj0;
      return a < 0 || b < 0 || a >= ni || b >= nj ? -1 : b * ni + a;
    };
    const glob = (l: number) => pack((l % ni) + vi0, Math.floor(l / ni) + vj0);
    const cost = new Float64Array(ni * nj * 9).fill(Infinity);
    const parent = new Int32Array(ni * nj * 9).fill(-1);
    const done = new Uint8Array(ni * nj * 9);
    const best = new Int32Array(ni * nj).fill(-1); // vertex → its cheapest state
    const heap = new MinHeap(1024);
    for (const s0 of sources) {
      const l = loc(s0);
      if (l < 0) continue;
      cost[l * 9 + 4] = 0;
      heap.push(l * 9 + 4, 0);
    }
    // Stop once every target is reached: their ways are then final.
    const wanted = new Uint8Array(ni * nj);
    let left = 0;
    for (const t of targets) {
      const l = loc(t);
      if (l >= 0 && !wanted[l]) {
        wanted[l] = 1;
        left++;
      }
    }
    // Local caches (the hot loop): positions, inside-the-box, edge costs per direction.
    const N = ni * nj;
    const px = new Float64Array(N).fill(NaN);
    const py = new Float64Array(N);
    const inside = new Int8Array(N); // 0 unknown, 1 in, 2 out
    const ec = new Float64Array(N * 6).fill(-1);
    const len = new Float64Array(N * 6).fill(-1);
    const at = (l: number) => {
      if (Number.isNaN(px[l])) {
        const q = pos(glob(l));
        px[l] = q.x;
        py[l] = q.y;
      }
    };
    while (heap.size && left > 0) {
      const st = heap.pop();
      if (done[st]) continue;
      done[st] = 1;
      const code = st % 9;
      const l = (st - code) / 9;
      if (best[l] < 0) {
        best[l] = st;
        if (wanted[l]) left--;
      }
      const a = l % ni;
      const b = (l - a) / ni;
      const c0 = cost[st];
      // The vertex this state came from (local), for turn costs.
      let lf = -1;
      if (code !== 4) {
        const fa = a + (code % 3) - 1;
        const fb = b + Math.floor(code / 3) - 1;
        if (fa >= 0 && fb >= 0 && fa < ni && fb < nj) lf = fb * ni + fa;
      }
      at(l);
      // The incoming edge, for turn costs.
      let ux = 0;
      let uy = 0;
      let lenIn = 0;
      if (lf >= 0) {
        at(lf);
        ux = px[l] - px[lf];
        uy = py[l] - py[lf];
        lenIn = Math.hypot(ux, uy);
      }
      const nb = ((b + vj0) & 1) !== 0 ? NB_ODD : NB_EVEN;
      for (let d = 0; d < 6; d++) {
        const wa = a + nb[d][0];
        const wb = b + nb[d][1];
        if (wa < 0 || wb < 0 || wa >= ni || wb >= nj) continue;
        const lw = wb * ni + wa;
        if (lw === lf) continue;
        if (inside[lw] === 0) {
          at(lw);
          inside[lw] = inBoxXY(px[lw], py[lw], m) ? 1 : 2;
        }
        if (inside[lw] === 2) continue;
        let e = ec[l * 6 + d];
        if (e < 0) e = ec[l * 6 + d] = edgeCost(field, glob(l), glob(lw), k);
        let c = c0 + e;
        if (lf >= 0) {
          const wx = px[lw] - px[l];
          const wy = py[lw] - py[l];
          let lenOut = len[l * 6 + d];
          if (lenOut < 0) lenOut = len[l * 6 + d] = Math.hypot(wx, wy);
          const cos = (ux * wx + uy * wy) / (lenIn * lenOut);
          c += cos < SHARP_COS ? SHARP_TURN : TURN_COST * (1 - cos);
        }
        // Entered from l: direction code of l as seen from lw.
        const ns = lw * 9 + (b - wb + 1) * 3 + (a - wa + 1);
        if (c > reach || c >= cost[ns]) continue;
        cost[ns] = c;
        parent[ns] = st;
        heap.push(ns, c);
      }
    }
    return (v: number) => {
      const out: number[] = [];
      const l = loc(v);
      if (l < 0 || best[l] < 0) return out;
      for (let st = best[l]; st >= 0; st = parent[st]) out.push(glob((st - (st % 9)) / 9));
      return out;
    };
  };
  /** Vertices on roads (not tracks or paths), plus the given sites'. */
  const roadVertices = (extra: Site[]) => {
    const s = new Set<number>();
    for (const e of cls.values()) if (e.c <= ROAD_C) s.add(e.u).add(e.v);
    for (const t of extra) s.add(nearestVertex(t.x, t.y));
    return s;
  };
  const follow = (way: (v: number) => number[], from: number, k: RoadClass) => {
    const vs = way(from);
    for (let i = 1; i < vs.length; i++) use(vs[i - 1], vs[i], k);
  };
  /** Mean slope penalty of a class along a path (edges as vertex pairs), × length. */
  const steepness = (edges: [number, number][], k: RoadClass) => {
    let L = 0;
    let c = 0;
    for (const [u, v] of edges) {
      const l = dist(pos(u), pos(v));
      L += l;
      c += l * Math.min(SLOPE_CAP[k], 1 + SLOPE_W * (classGrade(field, u, v, k) / EASY_GRADE[k]) ** 2);
    }
    return L > 0 ? c / L : 1;
  };

  // 3. Hamlet roads.
  const tvNear = tv.filter((s) => inBox(s, hamletForestM));
  const hamlets = sitesIn(HAMLET, hamletM);
  const hv = hamlets.map((h) => nearestVertex(h.x, h.y));
  const pA = forest(roadVertices(tvNear), hamletForestM, HAMLET_REACH * COST_CAP, ROAD_C, hv);
  for (const v of hv) follow(pA, v, ROAD_C);

  /**
   * Shortcuts between neighbouring sites (Gabriel pairs min–max apart, midpoint within
   * margin m) that the ways so far join only by a way round longer than `ratio` × their
   * distance: the corridor path of the first of `classes` that is no longer than
   * `detour` × the distance nor steeper than SHORT_STEEP × its limit. Decided on the
   * ways so far only, never on each other, so every cell decides each pair alike.
   */
  const shortcuts = (sites: Site[], m: number, min: number, max: number, ratio: number, detour: number, extra: number, classes: RoadClass[]) => {
    const adj = new Map<number, [number, number][]>();
    for (const e of cls.values()) {
      const L = dist(pos(e.u), pos(e.v));
      for (const [p, q] of [
        [e.u, e.v],
        [e.v, e.u],
      ]) {
        if (!adj.has(p)) adj.set(p, []);
        adj.get(p)!.push([q, L]);
      }
    }
    const netDist = (s: number, t: number, limit: number) => {
      const d = new Map<number, number>([[s, 0]]);
      const ids: number[] = [s];
      const heap = new MinHeap(64);
      heap.push(0, 0);
      while (heap.size) {
        const u = ids[heap.pop()];
        const du = d.get(u)!;
        if (u === t) return du;
        for (const [w, L] of adj.get(u) ?? []) {
          const dw = du + L;
          if (dw > limit || dw >= (d.get(w) ?? Infinity)) continue;
          d.set(w, dw);
          ids.push(w);
          heap.push(ids.length - 1, dw);
        }
      }
      return Infinity;
    };
    const grid = new Grid(sites, 1024);
    const added: [number, number, RoadClass][] = [];
    for (const a of sites)
      for (const b of grid.near(a.x, a.y, max)) {
        if (a.id >= b.id) continue;
        const d = dist(a, b);
        if (d < min || !inBox({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, m)) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (grid.near(mx, my, d / 2 - 1e-6).some((c) => c !== a && c !== b)) continue; // Gabriel
        const va = nearestVertex(a.x, a.y);
        const vb = nearestVertex(b.x, b.y);
        if (va === vb || netDist(va, vb, ratio * d) <= ratio * d) continue;
        for (const k of classes) {
          const p = corridorPath(k, a, b, extra);
          if (!p) continue;
          const len = p.reduce((s, [u, v]) => s + dist(pos(u), pos(v)), 0);
          const steep = p.some(([u, v]) => classGrade(field, u, v, k) > SHORT_STEEP * MAX_GRADE[k]);
          if (len > detour * (k === ROAD_P ? PATH_DETOUR : 1) * d || steep || (k === ROAD_T && steepness(p, k) > TRACK_STEEPNESS)) continue;
          for (const [u, v] of p) added.push([u, v, k]);
          break;
        }
      }
    return added;
  };

  // 4. Shortcuts: neighbouring settlements (Gabriel pairs) that the roads so far
  // join only by a long way round get a direct minor road — or, where that would
  // be too steep, a footpath. Decided on main and hamlet roads only, never on other
  // shortcuts, so every cell decides each pair alike.
  {
    const settled = [...tv.filter((s) => inBox(s, shortM + SHORT_MAX / 2)), ...hamlets.filter((s) => inBox(s, shortM + SHORT_MAX / 2))];
    for (const [u, v, k] of shortcuts(settled, shortM, SHORT_MIN, SHORT_MAX, SHORT_RATIO, SHORT_DETOUR, SHORT_EXTRA, [ROAD_C, ROAD_P])) use(u, v, k);
  }

  // 5. Farm roads.
  const farms = sitesIn(FARM, farmM);
  const fv = farms.map((f) => nearestVertex(f.x, f.y));
  const pB = forest(roadVertices([...tvNear, ...hamlets]), farmForestM, FARM_REACH * COST_CAP, ROAD_C, fv);
  for (const v of fv) follow(pB, v, ROAD_C);

  // 6. Links: neighbouring settlements, farms included, joined by the roads only the
  // long way round get a track across — or a footpath where a track would be too
  // steep. Farmland is crossed by a mesh of tracks, not only the trees of farm roads.
  const links = new Map<string, { u: number; v: number; c: RoadClass }>();
  {
    const near = (s: Site) => inBox(s, linkM + LINK_MAX / 2);
    const all = [...tv.filter(near), ...hamlets.filter(near), ...farms.filter(near)];
    for (const [u, v, k] of shortcuts(all, linkM, LINK_MIN, LINK_MAX, LINK_RATIO, LINK_DETOUR, LINK_EXTRA, [ROAD_T, ROAD_P])) {
      const key = edgeKey(u, v);
      const e = links.get(key);
      if (!e || k < e.c) links.set(key, { u, v, c: k });
    }
  }

  // 7. Tracks: scattered points of open land and forest far from any road get a
  // track back to the network (or a track link), grown as one forest so nearby
  // tracks merge.
  {
    const linkVerts = new Set<number>();
    const trackLinks = new Set<number>();
    for (const e of links.values()) {
      linkVerts.add(e.u).add(e.v);
      if (e.c === ROAD_T) trackLinks.add(e.u).add(e.v);
    }
    const roadPts = new Grid(
      [...roadVertices([]), ...linkVerts].map((v) => pos(v)),
      512,
    );
    // Candidates TRACK_SPACE beyond the seeds' box, so every cell spaces a seed alike.
    const m = trackM + TRACK_SPACE;
    const box = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
    const cands: { v: number; x: number; y: number; h: number; slope: number }[] = [];
    for (const v of verticesIn(box)) {
      const p = pos(v);
      // Fewer on steep ground: mountain slopes are crossed by few ways, which then
      // have room to wind (see microRoute).
      const gx = field.z(p.x + 250, p.y) - field.z(p.x - 250, p.y);
      const gy = field.z(p.x, p.y + 250) - field.z(p.x, p.y - 250);
      const slope = Math.hypot(gx, gy) / 500;
      const thin = 1 - TRACK_THIN * smoothstep(TRACK_THIN_SLOPE[0], TRACK_THIN_SLOPE[1], slope);
      const h = hash3(0x7ac4, vi(v), vj(v)) / 4294967296;
      if (h >= TRACK_DENSITY * thin) continue;
      if (p.z > TRACK_ALT || roadPts.near(p.x, p.y, TRACK_GAP).length || p.wet) continue;
      if (neighbours(v).some((w) => edgeGrade(field, v, w) > TRACK_STEEP)) continue;
      cands.push({ v, x: p.x, y: p.y, h, slope });
    }
    // On steep ground, one seed per TRACK_SPACE (the lowest hash): neighbouring seeds
    // on a slope would each run a track down it, side by side.
    const candGrid = new Grid(cands, 512);
    const seeds: number[] = [];
    for (const c of cands) {
      if (!inBox(c, trackM)) continue;
      if (c.slope > TRACK_SPACE_SLOPE && candGrid.near(c.x, c.y, TRACK_SPACE).some((o) => o !== c && o.h < c.h && Math.hypot(o.x - c.x, o.y - c.y) < TRACK_SPACE)) continue;
      seeds.push(c.v);
    }
    const pT = forest(new Set([...roadVertices([]), ...trackLinks]), trackForestM, TRACK_REACH * COST_CAP, ROAD_T, seeds);
    for (const v of seeds) {
      // A track that would have to run down a steep slope (the way back to the network
      // offers no gentler line) is left out: mountain slopes keep few tracks.
      const vs = pT(v);
      const edges = vs.slice(1).map((w, i): [number, number] => [vs[i], w]);
      if (steepness(edges, ROAD_T) <= TRACK_STEEPNESS) follow(pT, v, ROAD_T);
    }
  }
  for (const e of links.values()) use(e.u, e.v, e.c);

  // Owned edges: midpoint in the cell.
  const edges: RoadEdge[] = [];
  const vsite = (v: number): Site => {
    const p = pos(v);
    return { id: `v:${v}`, rank: HAMLET, x: p.x, y: p.y, z: p.z, R: 0 };
  };
  for (const [k, e] of cls) {
    const a = pos(e.u);
    const b = pos(e.v);
    if (!inBox({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 0)) continue;
    edges.push({ id: k, cls: e.c, a: vsite(e.u), b: vsite(e.v), route: [a.x, a.y, b.x, b.y] });
  }
  const sites = [...towns, ...villages, ...sitesIn(HAMLET, 0), ...sitesIn(FARM, 0)].filter((s) => inBox(s, 0));
  return { sites, edges };
}

// ---------------------------------------------------------------------------
// Geometry

/**
 * Segment tasks for a chunk: the lattice edges whose midpoint lies in it, each with
 * its partner at both ends — the edge it continues into (same road, straightest
 * way through), if any. Pairs are matched per vertex from all its edges, so both
 * edges of a pair agree, in every chunk.
 */
export function latticeSegments(edges: RoadEdge[], cx: number, cy: number): SegmentTask[] {
  const at = new Map<string, { x: number; y: number; cls: RoadClass; ox: number; oy: number; key: string }[]>();
  const k2 = (x: number, y: number) => `${x},${y}`;
  for (const e of edges) {
    const [ax, ay, bx, by] = e.route;
    for (const [px, py, qx, qy] of [
      [ax, ay, bx, by],
      [bx, by, ax, ay],
    ]) {
      const k = k2(px, py);
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push({ x: px, y: py, cls: e.cls, ox: qx, oy: qy, key: e.id });
    }
  }
  // Partner of each (edge, vertex): greedy matching, best class then straightest.
  const partner = new Map<string, [number, number]>();
  for (const [vk, inc] of at) {
    const pairs: { i: number; j: number; c: number; s: number }[] = [];
    for (let i = 0; i < inc.length; i++)
      for (let j = i + 1; j < inc.length; j++) {
        const a = inc[i];
        const b = inc[j];
        const ux = a.ox - a.x;
        const uy = a.oy - a.y;
        const wx = b.ox - b.x;
        const wy = b.oy - b.y;
        const s = -(ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy)); // 1 = straight on
        pairs.push({ i, j, c: Math.max(a.cls, b.cls), s });
      }
    pairs.sort((p, q) => p.c - q.c || q.s - p.s || (inc[p.i].key + inc[p.j].key < inc[q.i].key + inc[q.j].key ? -1 : 1));
    const used = new Set<number>();
    for (const p of pairs) {
      if (used.has(p.i) || used.has(p.j)) continue;
      // A side road meets a through road at a junction: only pair roads of one class,
      // or a vertex with just two roads (the road simply goes on, hairpin or not).
      if (inc.length > 2 && inc[p.i].cls !== inc[p.j].cls) continue;
      used.add(p.i).add(p.j);
      partner.set(`${inc[p.i].key}@${vk}`, [inc[p.j].ox, inc[p.j].oy]);
      partner.set(`${inc[p.j].key}@${vk}`, [inc[p.i].ox, inc[p.i].oy]);
    }
  }
  // Pieces: runs of up to PIECE_EDGES edges of one road between anchors — junctions,
  // dead ends, class changes, and vertices picked by a hash of their position. A
  // piece too steep for its class is drawn as one serpentine (see routeCurves).
  const byKey = new Map<string, RoadEdge>();
  for (const e of edges) byKey.set(e.id, e);
  const anchor = (vk: string) => {
    const inc = at.get(vk) ?? [];
    if (inc.length !== 2 || inc[0].cls !== inc[1].cls) return true;
    const [x, y] = vk.split(',').map(Number);
    return hash3(0x9a1c, Math.round(x), Math.round(y)) / 4294967296 < PIECE_ANCHOR;
  };
  /** The piece containing edge e: vertices and edge keys, in canonical order; null if too long. */
  const pieceOf = (e: RoadEdge): { pts: number[]; keys: string[] } | null => {
    const [ax, ay, bx, by] = e.route;
    // Walk from vertex (x, y), leaving it away from edge `from`, until an anchor.
    const walk = (x: number, y: number, from: string) => {
      const pts: number[] = [];
      const keys: string[] = [];
      let vk = k2(x, y);
      let prev = from;
      while (!anchor(vk) && keys.length <= PIECE_EDGES) {
        const next = (at.get(vk) ?? []).find((i) => i.key !== prev)!;
        keys.push(next.key);
        pts.push(next.ox, next.oy);
        prev = next.key;
        vk = k2(next.ox, next.oy);
      }
      return { pts, keys };
    };
    const back = walk(ax, ay, e.id);
    const fwd = walk(bx, by, e.id);
    const keys = [...back.keys.reverse(), e.id, ...fwd.keys];
    if (keys.length > PIECE_EDGES) return null;
    const bp: number[] = [];
    for (let i = back.pts.length - 2; i >= 0; i -= 2) bp.push(back.pts[i], back.pts[i + 1]);
    let pts = [...bp, ax, ay, bx, by, ...fwd.pts];
    let ks = keys;
    // Canonical direction: from the smaller end vertex.
    if (k2(pts[pts.length - 2], pts[pts.length - 1]) < k2(pts[0], pts[1])) {
      const r: number[] = [];
      for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]);
      pts = r;
      ks = [...keys].reverse();
    }
    return { pts, keys: ks };
  };
  /** The run an edge belongs to (or the edge alone), memoised: what decides whether it's fine-routed. */
  const pieceMemo = new Map<string, { key: string; pts: number[] }>();
  const piecePts = (o: RoadEdge) => {
    let r = pieceMemo.get(o.id);
    if (!r) {
      const pc = pieceOf(o);
      r = pc ? { key: pc.keys.join('+'), pts: pc.pts } : { key: o.id, pts: o.route };
      for (const k of pc?.keys ?? [o.id]) pieceMemo.set(k, r);
    }
    return r;
  };
  const segDist = (p: number[], q: number[]) => {
    const pd = (x: number, y: number, s: number[]) => {
      const dx = s[2] - s[0];
      const dy = s[3] - s[1];
      const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x - s[0] - t * dx, y - s[1] - t * dy);
    };
    return Math.min(pd(p[0], p[1], q), pd(p[2], p[3], q), pd(q[0], q[1], p), pd(q[2], q[3], p));
  };
  // Ways near the chunk: everything within ROOM_REACH of a piece of it (up to
  // PIECE_EDGES edges out), measured between edge midpoints.
  const NEAR = PIECE_EDGES * 1.7 * LATTICE + ROOM_REACH + 1.7 * LATTICE;
  const local = edges.filter((o) => {
    const mx = (o.route[0] + o.route[2]) / 2 - (cx + 0.5) * CHUNK;
    const my = (o.route[1] + o.route[3]) / 2 - (cy + 0.5) * CHUNK;
    return Math.abs(mx) < CHUNK / 2 + NEAR && Math.abs(my) < CHUNK / 2 + NEAR;
  });
  /**
   * Surroundings of a run of edges (vertices `pts`, keys `own`, class `cls`): the
   * ways within ROOM_REACH (obstacles), the wedges at its ends (from the ways meeting
   * it there) and its rivals (the other ways near it), which limit where it may go.
   */
  const surroundings = (pts: number[], own: Set<string>, cls: RoadClass) => {
    const n = pts.length / 2;
    const endA = k2(pts[0], pts[1]);
    const endB = k2(pts[2 * n - 2], pts[2 * n - 1]);
    const obstacles: number[] = [];
    // Directions of the other ways at either end, for the wedges.
    const atEnd: [number[], number[]] = [[], []];
    const rivals = new Map<string, Rival>();
    for (const o of local) {
      if (own.has(o.id)) continue;
      const r = o.route;
      const ka = k2(r[0], r[1]);
      const kb = k2(r[2], r[3]);
      if ((ka === endA || ka === endB) && (kb === endA || kb === endB)) continue;
      // A way meeting the run at an end: kept apart by the wedges, not by room.
      const meets = ka === endA || ka === endB || kb === endA || kb === endB;
      if (meets) {
        const [vx, vy, wx, wy] = ka === endA || ka === endB ? r : [r[2], r[3], r[0], r[1]];
        atEnd[k2(vx, vy) === endA ? 0 : 1].push(Math.atan2(wy - vy, wx - vx));
      }
      let near = false;
      for (let i = 1; i < n; i++) {
        const sgm = [pts[2 * i - 2], pts[2 * i - 1], pts[2 * i], pts[2 * i + 1]];
        if (Math.abs((r[0] + r[2]) / 2 - (sgm[0] + sgm[2]) / 2) > 600 || Math.abs((r[1] + r[3]) / 2 - (sgm[1] + sgm[3]) / 2) > 600) continue;
        const d = segDist(sgm, r);
        if (d < ROOM_REACH) near = true;
        if (meets) continue;
        if (d < ROOM_REACH && !rivals.has(piecePts(o).key)) {
          const pc = piecePts(o);
          const weight = cls < o.cls ? RIVAL_MAJOR : cls > o.cls ? RIVAL_MINOR : RIVAL_EQUAL;
          rivals.set(pc.key, { weight, cls: o.cls, pts: pc.pts });
        }
      }
      if (near) obstacles.push(...r);
    }
    const wedges: number[] = [];
    for (const [e, i, j] of [[0, 0, 1], [1, n - 1, n - 2]] as const) {
      const vx = pts[2 * i], vy = pts[2 * i + 1];
      const dir = Math.atan2(pts[2 * j + 1] - vy, pts[2 * j] - vx);
      let ccw = 2 * Math.PI;
      let cw = 2 * Math.PI;
      for (const a of atEnd[e]) {
        const d = (((a - dir) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (d > 1e-6) ccw = Math.min(ccw, d);
        if (2 * Math.PI - d > 1e-6) cw = Math.min(cw, 2 * Math.PI - d);
      }
      wedges.push(vx, vy, dir, ccw / 2, cw / 2);
    }
    return { obstacles, wedges, rivals: [...rivals.values()] };
  };
  /** The way beyond vertex (x, y), leaving it away from edge `from`, if it runs into a dead end within SPUR_MAX edges without meeting another way: its vertices, (x, y) first. */
  const spur = (x: number, y: number, from: string): number[] | undefined => {
    const pts: number[] = [];
    let prev = from;
    for (let n = 0; n <= SPUR_MAX; n++) {
      pts.push(x, y);
      const inc = at.get(k2(x, y)) ?? [];
      if (inc.length === 1) return pts;
      if (inc.length !== 2) return undefined;
      const next = inc.find((i) => i.key !== prev)!;
      prev = next.key;
      x = next.ox;
      y = next.oy;
    }
    return undefined;
  };
  const out: SegmentTask[] = [];
  for (const e of edges) {
    const [ax, ay, bx, by] = e.route;
    if (Math.floor((ax + bx) / 2 / CHUNK) !== cx || Math.floor((ay + by) / 2 / CHUNK) !== cy) continue;
    const task: SegmentTask = {
      key: e.id,
      cls: e.cls,
      ax,
      ay,
      bx,
      by,
      pa: partner.get(`${e.id}@${k2(ax, ay)}`),
      pb: partner.get(`${e.id}@${k2(bx, by)}`),
      ...surroundings(e.route, new Set([e.id]), e.cls),
      spurA: spur(ax, ay, e.id),
      spurB: spur(bx, by, e.id),
    };
    const pc = pieceOf(e);
    if (pc) {
      const n = pc.pts.length / 2;
      const { obstacles, wedges, rivals } = surroundings(pc.pts, new Set(pc.keys), e.cls);
      const first = byKey.get(pc.keys[0])!;
      const last = byKey.get(pc.keys[pc.keys.length - 1])!;
      task.piece = {
        key: pc.keys.join('+'),
        pts: pc.pts,
        owner: pc.keys[Math.floor((pc.keys.length - 1) / 2)] === e.id,
        obstacles,
        wedges,
        rivals,
        pa: partner.get(`${first.id}@${k2(pc.pts[0], pc.pts[1])}`),
        pb: partner.get(`${last.id}@${k2(pc.pts[2 * n - 2], pc.pts[2 * n - 1])}`),
        spurA: spur(pc.pts[0], pc.pts[1], first.id),
        spurB: spur(pc.pts[2 * n - 2], pc.pts[2 * n - 1], last.id),
      };
    }
    out.push(task);
  }
  return out;
}

/** Room around a piece is looked for this far (m): every chunk that sees the piece knows all ways that close. */
const ROOM_REACH = 300;
/**
 * Weight of a fine-routed run against a neighbouring run that may wind too (see
 * `Rival`): of lower class (a road beside a track), higher class, or the same.
 * A pair's weights multiply to under 1; roads get the room to wind.
 */
const RIVAL_MAJOR = 1.5;
const RIVAL_MINOR = 0.6;
const RIVAL_EQUAL = 0.9;
/** Dead ends are looked for this many edges beyond an edge's or piece's end (see SegmentTask.spurA). */
const SPUR_MAX = 4;
/** Pieces: at most this many edges; a vertex is an anchor with this probability. */
const PIECE_EDGES = 3;
const PIECE_ANCHOR = 0.5;

/** Snap radius (fine nodes) for vertices: onto gentler, dry ground nearby. */
const VSNAP = 2;
/** A vertex with no dry ground within VSNAP moves to the nearest within this (fine nodes): onto the shore. */
const SHORE_SNAP = 8;
/** A piece or edge with more than this (m) of its line in a lake is routed around it. */
const WET_MIN = 4;
/** Snapping: cost (in fine nodes of distance) of a node beside a lake — the map's shoreline,
 * splined between nodes, reaches a few metres past the last lake node. */
const SNAP_SHORE = 3;

/**
 * One curve per lattice edge: cubic Hermite between its two (snapped) vertices.
 * At a vertex the road continues through, the direction is the line between its
 * neighbours on either side (Catmull–Rom), the same for both edges — so curves join
 * smoothly; a sharp turn there becomes a hairpin bend. A road ending at a vertex,
 * or meeting a through road there, arrives straight.
 *
 * Lakes: the network can't see them (they come from the fine solves), so the
 * drawing goes round them. A vertex under water moves to the shore; a piece whose
 * line crosses a lake is routed on the fine terrain as one, like a steep piece; an
 * edge still in the water after fitting is routed on its own. Where no way round
 * fits, the route crosses at the narrowest place (a bridge or causeway).
 */
export function routeCurves(tasks: SegmentTask[], p: RoadPatch): SegmentPath[] {
  const { w, h } = p;
  const isLake = (k: number) => !Number.isNaN(p.lake[k]);
  /** Dry node beside a lake. */
  const onShore = (i: number, j: number) => {
    const k = j * w + i;
    return (i > 0 && isLake(k - 1)) || (i < w - 1 && isLake(k + 1)) || (j > 0 && isLake(k - w)) || (j < h - 1 && isLake(k + w));
  };
  /** Is world (x, y) in a lake (nearest node)? Outside the patch: no. */
  const lakeAt = (x: number, y: number) => {
    const i = Math.round(x / NODE) - p.gx;
    const j = Math.round(y / NODE) - p.gy;
    return i >= 0 && j >= 0 && i < w && j < h && isLake(j * w + i);
  };
  /** Length (m) of a polyline [x0, y0, …] in lakes, sampled every few metres. */
  const wetLength = (pts: ArrayLike<number>) => {
    let wet = 0;
    for (let i = 2; i < pts.length; i += 2) {
      const L = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      const m = Math.max(1, Math.ceil(L / 4));
      for (let s = 0; s < m; s++) {
        const u = (s + 0.5) / m;
        if (lakeAt(pts[i - 2] + (pts[i] - pts[i - 2]) * u, pts[i - 1] + (pts[i + 1] - pts[i - 1]) * u)) wet += L / m;
      }
    }
    return wet;
  };
  const snaps = new Map<string, [number, number]>();
  const snap = (x: number, y: number): [number, number] => {
    const key = `${x},${y}`;
    let hit = snaps.get(key);
    if (!hit) snaps.set(key, (hit = snapRaw(x, y)));
    return hit;
  };
  const snapRaw = (x: number, y: number): [number, number] => {
    const ci = Math.round(x / NODE) - p.gx;
    const cj = Math.round(y / NODE) - p.gy;
    let best: [number, number] = [x, y];
    let bs = Infinity;
    // Gentle, dry ground near the vertex; or, under water, the nearest shore.
    for (const [R, wd] of [
      [VSNAP, 0.1],
      [SHORE_SNAP, 1],
    ]) {
      for (let dj = -R; dj <= R; dj++)
        for (let di = -R; di <= R; di++) {
          const i = ci + di;
          const j = cj + dj;
          const d = Math.hypot(di, dj);
          if ((R === SHORE_SNAP && d > R) || i < 1 || j < 1 || i >= w - 1 || j >= h - 1) continue;
          const k = j * w + i;
          if (isLake(k)) continue;
          const slope = Math.hypot(p.zE[k + 1] - p.zE[k - 1], p.zE[k + w] - p.zE[k - w]) / (2 * NODE);
          const s = 10 * slope + (p.A[k] > 0.3 ? 2 : 0) + wd * d + (onShore(i, j) ? SNAP_SHORE : 0);
          if (s < bs) {
            bs = s;
            best = [(p.gx + i) * NODE, (p.gy + j) * NODE];
          }
        }
      if (bs < Infinity) break;
    }
    return best;
  };
  /** Bilinear fine elevation at world (x, y). */
  const zAt = (x: number, y: number) => {
    const u = Math.min(w - 1.001, Math.max(0, x / NODE - p.gx));
    const v = Math.min(h - 1.001, Math.max(0, y / NODE - p.gy));
    const i = Math.floor(u);
    const j = Math.floor(v);
    const k = j * w + i;
    const fu = u - i;
    const fv = v - j;
    const z = p.zE;
    return (z[k] * (1 - fu) + z[k + 1] * fu) * (1 - fv) + (z[k + w] * (1 - fu) + z[k + w + 1] * fu) * fv;
  };
  /**
   * A run of edges (vertices `pts`) routed on the fine terrain, from its first vertex
   * to its last (both snapped). `pa`/`pb`: the vertices beyond either end, if the road
   * goes on there.
   */
  /** Whether a neighbouring run may be fine-routed too: steep, near water, or beyond this patch (can't tell). */
  const active = (r: Rival) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < r.pts.length; i += 2) {
      x0 = Math.min(x0, r.pts[i]);
      y0 = Math.min(y0, r.pts[i + 1]);
      x1 = Math.max(x1, r.pts[i]);
      y1 = Math.max(y1, r.pts[i + 1]);
    }
    const m = 48;
    if (x0 - m < p.gx * NODE || y0 - m < p.gy * NODE || x1 + m > (p.gx + w - 1) * NODE || y1 + m > (p.gy + h - 1) * NODE) return true;
    // Tracks and footpaths are routed where too steep for their easy grade.
    return (r.cls >= ROAD_T ? !!serpentineFrame(r.pts, EASY_GRADE[r.cls], zAt, true) : !!serpentineFrame(r.pts, MAX_GRADE[r.cls], zAt)) || wetLength(r.pts) > 0;
  };
  const routed = (
    key: string,
    cls: RoadClass,
    pts: number[],
    pa: [number, number] | undefined,
    pb: [number, number] | undefined,
    rivals: Rival[],
    obstacles: number[],
    wedges: number[],
    rawA = false,
    rawB = false,
  ): SegmentPath => {
    const n = pts.length / 2;
    const [ax, ay] = rawA ? [pts[0], pts[1]] : snap(pts[0], pts[1]);
    const [bx, by] = rawB ? [pts[2 * n - 2], pts[2 * n - 1]] : snap(pts[2 * n - 2], pts[2 * n - 1]);
    // Directions at the ends: the shared Catmull–Rom direction there (next vertex
    // minus previous), as the piece or edge on the other side also uses.
    const inDir = pa ? [pts[2] - pa[0], pts[3] - pa[1]] : [bx - ax, by - ay];
    const outDir = pb ? [pb[0] - pts[2 * n - 4], pb[1] - pts[2 * n - 3]] : [bx - ax, by - ay];
    const near = rivals.map((r) => ({ ...r, active: active(r) }));
    const xy = microRoute(ax, ay, bx, by, inDir, outDir, MAX_GRADE[cls], p, zAt, obstacles, pts, near, cls, wedges);
    return { key, cls, xy: Float32Array.from(xy), micro: true };
  };
  /** A path with no step longer than 8 m (the water checks look at its points). */
  const densified = (g: SegmentPath): SegmentPath => {
    const xy = g.xy;
    let long = false;
    for (let i = 2; i < xy.length && !long; i += 2) long = Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]) > 8;
    if (!long) return g;
    const out: number[] = [xy[0], xy[1]];
    for (let i = 2; i < xy.length; i += 2) {
      const m = Math.max(1, Math.ceil(Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]) / 8));
      for (let s = 1; s <= m; s++) out.push(xy[i - 2] + ((xy[i] - xy[i - 2]) * s) / m, xy[i - 1] + ((xy[i + 1] - xy[i - 1]) * s) / m);
    }
    return { ...g, xy: Float32Array.from(out) };
  };
  /** Dry node beside a lake at world (x, y)? */
  const shoreAt = (x: number, y: number) => {
    const i = Math.round(x / NODE) - p.gx;
    const j = Math.round(y / NODE) - p.gy;
    return i >= 0 && j >= 0 && i < w && j < h && !isLake(j * w + i) && onShore(i, j);
  };
  /**
   * Is all of a way's run to its dead end (vertices `spur`, as the network placed
   * them: snapping may move a vertex to the far shore) under water?
   */
  const drowned = (spur?: number[]) => {
    if (!spur || !lakeAt(spur[0], spur[1])) return false;
    let len = 0;
    for (let i = 2; i < spur.length; i += 2) len += Math.hypot(spur[i] - spur[i - 2], spur[i + 1] - spur[i - 1]);
    return wetLength(spur) >= len - 1e-6;
  };
  /**
   * What is drawn of a way (polyline xy from its end A to B). A way must not end in
   * a lake: where all of it beyond an end is under water (`dA`, `dB`; the end is then
   * not snapped, so the way heads into the water there), it stops at the first water
   * coming from the other end, and the shore beside it. Tracks and footpaths don't
   * cross water: any part still in a lake is left out.
   */
  const drawn = (g0: SegmentPath, dA: boolean, dB: boolean): SegmentPath[] => {
    const g = densified(g0);
    const xy = g.xy;
    let s = 0;
    let e = xy.length / 2 - 1;
    const wetI = (i: number) => lakeAt(xy[2 * i], xy[2 * i + 1]);
    const shoreI = (i: number) => shoreAt(xy[2 * i], xy[2 * i + 1]);
    if (dB) {
      let i = s;
      while (i <= e && !wetI(i)) i++;
      e = i - 1;
      while (e > s && shoreI(e)) e--;
    }
    if (dA) {
      let i = e;
      while (i >= s && !wetI(i)) i--;
      s = i + 1;
      while (s < e && shoreI(s)) s++;
    }
    if (e - s < 1) return [];
    if (g.cls < ROAD_T) return [s === 0 && e === xy.length / 2 - 1 ? g : { ...g, xy: xy.slice(2 * s, 2 * e + 2) }];
    // Tracks and footpaths: the dry runs only (a run's ends kept off the shore).
    const parts: SegmentPath[] = [];
    let i = s;
    while (i <= e) {
      while (i <= e && lakeAt(xy[2 * i], xy[2 * i + 1])) i++;
      let j = i;
      while (j + 1 <= e && !lakeAt(xy[2 * j + 2], xy[2 * j + 3])) j++;
      let a = i;
      let b = j;
      if (a > s) while (a < b && shoreAt(xy[2 * a], xy[2 * a + 1])) a++;
      if (b < e) while (b > a && shoreAt(xy[2 * b], xy[2 * b + 1])) b--;
      if (b > a) parts.push({ ...g, key: parts.length || a > s || b < e ? `${g.key}~${a}` : g.key, xy: xy.slice(2 * a, 2 * b + 2) });
      i = j + 1;
    }
    return parts;
  };
  const out: SegmentPath[] = [];
  for (const t of tasks) {
    // Tracks and footpaths: drawn a piece at a time (or an edge with no piece) by the
    // chunk owning its middle edge — straight from end to end, fitted to an easy grade,
    // so they run straight across flat land and bend with the contours on a slope.
    // Where that is too steep, wet or too close to another way: routed.
    if (t.cls >= ROAD_T) {
      const pc = t.piece ?? { key: t.key, pts: [t.ax, t.ay, t.bx, t.by], owner: true, pa: t.pa, pb: t.pb, rivals: t.rivals, obstacles: t.obstacles, wedges: t.wedges, spurA: t.spurA, spurB: t.spurB };
      const dA = drowned(pc.spurA);
      const dB = drowned(pc.spurB);
      if ((dA || dB) && drowned(pc.pts)) continue;
      if (!pc.owner) continue;
      const g =
        (!serpentineFrame(pc.pts, EASY_GRADE[t.cls], zAt, true) && chordsOf(pc.key, t.cls, pc.pts, pc.pa, pc.pb, pc.rivals, pc.obstacles, pc.wedges, dA, dB)) ||
        routed(pc.key, t.cls, pc.pts, pc.pa, pc.pb, pc.rivals, pc.obstacles, pc.wedges, dA, dB);
      out.push(...drawn(g, dA, dB));
      continue;
    }
    // A piece too steep for its class, or crossing a lake: drawn once, routed on the
    // fine terrain, by the chunk owning its middle edge.
    if (t.piece) {
      const pc = t.piece;
      if (serpentineFrame(pc.pts, MAX_GRADE[t.cls], zAt) || wetLength(pc.pts) > WET_MIN) {
        const dA = drowned(pc.spurA);
        const dB = drowned(pc.spurB);
        // Wholly in the water a way ends in: the way stops at the shore before it.
        if ((dA || dB) && drowned(pc.pts)) continue;
        if (pc.owner) out.push(...drawn(routed(pc.key, t.cls, pc.pts, pc.pa, pc.pb, pc.rivals, pc.obstacles, pc.wedges, dA, dB), dA, dB));
        continue;
      }
    }
    const dA = drowned(t.spurA);
    const dB = drowned(t.spurB);
    if ((dA || dB) && drowned([t.ax, t.ay, t.bx, t.by])) continue;
    const c = curveOf(t, dA, dB);
    // Still in a lake after fitting (the band is narrow): only this chunk draws the
    // edge, so it can go round on its own. (Not when it heads into one to end there.)
    const g = !dA && !dB && wetLength(c.xy) > WET_MIN ? routed(t.key, t.cls, [t.ax, t.ay, t.bx, t.by], t.pa, t.pb, t.rivals, t.obstacles, t.wedges) : c;
    out.push(...drawn(g, dA, dB));
  }
  return out;

  /**
   * A track or footpath piece drawn as straight runs, each shifted sideways to keep an
   * easy, even grade (along the contours): from end to end where that line stays in
   * the room the piece may use (see roomOf), else broken at one or more of its
   * vertices — down to each edge on its own, which keeps to the lattice as closely as
   * a curve would. Null where a run has water under it.
   */
  function chordsOf(
    key: string,
    cls: RoadClass,
    pts: number[],
    pa: [number, number] | undefined,
    pb: [number, number] | undefined,
    rivals: Rival[],
    obstacles: number[],
    wedges: number[],
    rawA: boolean,
    rawB: boolean,
  ): SegmentPath | null {
    const n = pts.length / 2;
    const near = rivals.map((r) => ({ ...r, active: active(r) }));
    /** Do other ways meet the piece at its end e (0: first, 1: last)? Its wedge there is then narrower than all round. */
    const junction = (e: number) => wedges.length >= 2 * WEDGE && Math.min(wedges[e * WEDGE + 3], wedges[e * WEDGE + 4]) < Math.PI - 1e-6;
    const end = (i: number) => (i === 0 && rawA) || (i === n - 1 && rawB) ? [pts[2 * i], pts[2 * i + 1]] : snap(pts[2 * i], pts[2 * i + 1]);
    /** The run from vertex i to vertex j, fitted; null if wet, or (unless `force`) out of room. */
    const run = (i: number, j: number, force: boolean): number[] | null => {
      const own = pts.slice(2 * i, 2 * j + 2);
      // The road's direction beyond the run's ends, for roomOf.
      const inDir = i > 0 ? [pts[2 * i + 2] - pts[2 * i - 2], pts[2 * i + 3] - pts[2 * i - 1]] : pa ? [pts[2] - pa[0], pts[3] - pa[1]] : [pts[2] - pts[0], pts[3] - pts[1]];
      const outDir =
        j < n - 1
          ? [pts[2 * j + 2] - pts[2 * j - 2], pts[2 * j + 3] - pts[2 * j - 1]]
          : pb
            ? [pb[0] - pts[2 * n - 4], pb[1] - pts[2 * n - 3]]
            : [pts[2 * n - 2] - pts[2 * n - 4], pts[2 * n - 1] - pts[2 * n - 3]];
      // Wedges only at the piece's own ends (inside it, the road just goes on).
      const wd = wedges.length >= 2 * WEDGE ? [...(i === 0 ? wedges.slice(0, WEDGE) : []), ...(j === n - 1 ? wedges.slice(WEDGE) : [])] : [];
      const [ax, ay] = end(i);
      const [bx, by] = end(j);
      // At a junction, leave along the edge (nearly): skewed, the run could graze the
      // way it meets there.
      if (!force) {
        const skew = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
          Math.acos(Math.max(-1, Math.min(1, ((qx - px) * (rx - px) + (qy - py) * (ry - py)) / (Math.hypot(qx - px, qy - py) * Math.hypot(rx - px, ry - py) || 1))));
        if (i === 0 && junction(0) && skew(pts[0], pts[1], pts[2], pts[3], pts[2 * j], pts[2 * j + 1]) > CHORD_SKEW) return null;
        if (j === n - 1 && junction(1) && skew(pts[2 * j], pts[2 * j + 1], pts[2 * j - 2], pts[2 * j - 1], pts[2 * i], pts[2 * i + 1]) > CHORD_SKEW) return null;
      }
      const xy = chordOf(ax, ay, bx, by, cls, force ? null : roomOf(ax, ay, bx, by, inDir, outDir, obstacles, own, near, cls, wd));
      return xy;
    };
    // Breaks: none; then each single vertex; then every vertex.
    const tries: number[][] = [[]];
    for (let k = 1; k < n - 1; k++) tries.push([k]);
    if (n > 3) tries.push(Array.from({ length: n - 2 }, (_, k) => k + 1));
    for (let ti = 0; ti < tries.length; ti++) {
      const cuts = [0, ...tries[ti], n - 1];
      const last = ti === tries.length - 1;
      const out: number[] = [];
      let ok = true;
      for (let c = 1; c < cuts.length && ok; c++) {
        // Single edges are always allowed: they keep to the lattice.
        const r = run(cuts[c - 1], cuts[c], last || cuts[c] - cuts[c - 1] === 1);
        if (!r) ok = false;
        else out.push(...(out.length ? r.slice(2) : r));
      }
      if (ok) return { key, cls, xy: Float32Array.from(out) };
      if (last) return null;
    }
    return null;
  }

  /**
   * A straight run from A to B, shifted sideways to keep an easy, even grade; null if
   * it has water under it or (with `room`) leaves it.
   */
  function chordOf(ax: number, ay: number, bx: number, by: number, cls: RoadClass, room: ((x: number, y: number) => boolean) | null): number[] | null {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1) return [ax, ay, bx, by];
    const m = Math.max(2, Math.ceil(len / FIT_STEP));
    const xs: number[] = [];
    const ys: number[] = [];
    for (let s = 0; s <= m; s++) {
      xs.push(ax + ((bx - ax) * s) / m);
      ys.push(ay + ((by - ay) * s) / m);
    }
    fitToTerrain(xs, ys, MAX_GRADE[cls], zAt, wetCost, EASY_GRADE[cls]);
    const xy: number[] = [];
    for (let s = 0; s <= m; s++) xy.push(xs[s], ys[s]);
    if (wetLength(xy) > 0) return null;
    if (room) for (let s = 1; s < m; s++) if (!room(xs[s], ys[s])) return null;
    return xy;
  }

  /** Fitting penalty at world (x, y): in a lake, beside one, on a stream bed. */
  function wetCost(x: number, y: number): number {
    const i = Math.round(x / NODE) - p.gx;
    const j = Math.round(y / NODE) - p.gy;
    if (i < 0 || j < 0 || i >= w || j >= h) return 0;
    const k = j * w + i;
    return isLake(k) ? FIT_WATER : onShore(i, j) ? FIT_SHORE : p.A[k] > 1 ? FIT_STREAM : 0;
  }

  function curveOf(t: SegmentTask, rawA = false, rawB = false): SegmentPath {
    const [ax, ay] = rawA ? [t.ax, t.ay] : snap(t.ax, t.ay);
    const [bx, by] = rawB ? [t.bx, t.by] : snap(t.bx, t.by);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const tangent = (px: number, py: number, qx: number, qy: number, partner?: [number, number]): [number, number] => {
      if (!partner) return [(qx - px) * 0.5, (qy - py) * 0.5];
      const [fx, fy] = snap(partner[0], partner[1]);
      // Catmull–Rom, but never shorter than a quarter of the shorter leg: where the
      // road turns back (a hairpin) the plain tangent shrinks to a cusp.
      const tx = (qx - fx) * 0.5;
      const ty = (qy - fy) * 0.5;
      const L = Math.hypot(tx, ty) || 1e-6;
      const min = 0.25 * Math.min(Math.hypot(qx - px, qy - py), Math.hypot(fx - px, fy - py));
      const k = Math.max(1, min / L);
      return [tx * k, ty * k];
    };
    const [t0x, t0y] = tangent(ax, ay, bx, by, t.pa);
    const [m1x, m1y] = tangent(bx, by, ax, ay, t.pb);
    const t1x = -m1x;
    const t1y = -m1y;
    const n = Math.max(2, Math.ceil(len / FIT_STEP));
    const xs: number[] = [];
    const ys: number[] = [];
    for (let s = 0; s <= n; s++) {
      const u = s / n;
      const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
      const h10 = u ** 3 - 2 * u ** 2 + u;
      const h01 = -2 * u ** 3 + 3 * u ** 2;
      const h11 = u ** 3 - u ** 2;
      xs.push(h00 * ax + h10 * t0x + h01 * bx + h11 * t1x);
      ys.push(h00 * ay + h10 * t0y + h01 * by + h11 * t1y);
    }
    fitToTerrain(xs, ys, MAX_GRADE[t.cls], zAt, wetCost);
    const xy = new Float32Array(2 * (n + 1));
    for (let s = 0; s <= n; s++) {
      xy[2 * s] = xs[s];
      xy[2 * s + 1] = ys[s];
    }
    return { key: t.key, cls: t.cls, xy };
  }
}

/** Serpentines: a piece climbing more than SERP_TRIGGER × its class limit, mostly uphill. */
const SERP_TRIGGER = 1.3;
const SERP_UPHILL = 0.5;

/**
 * Whether a piece (vertices `pts`) is too steep for `gmax` on the fine terrain, and if
 * so its frame: e1 along the contour, e2 across it towards the piece's end. Uses
 * only the piece's own vertices and terrain inside it, so every chunk that sees the
 * piece decides alike. A piece running mostly along the contours doesn't count,
 * unless `anyWay`.
 */
function serpentineFrame(
  pts: number[],
  gmax: number,
  zAt: (x: number, y: number) => number,
  anyWay = false,
): { e1: [number, number]; e2: [number, number] } | null {
  const n = pts.length / 2;
  const ax = pts[0];
  const ay = pts[1];
  const bx = pts[2 * n - 2];
  const by = pts[2 * n - 1];
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  const dz = Math.abs(zAt(bx, by) - zAt(ax, ay));
  if (dz <= SERP_TRIGGER * gmax * len) return null;
  // Slope direction, averaged over three points inside the piece.
  let gx = 0;
  let gy = 0;
  for (const t of [0.25, 0.5, 0.75]) {
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    gx += zAt(px + 40, py) - zAt(px - 40, py);
    gy += zAt(px, py + 40) - zAt(px, py - 40);
  }
  const G = Math.hypot(gx, gy);
  if (G < 1e-6) return null;
  let e2: [number, number] = [gx / G, gy / G];
  if ((bx - ax) * e2[0] + (by - ay) * e2[1] < 0) e2 = [-e2[0], -e2[1]];
  const L = Math.hypot(bx - ax, by - ay);
  if (!anyWay && (bx - ax) * e2[0] + (by - ay) * e2[1] < SERP_UPHILL * L) return null; // mostly along the contour
  return { e1: [-e2[1], e2[0]], e2 };
}


/** Terrain fitting: samples every FIT_STEP m, shifted sideways by up to FIT_BAND m in FIT_OFFSET steps. */
const FIT_STEP = 10;
const FIT_BAND = 32;
const FIT_OFFSET = 8;
/** Per-sample penalties (m-equivalent) for standing in a lake, beside one, or on a stream bed. */
const FIT_WATER = 400;
const FIT_SHORE = 60;
const FIT_STREAM = 6;
/** Weights: steepness beyond the class limit, sideways change (smoothness), shift itself. */
const FIT_GRADE = 4;
const FIT_SMOOTH = 8;
const FIT_SHIFT = 2;
/**
 * Tracks and footpaths, fitted to an easy grade: weight of the grade against it (per m,
 * besides the length itself), and the band (m), widening over FIT_RAMP m from each
 * end (from nothing, and leaving the ends straight on) — room to bend with the contours.
 */
const FIT_EASY = 3;
const FIT_EASY_BAND = 64;
const FIT_RAMP = 120;

/**
 * Fits a drawn edge to the fine terrain: each interior sample may move sideways
 * (along the curve's normal) within a band that fades to nothing at both ends — so
 * the vertices, and the directions the curve shares there with its neighbours, stay
 * put. The best shifts (dynamic programming over samples × offsets) keep the road
 * gentle where the band allows, smooth, near its line, and out of lakes and off
 * stream beds. Uses only this edge and the terrain near it: every chunk draws it
 * the same.
 */
function fitToTerrain(
  xs: number[],
  ys: number[],
  gmax: number,
  zAt: (x: number, y: number) => number,
  wet: (x: number, y: number) => number,
  easy?: number,
): void {
  const n = xs.length - 1;
  if (n < 3) return;
  const B = easy ? FIT_EASY_BAND : FIT_BAND;
  const K = Math.round(B / FIT_OFFSET);
  const offs: number[] = [];
  for (let k = -K; k <= K; k++) offs.push(k * FIT_OFFSET);
  const O = offs.length;
  // Normals along the curve, and the band at each sample.
  const nx: number[] = [];
  const ny: number[] = [];
  const band: number[] = [];
  for (let s = 0; s <= n; s++) {
    const dx = xs[Math.min(n, s + 1)] - xs[Math.max(0, s - 1)];
    const dy = ys[Math.min(n, s + 1)] - ys[Math.max(0, s - 1)];
    const L = Math.hypot(dx, dy) || 1;
    nx.push(-dy / L);
    ny.push(dx / L);
    band.push(easy ? B * Math.sin((Math.PI / 2) * Math.min(1, (FIT_STEP * Math.min(s, n - s)) / FIT_RAMP)) ** 2 : B * Math.sin((Math.PI * s) / n) ** 2);
  }
  const px = (s: number, o: number) => xs[s] + offs[o] * nx[s];
  const py = (s: number, o: number) => ys[s] + offs[o] * ny[s];
  const z: number[][] = [];
  const node: number[][] = [];
  for (let s = 0; s <= n; s++) {
    z.push([]);
    node.push([]);
    for (let o = 0; o < O; o++) {
      const ok = Math.abs(offs[o]) <= band[s] + 1e-6;
      z[s].push(ok ? zAt(px(s, o), py(s, o)) : NaN);
      node[s].push(ok ? wet(px(s, o), py(s, o)) + FIT_SHIFT * (offs[o] / B) ** 2 : Infinity);
    }
  }
  const cost: number[][] = [node[0].slice()];
  const from: number[][] = [new Array(O).fill(-1)];
  for (let s = 1; s <= n; s++) {
    const c = new Array(O).fill(Infinity);
    const f = new Array(O).fill(-1);
    for (let o = 0; o < O; o++) {
      if (node[s][o] === Infinity) continue;
      for (let q = 0; q < O; q++) {
        if (cost[s - 1][q] === Infinity) continue;
        const ds = Math.hypot(px(s, o) - px(s - 1, q), py(s, o) - py(s - 1, q)) || 1;
        const g = Math.abs(z[s][o] - z[s - 1][q]) / ds;
        const over = Math.max(0, g - gmax) / gmax;
        const v =
          cost[s - 1][q] +
          node[s][o] +
          ds * FIT_GRADE * over * over +
          (easy ? ds * (1 + FIT_EASY * (g / easy) ** 2) : 0) +
          (FIT_SMOOTH * (offs[o] - offs[q]) ** 2) / ds;
        if (v < c[o]) {
          c[o] = v;
          f[o] = q;
        }
      }
    }
    cost.push(c);
    from.push(f);
  }
  // Chosen shifts, smoothed (a short binomial kernel) and kept within the band.
  const shift = new Array(n + 1).fill(0);
  let o = K; // the end itself: no shift
  for (let s = n; s >= 0; s--) {
    shift[s] = offs[o];
    const prev = from[s][o];
    if (prev >= 0) o = prev;
  }
  const smooth = shift.map((_, s) => {
    let a = 0;
    let wsum = 0;
    for (const [d, wt] of [[-2, 1], [-1, 4], [0, 6], [1, 4], [2, 1]]) {
      const k = Math.max(0, Math.min(n, s + d));
      a += wt * shift[k];
      wsum += wt;
    }
    return Math.max(-band[s], Math.min(band[s], a / wsum));
  });
  for (let s = 0; s <= n; s++) {
    xs[s] += smooth[s] * nx[s];
    ys[s] += smooth[s] * ny[s];
  }
}

/**
 * Micro routing: search band either side of the piece (m) by class — how far a
 * switchback's legs reach: long on roads, short on footpaths — then clearance kept
 * from other ways (m) except this near the piece's ends (m).
 */
const MICRO_BAND = [250, 220, 200, 60, 25];
const MICRO_CLEAR = 24;
const MICRO_FREE = 48;
/** Clearance (m) from the road's continuation beyond either end of a piece. */
const MICRO_BEYOND = 10;
/** Within this (m) of a piece's end, ways meeting there may be as close as they like. */
const MICRO_JUNCTION = 12;
/** Costs (m-equivalent): per 45° of turn, per unit of over-limit gradient per m, for
 * leaving off the road's arriving/leaving direction (per 45°), entering a stream bed. */
/**
 * Turn cost by class (per 45°): a hairpin on a wide road is costly to build, so main
 * roads turn back seldom, on long legs; a footpath zig-zags in short ones.
 */
const MICRO_TURN = [60, 45, 25, 15, 6];
const MICRO_STEEP = 25;
/** Weight of the grade (against the class's easy grade) per m: tracks and footpaths would
 * rather zig-zag than climb straight. */
const MICRO_GRADE_W = [0.5, 0.5, 0.5, 1.5, 1.5];
const MICRO_ENDS = 20;
const MICRO_STREAM = 15;
/** Water: per m of lake (a bridge or causeway), plus per crossing; per m on a dry node beside a lake. */
const MICRO_WATER = 12;
const MICRO_BRIDGE = 150;
const MICRO_SHORE = 3;
/**
 * Moves of the fine routing: 16 headings 22.5° apart (the 8 neighbours and knight's
 * moves between them), so a leg can follow the contours without stair-stepping
 * between two of 8 directions, which turn costs made dearer than a leg at the wrong
 * angle.
 */
const DX16 = [1, 2, 1, 1, 0, -1, -1, -2, -1, -2, -1, -1, 0, 1, 1, 2];
const DY16 = [0, 1, 1, 2, 1, 2, 1, 1, 0, -1, -1, -2, -1, -2, -1, -1];
const MDIST16 = DX16.map((dx, i) => Math.hypot(dx, DY16[i]) * NODE);
/** Largest radius (m) of a bend on a fine-routed piece, by class: hairpins are tight. */
const MICRO_RADIUS = [20, 15, 11, 8, 5];
/** Largest angle (rad) between a track's or footpath's straight run and its edge at a junction. */
const CHORD_SKEW = (12 * Math.PI) / 180;
/** Tracks and footpaths straighten their searched path over up to STRAIGHT_SPAN nodes, keeping within STRAIGHT_TOL (m, by class) of it. */
const STRAIGHT_SPAN = 48;
const STRAIGHT_TOL = [0, 0, 0, 24, 20];
/** Spacing (m) of points on fine-routed pieces: the renderer's smoothing (±3 points) then only softens them. */
const MICRO_STEP = 2;

/**
 * A polyline as straight runs joined by circular arcs: each corner gets the largest
 * radius up to `rmax` whose arc fits in half of either adjacent run, so where the road
 * turns back the bend is a tight hairpin and the legs stay straight. Sampled every
 * MICRO_STEP m.
 */
function filleted(pts: number[], rmax: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return resampled(pts);
  const out: number[] = [pts[0], pts[1]];
  // Where the previous arc ended (the run from there to the next corner is straight).
  let sx = pts[0];
  let sy = pts[1];
  for (let i = 1; i < n - 1; i++) {
    const px = pts[2 * i - 2], py = pts[2 * i - 1];
    const cx = pts[2 * i], cy = pts[2 * i + 1];
    const qx = pts[2 * i + 2], qy = pts[2 * i + 3];
    const l1 = Math.hypot(cx - px, cy - py);
    const l2 = Math.hypot(qx - cx, qy - cy);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const ux = (cx - px) / l1, uy = (cy - py) / l1;
    const vx = (qx - cx) / l2, vy = (qy - cy) / l2;
    const cos = Math.max(-1, Math.min(1, ux * vx + uy * vy));
    const theta = Math.acos(cos); // turn angle
    if (theta < 1e-3) continue;
    // Tangent length r·tan(θ/2), within half of each run (the first run counts from
    // the previous arc's end).
    const avail = Math.min(Math.hypot(cx - sx, cy - sy), 0.5 * l1, 0.5 * l2);
    const tanH = Math.tan(theta / 2);
    const r = Math.min(rmax, avail / tanH);
    const t = r * tanH;
    const ax = cx - ux * t, ay = cy - uy * t;
    const bx = cx + vx * t, by = cy + vy * t;
    pushLine(out, ax, ay);
    // Arc from a to b: centre at a + r·normal (towards the turn).
    const side = ux * vy - uy * vx > 0 ? 1 : -1;
    const ox = ax - side * uy * r, oy = ay + side * ux * r;
    const a0 = Math.atan2(ay - oy, ax - ox);
    const m = Math.max(1, Math.ceil((r * theta) / MICRO_STEP));
    for (let k = 1; k <= m; k++) {
      const a = a0 + (side * theta * k) / m;
      out.push(ox + r * Math.cos(a), oy + r * Math.sin(a));
    }
    sx = bx;
    sy = by;
  }
  pushLine(out, pts[2 * n - 2], pts[2 * n - 1]);
  return out;
}

/** Straight line from the last point of `out` to (x, y), every MICRO_STEP m. */
function pushLine(out: number[], x: number, y: number): void {
  const x0 = out[out.length - 2], y0 = out[out.length - 1];
  const m = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / MICRO_STEP));
  for (let k = 1; k <= m; k++) out.push(x0 + ((x - x0) * k) / m, y0 + ((y - y0) * k) / m);
}

function resampled(pts: number[]): number[] {
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) pushLine(out, pts[i], pts[i + 1]);
  return out;
}

/**
 * A steep piece routed on the fine terrain itself (16 m nodes, with heading: at most
 * 45° of turn per step, so a hairpin is a turn of some 20 m). The gradient is held near
 * the class limit, so where the slope is steep the road zig-zags across it, its legs
 * following the real contours. It stays within a band around the piece, clear of the
 * other ways near it, and goes round lakes — or, where the way round is too long or
 * leaves the band, crosses at a narrow place (only if `water`). A to B are the
 * piece's (snapped) ends.
 */
function microRoute(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  inDir: number[],
  outDir: number[],
  gmax: number,
  p: RoadPatch,
  zAt: (x: number, y: number) => number,
  obstacles: number[],
  own: number[],
  rivals: (Rival & { active: boolean })[],
  cls: RoadClass,
  wedges: number[],
): number[] {
  const { w, h } = p;
  // Tracks and footpaths don't cross water at all.
  const water = cls < ROAD_T;
  const node = (x: number, y: number) => [Math.round(x / NODE) - p.gx, Math.round(y / NODE) - p.gy];
  const [ia, ja] = node(ax, ay);
  const [ib, jb] = node(bx, by);
  const pad = Math.ceil(Math.max(MICRO_BAND[cls], MICRO_FREE) / NODE);
  const i0 = Math.max(1, Math.min(ia, ib) - pad);
  const j0 = Math.max(1, Math.min(ja, jb) - pad);
  const i1 = Math.min(w - 2, Math.max(ia, ib) + pad);
  const j1 = Math.min(h - 2, Math.max(ja, jb) + pad);
  const bw = i1 - i0 + 1;
  const bh = j1 - j0 + 1;
  // No way found: a straight line, sampled like a found one (so what lies under it,
  // such as water, is seen by the checks after routing).
  const straight = () => {
    const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 8));
    const xy: number[] = [];
    for (let s = 0; s <= m; s++) xy.push(ax + ((bx - ax) * s) / m, ay + ((by - ay) * s) / m);
    return xy;
  };
  if (bw < 2 || bh < 2) return straight();
  // Allowed nodes: in the band, clear of other ways (near the ends anything goes).
  const ok = new Uint8Array(bw * bh);
  const segDistTo = (x: number, y: number, s: number[], o: number) => {
    const dx = s[o + 2] - s[o];
    const dy = s[o + 3] - s[o + 1];
    const t = Math.max(0, Math.min(1, ((x - s[o]) * dx + (y - s[o + 1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - s[o] - t * dx, y - s[o + 1] - t * dy);
  };
  const allowed = roomOf(ax, ay, bx, by, inDir, outDir, obstacles, own, rivals, cls, wedges);
  for (let lj = 0; lj < bh; lj++)
    for (let li = 0; li < bw; li++) if (allowed((p.gx + li + i0) * NODE, (p.gy + lj + j0) * NODE)) ok[lj * bw + li] = 1;
  const la = (ja - j0) * bw + (ia - i0);
  const lb = (jb - j0) * bw + (ib - i0);
  if (la < 0 || lb < 0 || la >= bw * bh || lb >= bw * bh) return straight();
  ok[la] = ok[lb] = 1;
  const dirOf = (dx: number, dy: number) => ((Math.round((Math.atan2(dy, dx) / Math.PI) * 8) % 16) + 16) % 16;
  const hIn = dirOf(inDir[0], inDir[1]);
  const hOut = dirOf(outDir[0], outDir[1]);
  /** Turn between headings, in 22.5° steps. */
  const turn = (a: number, b: number) => Math.min((a - b + 16) & 15, (b - a + 16) & 15);
  const wet = (k: number) => !Number.isNaN(p.lake[k]);
  const shore = (k: number) => wet(k - 1) || wet(k + 1) || wet(k - w) || wet(k + w);
  const S = bw * bh * 16;
  const cost = new Float64Array(S).fill(Infinity);
  const from = new Int32Array(S).fill(-1);
  const heap = new MinHeap(512);
  const hEst = (li: number, lj: number) => Math.hypot(li + i0 - ib, lj + j0 - jb) * NODE;
  for (let d = 0; d < 16; d++) {
    cost[la * 16 + d] = (MICRO_ENDS / 2) * turn(d, hIn);
    heap.push(la * 16 + d, cost[la * 16 + d] + hEst(ia - i0, ja - j0));
  }
  let goal = -1;
  while (heap.size) {
    const st = heap.pop();
    const cell = st >> 4;
    const d0 = st & 15;
    if (cell === lb) {
      goal = st;
      break;
    }
    const li = cell % bw;
    const lj = (cell - li) / bw;
    const k = (lj + j0) * w + li + i0;
    for (let t = -4; t <= 4; t++) {
      const d = (d0 + t + 16) & 15;
      const ni = li + DX16[d];
      const nj = lj + DY16[d];
      if (ni < 0 || nj < 0 || ni >= bw || nj >= bh) continue;
      const nc = nj * bw + ni;
      if (!ok[nc]) continue;
      const q = (nj + j0) * w + ni + i0;
      const dist = MDIST16[d];
      const g = Math.abs(p.zE[q] - p.zE[k]) / dist;
      let c = cost[st] + dist * (1 + MICRO_GRADE_W[cls] * (g / EASY_GRADE[cls]) ** 2) + (MICRO_TURN[cls] / 2) * Math.abs(t);
      if (g > gmax) c += dist * MICRO_STEEP * (g / gmax - 1);
      if (wet(q)) {
        if (!water) continue;
        c += dist * MICRO_WATER + (wet(k) ? 0 : MICRO_BRIDGE);
      }
      else if (shore(q)) c += dist * MICRO_SHORE;
      else if (p.A[q] > 1 && p.A[k] <= 1) c += MICRO_STREAM;
      if (nc === lb) c += (MICRO_ENDS / 2) * turn(d, hOut);
      const ns = nc * 16 + d;
      if (c < cost[ns]) {
        cost[ns] = c;
        from[ns] = st;
        heap.push(ns, c + hEst(ni, nj));
      }
    }
  }
  if (goal < 0) return straight();
  const cells: number[] = [];
  for (let st = goal; st >= 0; st = from[st]) cells.push(st >> 4);
  cells.reverse();
  const pts: number[] = [];
  for (const c of cells) {
    const li = c % bw;
    const lj = (c - li) / bw;
    pts.push((p.gx + li + i0) * NODE, (p.gy + lj + j0) * NODE);
  }
  const wetCell = cells.map((c) => wet((Math.floor(c / bw) + j0) * w + (c % bw) + i0));
  pts[0] = ax;
  pts[1] = ay;
  pts[pts.length - 2] = bx;
  pts[pts.length - 1] = by;
  // Straighten the 8-direction staircase where the shortcut keeps to the limit and
  // clear of other ways; hairpins survive because they're needed. Tracks and footpaths
  // straighten much further — wherever the straight line climbs no worse than the
  // searched path and stays where it may go — so they run straight on the flat (the
  // search's 16 headings would leave doglegs) and follow the contours on a slope.
  const soft = cls >= ROAD_T;
  /** Cost of a straight run, as the search counts it (sampled every 8 m). */
  const runCost = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const m = Math.max(1, Math.ceil(len / 8));
    let c = 0;
    let zp = zAt(x0, y0);
    for (let s2 = 1; s2 <= m; s2++) {
      const z = zAt(x0 + ((x1 - x0) * s2) / m, y0 + ((y1 - y0) * s2) / m);
      const g = Math.abs(z - zp) / (len / m);
      c += (len / m) * (1 + MICRO_GRADE_W[cls] * (g / EASY_GRADE[cls]) ** 2 + (g > gmax ? MICRO_STEEP * (g / gmax - 1) : 0));
      zp = z;
    }
    return c;
  };
  const okAt = (x: number, y: number) => {
    const li = Math.round(x / NODE) - p.gx - i0;
    const lj = Math.round(y / NODE) - p.gy - j0;
    return li >= 0 && lj >= 0 && li < bw && lj < bh && ok[lj * bw + li] === 1;
  };
  const n = pts.length / 2;
  // Cost of the searched path from its start to each point.
  const along = [0];
  for (let k2 = 1; k2 < n && soft; k2++) along.push(along[k2 - 1] + runCost(pts[2 * k2 - 2], pts[2 * k2 - 1], pts[2 * k2], pts[2 * k2 + 1]));
  const outPts: number[] = [pts[0], pts[1]];
  let i = 0;
  while (i < n - 1) {
    let j = Math.min(n - 1, i + (soft ? STRAIGHT_SPAN : 12));
    for (; j > i + 1; j--) {
      const x0 = pts[2 * i];
      const y0 = pts[2 * i + 1];
      const x1 = pts[2 * j];
      const y1 = pts[2 * j + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const m = Math.max(1, Math.ceil(len / 8));
      // Close to the searched path (a hairpin is never cut)…
      let good = true;
      for (let k2 = i + 1; k2 < j && good; k2++) {
        if (soft) {
          if (segDistTo(pts[2 * k2], pts[2 * k2 + 1], [x0, y0, x1, y1], 0) > STRAIGHT_TOL[cls]) good = false;
          continue;
        }
        const u = (k2 - i) / (j - i);
        if (Math.hypot(pts[2 * k2] - (x0 + (x1 - x0) * u), pts[2 * k2 + 1] - (y0 + (y1 - y0) * u)) > 10) good = false;
      }
      // …and within the limit all along (tracks and footpaths: no dearer than the
      // path, and where it may go), and not across water the path went round.
      if (good && soft && runCost(x0, y0, x1, y1) > along[j] - along[i]) good = false;
      const dry = !wetCell.slice(i, j + 1).some((x) => x);
      let zp = zAt(x0, y0);
      for (let s2 = 1; s2 <= m && good; s2++) {
        const sx = x0 + ((x1 - x0) * s2) / m;
        const sy = y0 + ((y1 - y0) * s2) / m;
        const z = zAt(sx, sy);
        if (soft ? s2 < m && !okAt(sx, sy) : Math.abs(z - zp) / (len / m) > gmax * 1.1) good = false;
        if (dry && wet((Math.round(sy / NODE) - p.gy) * w + Math.round(sx / NODE) - p.gx)) good = false;
        zp = z;
      }
      if (good) break;
    }
    outPts.push(pts[2 * j], pts[2 * j + 1]);
    i = j;
  }
  // The search ran between the grid nodes nearest the ends; the ends themselves may
  // lie behind them. Rounded, that back-step would be a small curl.
  trimSpikes(outPts);
  cutLoops(outPts);
  return filleted(outPts, MICRO_RADIUS[cls]);
}

/** Distance from (x, y) to segment o of the flat list s ([ax, ay, bx, by, …]). */
function segDist(x: number, y: number, s: number[], o: number): number {
  const dx = s[o + 2] - s[o];
  const dy = s[o + 3] - s[o + 1];
  const t = Math.max(0, Math.min(1, ((x - s[o]) * dx + (y - s[o + 1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - s[o] - t * dx, y - s[o + 1] - t * dy);
}

/**
 * Where a run from A to B (vertices `own`) may go: within its band either side of
 * the line A–B; against a rival that may wind too, nearer this run's line than
 * `weight` × the rival's; against one that won't, its fitted band and clearance away
 * unless nearer this line; never across the road's own continuation beyond either
 * end; within the wedges at its ends; and clear of other ways (near the ends only a
 * little, as junctions are close, and right at the junction not at all).
 */
function roomOf(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  inDir: number[],
  outDir: number[],
  obstacles: number[],
  own: number[],
  rivals: (Rival & { active: boolean })[],
  cls: RoadClass,
  wedges: number[],
): (x: number, y: number) => boolean {
  const ab = [ax, ay, bx, by];
  const polyDist = (x: number, y: number, pl: number[]) => {
    let d = Infinity;
    for (let o = 0; o + 3 < pl.length; o += 2) d = Math.min(d, segDist(x, y, pl, o));
    return d;
  };
  const ownSide = (x: number, y: number) => {
    const dP = polyDist(x, y, own);
    for (const r of rivals) {
      const dQ = polyDist(x, y, r.pts);
      if (r.active ? dP > r.weight * dQ : dQ < FIT_BAND + MICRO_CLEAR && dP > dQ) return false;
    }
    return true;
  };
  // Wedges from the snapped ends, where the run starts and stops.
  wedges = wedges.slice();
  if (wedges.length >= 2 * WEDGE) [wedges[0], wedges[1], wedges[WEDGE], wedges[WEDGE + 1]] = [ax, ay, bx, by];
  const ray = (x: number, y: number, dx: number, dy: number) => {
    const L = Math.hypot(dx, dy) || 1;
    return [x + (dx / L) * MICRO_BEYOND * 1.5, y + (dy / L) * MICRO_BEYOND * 1.5, x + (dx / L) * MICRO_FREE * 1.5, y + (dy / L) * MICRO_FREE * 1.5];
  };
  const beyondA = ray(ax, ay, -inDir[0], -inDir[1]);
  const beyondB = ray(bx, by, outDir[0], outDir[1]);
  return (x, y) => {
    if (segDist(x, y, ab, 0) > Math.max(MICRO_BAND[cls], MICRO_FREE)) return false;
    if (!ownSide(x, y)) return false;
    // Never across the road's own continuation beyond either end (a tight turn there
    // would curl round it, losing height in a loop).
    if (segDist(x, y, beyondA, 0) < MICRO_BEYOND || segDist(x, y, beyondB, 0) < MICRO_BEYOND) return false;
    if (!inWedges(wedges, x, y)) return false;
    const dA = Math.hypot(x - ax, y - ay);
    const dB = Math.hypot(x - bx, y - by);
    const nearEnd = dA < MICRO_FREE || dB < MICRO_FREE;
    const need = !nearEnd ? MICRO_CLEAR : Math.min(dA, dB) < MICRO_JUNCTION ? 0 : MICRO_BEYOND;
    if (need > 0) for (let o = 0; o + 3 < obstacles.length; o += 4) if (segDist(x, y, obstacles, o) < need) return false;
    return true;
  };
}

/**
 * Removes loops where a polyline crosses itself (the search's states carry a heading,
 * so a path can come back over its own track): the part between the two crossing
 * segments goes, and the line passes through the crossing point.
 */
function cutLoops(pts: number[]): void {
  for (let changed = true; changed; ) {
    changed = false;
    const n = pts.length / 2;
    for (let i = 0; i + 1 < n && !changed; i++)
      for (let j = n - 2; j >= i + 2 && !changed; j--) {
        const [x1, y1, x2, y2] = [pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3]];
        const [x3, y3, x4, y4] = [pts[2 * j], pts[2 * j + 1], pts[2 * j + 2], pts[2 * j + 3]];
        const den = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
        if (Math.abs(den) < 1e-9) continue;
        const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / den;
        const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / den;
        if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
        pts.splice(2 * i + 2, 2 * (j - i), x1 + t * (x2 - x1), y1 + t * (y2 - y1));
        changed = true;
      }
  }
}

/** Wedges are narrowed to this share, so runs in neighbouring wedges keep a gap. */
const WEDGE_SHARE = 0.9;

/** Inside every wedge (see `Wedge`), or within MICRO_JUNCTION of its vertex? */
function inWedges(wedges: number[], x: number, y: number): boolean {
  for (let o = 0; o + WEDGE - 1 < wedges.length; o += WEDGE) {
    const dx = x - wedges[o];
    const dy = y - wedges[o + 1];
    if (Math.hypot(dx, dy) < MICRO_JUNCTION) continue;
    let rel = Math.atan2(dy, dx) - wedges[o + 2];
    rel -= 2 * Math.PI * Math.round(rel / (2 * Math.PI));
    if (rel > WEDGE_SHARE * wedges[o + 3] || -rel > WEDGE_SHARE * wedges[o + 4]) return false;
  }
  return true;
}

/** Drops points next to either end where the line doubles back (> 90°) within a short end segment. */
function trimSpikes(pts: number[]): void {
  const turnsBack = (i: number) => {
    const ux = pts[2 * i] - pts[2 * i - 2], uy = pts[2 * i + 1] - pts[2 * i - 1];
    const vx = pts[2 * i + 2] - pts[2 * i], vy = pts[2 * i + 3] - pts[2 * i + 1];
    return ux * vx + uy * vy < 0;
  };
  const short = (i: number, j: number) => Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]) < 1.5 * NODE;
  while (pts.length >= 8 && short(0, 1) && turnsBack(1)) pts.splice(2, 2);
  while (pts.length >= 8) {
    const n = pts.length / 2;
    if (!(short(n - 2, n - 1) && turnsBack(n - 2))) break;
    pts.splice(2 * (n - 2), 2);
  }
}
