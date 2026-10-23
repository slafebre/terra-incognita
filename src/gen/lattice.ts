import { CHUNK } from '../lib/constants';
import { hash3 } from '../lib/hash';
import { MinHeap } from '../lib/heap';
import { smoothstep } from '../lib/noise';
import { type CoarseField, NODE } from './hydro';
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
 *  1. Edge costs per road class: length, gradient against the class's limit (steep
 *     edges very dear: roads zig-zag up the lattice instead), cheaper on valley
 *     floors, plus a fixed tie-break so best paths are unique.
 *  2. Main roads: for each town pair (N) and village pair (D) of the relative-
 *     neighbourhood graphs, the cheapest path inside a fixed corridor around the
 *     pair, turns costing a little. The corridor makes it the same in every cell.
 *  3. Hamlet roads: the cheapest-path forest grown out from the main network; each
 *     hamlet's road follows it back, so nearby hamlets' roads merge like streams.
 *  4. Shortcuts: neighbouring settlements that the roads so far join only by a long
 *     way round get a direct minor road, or a footpath where a road would be too steep.
 *  5. Farm roads: grown like hamlet roads, from all roads so far.
 *  6. Tracks: scattered points far from any road get a track back to the network,
 *     grown as one forest so nearby tracks merge.
 *
 * Output: every used lattice edge, owned by the cell holding its midpoint. Geometry
 * comes later (routeCurves): one smooth curve per edge, through the two vertices,
 * with directions at each vertex shared by the roads that continue through it.
 */

export const LATTICE = 150;
const ROW = (LATTICE * Math.sqrt(3)) / 2;
/** Vertex jitter radius: well below the 0.29 × spacing at which triangles could flip. */
const JITTER = 0.22 * LATTICE;

/** Valley floors (drainage area ramp, km²) cost up to VALLEY_BONUS less. */
const VALLEY_AREA = [0.3, 4];
const VALLEY_BONUS = 0.3;
/** Main roads: turning by θ costs TURN_COST × (1 − cos θ) (m). */
const TURN_COST = 25;
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
/** Tracks: share of vertices that want one, if no road within TRACK_GAP (m); not above
 * TRACK_ALT (m), nor where every way out is steeper than TRACK_STEEP; reach (m). */
const TRACK_DENSITY = 0.14;
const TRACK_GAP = 200;
const TRACK_ALT = 2300;
const TRACK_STEEP = 0.5;
const TRACK_REACH = 1200;

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
const vj = (v: number) => (v % SPAN) - OFF;

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

/** Terrain at vertices, cached per field. */
const vertexCache = new WeakMap<CoarseField, Map<number, { x: number; y: number; z: number; area: number; valley: number }>>();
function vdata(field: CoarseField, v: number) {
  let m = vertexCache.get(field);
  if (!m) vertexCache.set(field, (m = new Map()));
  let d = m.get(v);
  if (!d) {
    const [x, y] = vertexPos(v);
    const area = field.area(x, y);
    d = { x, y, z: field.z(x, y), area, valley: smoothstep(VALLEY_AREA[0], VALLEY_AREA[1], area) };
    m.set(v, d);
  }
  return d;
}

/** Cost of edge u–v for a road class (symmetric). */
const costCache = new WeakMap<CoarseField, Map<number, number>>();
/** Paths between site pairs, per field (see corridorPath). */
const pathCache = new WeakMap<CoarseField, Map<string, [number, number][] | null>>();
/** Direction from vertex v to its neighbour w, 0..8 (4 is v itself). */
const dirCode = (v: number, w: number) => (vj(w) - vj(v) + 1) * 3 + (vi(w) - vi(v) + 1);
function edgeCost(field: CoarseField, u: number, v: number, cls: RoadClass): number {
  let m = costCache.get(field);
  if (!m) costCache.set(field, (m = new Map()));
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
 * the edge's direction across SLOPE_BASE m around its middle. Plus whether it
 * crosses a stream (much more drainage under its middle than at its ends).
 */
const SLOPE_BASE = 500;
const terrainCache = new WeakMap<CoarseField, Map<number, { grade: number; stream: number }>>();
function edgeTerrain(field: CoarseField, u: number, v: number): { grade: number; stream: number } {
  let m = terrainCache.get(field);
  if (!m) terrainCache.set(field, (m = new Map()));
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
    stream: mid > 2 * Math.max(a.area, b.area) ? mid : 0,
  };
  m.set(key, r);
  return r;
}
/** Coarse gradient around edge u–v, along it, over SLOPE_BASE. */
function edgeGrade(field: CoarseField, u: number, v: number): number {
  return edgeTerrain(field, u, v).grade;
}
/** Slope penalty weight and cap (× length): soft — at this scale it is only a tendency. */
const SLOPE_W = 1.5;
const SLOPE_CAP = 6;
/** Crossing a stream draining more than BRIDGE_AREA km² costs a bridge (m), more for a river. */
const BRIDGE_AREA = 1;
const BRIDGE_COST = 40;
function edgeCostRaw(field: CoarseField, u: number, v: number, cls: RoadClass): number {
  const a = vdata(field, u);
  const b = vdata(field, v);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const { grade: g, stream } = edgeTerrain(field, u, v);
  let c = len * Math.min(SLOPE_CAP, 1 + SLOPE_W * (g / MAX_GRADE[cls]) ** 2);
  if (stream > BRIDGE_AREA) c += BRIDGE_COST * (1 + Math.log10(stream / BRIDGE_AREA));
  c *= 1 - (VALLEY_BONUS * (a.valley + b.valley)) / 2;
  const lo = Math.min(u, v);
  const hi = Math.max(u, v);
  c *= 1 + 0.01 * (hash3(hash3(0x7e1d9, vi(lo), vj(lo)), vi(hi), vj(hi)) / 4294967296);
  return c;
}
/** No edge costs less than this × its length (for A* estimates). */
const MIN_FACTOR = 1 - VALLEY_BONUS;

export function latticeCell(gx: number, gy: number, field: CoarseField, set: Settlements, terrain?: Terrain): NetCell {
  if (DEBUG_PATHS) DEBUG_TERRAIN = terrain;
  const x0 = gx * NET_CELL;
  const y0 = gy * NET_CELL;
  const x1 = x0 + NET_CELL;
  const y1 = y0 + NET_CELL;
  const inBox = (s: { x: number; y: number }, m: number) => s.x >= x0 - m && s.x < x1 + m && s.y >= y0 - m && s.y < y1 + m;
  const sitesIn = (rank: 0 | 1 | 2 | 3, m: number) => set.sitesIn(rank, x0 - m, y0 - m, x1 + m, y1 + m);
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const pos = (v: number) => vdata(field, v);

  // Regions (margins around the cell): farm roads that may pass through the cell,
  // the hamlet roads they grow from, the main roads those grow from.
  // Each stage grows from the previous one, so each needs the previous known a bit
  // further out: tracks that may cross the cell, the roads they grow from, farm
  // roads, the shortcuts and hamlet roads those grow from, the main roads below.
  const trackM = TRACK_REACH;
  const farmM = trackM + TRACK_REACH;
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
    let paths = pathCache.get(field);
    if (!paths) pathCache.set(field, (paths = new Map()));
    if (paths.has(ck)) return paths.get(ck)!;
    const d = dist(a, b);
    const reach = CORRIDOR * d + extra;
    const inside = (v: number) => {
      const p = pos(v);
      return dist(p, a) + dist(p, b) <= reach;
    };
    const va = nearestVertex(a.x, a.y);
    const vb = nearestVertex(b.x, b.y);
    const pb = pos(vb);
    // States: (vertex, the neighbour it was entered from), for turn costs; packed as
    // vertex × 9 + direction code (4 = the start, entered from nowhere).
    const key = (v: number, from: number) => v * 9 + (from < 0 ? 4 : dirCode(v, from));
    const cost = new Map<number, number>();
    const prev = new Map<number, number>();
    const states: [number, number][] = [[va, -1]];
    const heap = new MinHeap(256);
    cost.set(key(va, -1), 0);
    heap.push(0, MIN_FACTOR * dist(pos(va), pb));
    const done = new Set<number>();
    let goal = -1;
    let goalState: [number, number] = [va, -1];
    const stateOf = new Map<number, [number, number]>();
    while (heap.size) {
      const st = states[heap.pop()];
      const [v, from] = st;
      const sk = key(v, from);
      if (done.has(sk)) continue;
      done.add(sk);
      stateOf.set(sk, st);
      if (v === vb) {
        goal = sk;
        goalState = st;
        break;
      }
      const pv = pos(v);
      const c0 = cost.get(sk)!;
      for (const w of neighbours(v)) {
        if (w === from || !inside(w)) continue;
        const pw = pos(w);
        let c = c0 + edgeCost(field, v, w, k);
        if (from >= 0) {
          const pf = pos(from);
          const ux = pv.x - pf.x;
          const uy = pv.y - pf.y;
          const wx = pw.x - pv.x;
          const wy = pw.y - pv.y;
          const cos = (ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy));
          c += TURN_COST * (1 - cos);
        }
        const nk = key(w, v);
        if (c >= (cost.get(nk) ?? Infinity)) continue;
        cost.set(nk, c);
        prev.set(nk, sk);
        states.push([w, v]);
        heap.push(states.length - 1, c + MIN_FACTOR * dist(pw, pb));
      }
    }
    let out: [number, number][] | null = null;
    if (goal >= 0) {
      out = [];
      let [v, from] = goalState;
      for (let s = goal; prev.has(s); s = prev.get(s)!) {
        out.push([from, v]);
        [v, from] = stateOf.get(prev.get(s)!)!;
      }
    }
    if (paths.size > 20000) paths.delete(paths.keys().next().value!);
    paths.set(ck, out);
    if (out && k <= ROAD_D) DEBUG_PATHS?.push({ k, edges: out, field });
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
  const forest = (sources: Set<number>, m: number, reach: number, k: RoadClass = ROAD_C): Map<number, number> => {
    const parent = new Map<number, number>();
    const cost = new Map<number, number>();
    const heap = new MinHeap(1024);
    const ids: number[] = [];
    for (const s of sources) {
      cost.set(s, 0);
      ids.push(s);
      heap.push(ids.length - 1, 0);
    }
    const done = new Set<number>();
    while (heap.size) {
      const v = ids[heap.pop()];
      if (done.has(v)) continue;
      done.add(v);
      const c0 = cost.get(v)!;
      for (const w of neighbours(v)) {
        if (!inBox(pos(w), m)) continue;
        const c = c0 + edgeCost(field, v, w, k);
        if (c > reach || c >= (cost.get(w) ?? Infinity)) continue;
        cost.set(w, c);
        parent.set(w, v);
        ids.push(w);
        heap.push(ids.length - 1, c);
      }
    }
    return parent;
  };
  /** Vertices on roads (not tracks or paths), plus the given sites'. */
  const roadVertices = (extra: Site[]) => {
    const s = new Set<number>();
    for (const e of cls.values()) if (e.c <= ROAD_C) s.add(e.u).add(e.v);
    for (const t of extra) s.add(nearestVertex(t.x, t.y));
    return s;
  };
  const follow = (parent: Map<number, number>, from: number, k: RoadClass) => {
    for (let v = from; parent.has(v); v = parent.get(v)!) use(v, parent.get(v)!, k);
  };

  // 3. Hamlet roads.
  const tvNear = tv.filter((s) => inBox(s, hamletForestM));
  const pA = forest(roadVertices(tvNear), hamletForestM, HAMLET_REACH * COST_CAP);
  const hamlets = sitesIn(HAMLET, hamletM);
  for (const h of hamlets) follow(pA, nearestVertex(h.x, h.y), ROAD_C);

  // 4. Shortcuts: neighbouring settlements (Gabriel pairs) that the roads so far
  // join only by a long way round get a direct minor road — or, where that would
  // be too steep, a footpath. Decided on main and hamlet roads only, never on other
  // shortcuts, so every cell decides each pair alike.
  {
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
    const settled = [...tv.filter((s) => inBox(s, shortM + SHORT_MAX / 2)), ...hamlets.filter((s) => inBox(s, shortM + SHORT_MAX / 2))];
    const grid = new Grid(settled, 1024);
    const added: [number, number, RoadClass][] = [];
    for (const a of settled)
      for (const b of grid.near(a.x, a.y, SHORT_MAX)) {
        if (a.id >= b.id) continue;
        const d = dist(a, b);
        if (d < SHORT_MIN || !inBox({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, shortM)) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (grid.near(mx, my, d / 2 - 1e-6).some((c) => c !== a && c !== b)) continue; // Gabriel
        const va = nearestVertex(a.x, a.y);
        const vb = nearestVertex(b.x, b.y);
        if (netDist(va, vb, SHORT_RATIO * d) <= SHORT_RATIO * d) continue;
        for (const k of [ROAD_C, ROAD_P] as RoadClass[]) {
          const p = corridorPath(k, a, b, SHORT_EXTRA);
          if (!p) continue;
          const len = p.reduce((s, [u, v]) => s + dist(pos(u), pos(v)), 0);
          const steep = p.some(([u, v]) => edgeGrade(field, u, v) > SHORT_STEEP * MAX_GRADE[k]);
          if (len > SHORT_DETOUR * d || steep) continue;
          for (const [u, v] of p) added.push([u, v, k]);
          break;
        }
      }
    for (const [u, v, k] of added) use(u, v, k);
  }

  // 5. Farm roads.
  const pB = forest(roadVertices([...tvNear, ...hamlets]), farmForestM, FARM_REACH * COST_CAP);
  const farms = sitesIn(FARM, farmM);
  for (const f of farms) follow(pB, nearestVertex(f.x, f.y), ROAD_C);

  // 6. Tracks: scattered points of open land and forest far from any road get a
  // track back to the network, grown as one forest so nearby tracks merge.
  {
    const roadPts = new Grid(
      [...roadVertices([])].map((v) => pos(v)),
      512,
    );
    const pT = forest(roadVertices([]), farmM, TRACK_REACH * COST_CAP, ROAD_T);
    const box = { x0: x0 - trackM, y0: y0 - trackM, x1: x1 + trackM, y1: y1 + trackM };
    for (const v of verticesIn(box)) {
      if (hash3(0x7ac4, vi(v), vj(v)) / 4294967296 >= TRACK_DENSITY) continue;
      const p = pos(v);
      if (p.z > TRACK_ALT || roadPts.near(p.x, p.y, TRACK_GAP).length) continue;
      if (neighbours(v).some((w) => edgeGrade(field, v, w) > TRACK_STEEP)) continue;
      follow(pT, v, ROAD_T);
    }
  }

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
  const out: SegmentTask[] = [];
  for (const e of edges) {
    const [ax, ay, bx, by] = e.route;
    if (Math.floor((ax + bx) / 2 / CHUNK) !== cx || Math.floor((ay + by) / 2 / CHUNK) !== cy) continue;
    out.push({
      key: e.id,
      cls: e.cls,
      ax,
      ay,
      bx,
      by,
      curve: true,
      pa: partner.get(`${e.id}@${k2(ax, ay)}`),
      pb: partner.get(`${e.id}@${k2(bx, by)}`),
    });
  }
  return out;
}

/** Snap radius (fine nodes) for vertices: onto gentler, dry ground nearby. */
const VSNAP = 2;

/**
 * One curve per lattice edge: cubic Hermite between its two (snapped) vertices.
 * At a vertex the road continues through, the direction is the line between its
 * neighbours on either side (Catmull–Rom), the same for both edges — so curves join
 * smoothly; a sharp turn there becomes a hairpin bend. A road ending at a vertex,
 * or meeting a through road there, arrives straight.
 */
export function routeCurves(tasks: SegmentTask[], p: RoadPatch): SegmentPath[] {
  const { w, h } = p;
  const snap = (x: number, y: number): [number, number] => {
    const ci = Math.round(x / NODE) - p.gx;
    const cj = Math.round(y / NODE) - p.gy;
    let best: [number, number] = [x, y];
    let bs = Infinity;
    for (let dj = -VSNAP; dj <= VSNAP; dj++)
      for (let di = -VSNAP; di <= VSNAP; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 1 || j < 1 || i >= w - 1 || j >= h - 1) continue;
        const k = j * w + i;
        if (!Number.isNaN(p.lake[k])) continue;
        const slope = Math.hypot(p.zE[k + 1] - p.zE[k - 1], p.zE[k + w] - p.zE[k - w]) / (2 * NODE);
        const s = 10 * slope + (p.A[k] > 0.3 ? 2 : 0) + 0.1 * Math.hypot(di, dj);
        if (s < bs) {
          bs = s;
          best = [(p.gx + i) * NODE, (p.gy + j) * NODE];
        }
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
  return tasks.map((t) => {
    const [ax, ay] = snap(t.ax, t.ay);
    const [bx, by] = snap(t.bx, t.by);
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
    fitToTerrain(xs, ys, MAX_GRADE[t.cls], zAt, (x, y) => {
      const i = Math.round(x / NODE) - p.gx;
      const j = Math.round(y / NODE) - p.gy;
      if (i < 0 || j < 0 || i >= w || j >= h) return 0;
      const k = j * w + i;
      return !Number.isNaN(p.lake[k]) ? FIT_WATER : p.A[k] > 1 ? FIT_STREAM : 0;
    });
    const xy = new Float32Array(2 * (n + 1));
    for (let s = 0; s <= n; s++) {
      xy[2 * s] = xs[s];
      xy[2 * s + 1] = ys[s];
    }
    return { key: t.key, cls: t.cls, xy, curve: true };
  });
}

/** Terrain fitting: samples every FIT_STEP m, shifted sideways by up to FIT_BAND m in FIT_OFFSET steps. */
const FIT_STEP = 10;
const FIT_BAND = 32;
const FIT_OFFSET = 8;
/** Per-sample penalties (m-equivalent) for standing in a lake or on a stream bed. */
const FIT_WATER = 400;
const FIT_STREAM = 6;
/** Weights: steepness beyond the class limit, sideways change (smoothness), shift itself. */
const FIT_GRADE = 4;
const FIT_SMOOTH = 8;
const FIT_SHIFT = 2;

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
): void {
  const n = xs.length - 1;
  if (n < 3) return;
  const K = Math.round(FIT_BAND / FIT_OFFSET);
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
    band.push(FIT_BAND * Math.sin((Math.PI * s) / n) ** 2);
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
      node[s].push(ok ? wet(px(s, o), py(s, o)) + FIT_SHIFT * (offs[o] / FIT_BAND) ** 2 : Infinity);
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
        const over = Math.max(0, Math.abs(z[s][o] - z[s - 1][q]) / ds - gmax) / gmax;
        const v = cost[s - 1][q] + node[s][o] + ds * FIT_GRADE * over * over + (FIT_SMOOTH * (offs[o] - offs[q]) ** 2) / ds;
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
