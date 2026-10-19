import { CHUNK } from '../lib/constants';
import { MinHeap } from '../lib/heap';
import { COARSE, type CoarseField, DX, DY, NODE } from './hydro';
import { HAMLET, type Site, Settlements, TOWN, VILLAGE } from './settle';

/**
 * Road network — topology and corridors from the coarse terrain, geometry from
 * the fine eroded surface.
 *
 *  - Net cells (NET_CELL m square) own the sites inside them and the edges whose
 *    first endpoint (by id) they own. Edges come from relative-neighbourhood
 *    graphs per class: towns ↔ towns (N), anything involving a village (D),
 *    anything involving a hamlet (C). Every edge ends at a site: no dead ends.
 *  - Each edge is routed on the coarse grid (A*, gradient and river costs),
 *    giving waypoints every ~256 m.
 *  - Between consecutive waypoints, a fine A* on the 16 m surface — with heading
 *    in the state and a hard gradient limit — draws the actual road, hairpins
 *    and all. Waypoints are snapped and given headings by a local rule, so the
 *    fine segments (owned by different chunks) join up.
 */

export const NET_CELL = 8192;
/**
 * How far around a net cell the coarse terrain is consulted (m): D roads in the
 * D_ZONE, their neighbourhood, the sites deciding those, and coarse tile reach.
 */
export const NET_REACH = 44000;
/** D roads with an endpoint this far around a cell are routed by it (m). */
const D_ZONE = 9300;
export const ROAD_N = 0;
export const ROAD_D = 1;
export const ROAD_C = 2;
export type RoadClass = typeof ROAD_N | typeof ROAD_D | typeof ROAD_C;

/** Maximum sustained gradient per class. */
export const MAX_GRADE = [0.07, 0.1, 0.15];
/** Longest edge per class (m). */
const MAX_LEN = [9000, 4500, 1600];

export interface RoadEdge {
  id: string;
  cls: RoadClass;
  a: Site;
  b: Site;
  /** Waypoints [x0, y0, x1, y1, …] from a to b (world metres). */
  route: number[];
}

export interface NetCell {
  sites: Site[];
  edges: RoadEdge[];
}

const cellOf = (x: number) => Math.floor(x / NET_CELL);

/** Relative neighbourhood graph test: no other site is closer to both a and b. */
function rngEdge(a: Site, b: Site, others: Site[]): boolean {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  for (const c of others) {
    if (c === a || c === b) continue;
    if (Math.max(Math.hypot(a.x - c.x, a.y - c.y), Math.hypot(b.x - c.x, b.y - c.y)) < d) return false;
  }
  return true;
}

export function netCell(gx: number, gy: number, field: CoarseField, set: Settlements): NetCell {
  const x0 = gx * NET_CELL;
  const y0 = gy * NET_CELL;
  const x1 = x0 + NET_CELL;
  const y1 = y0 + NET_CELL;
  const box = (m: number) => [x0 - m, y0 - m, x1 + m, y1 + m] as const;
  const inBox = (s: { x: number; y: number }, m: number) => s.x >= x0 - m && s.x < x1 + m && s.y >= y0 - m && s.y < y1 + m;
  const inCell = (s: Site) => inBox(s, 0);
  const sites = (rank: 0 | 1 | 2, m: number) => set.sitesIn(rank, ...box(m));
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  const edges: RoadEdge[] = [];

  // N: towns ↔ towns (owned edges only).
  const towns = sites(TOWN, MAX_LEN[ROAD_N]); // an RNG blocker is within MAX_LEN of an endpoint
  for (const a of towns)
    for (const b of towns) {
      if (a.id >= b.id || !inCell(a) || dist(a, b) > MAX_LEN[ROAD_N] || !rngEdge(a, b, towns)) continue;
      edges.push({ id: `${a.id}|${b.id}`, cls: ROAD_N, a, b, route: coarseRoute(a, b, field) });
    }

  // D: villages ↔ villages / towns. Every D edge near the cell is routed (not only
  // owned ones): hamlet roads join D roads at their waypoints, and every cell must
  // agree on where those are. D routes depend only on sites, never on other roads.
  const tv = [...sites(TOWN, D_ZONE + MAX_LEN[ROAD_D]), ...sites(VILLAGE, D_ZONE + MAX_LEN[ROAD_D])];
  const trunk: RoadEdge[] = [];
  for (const a of tv)
    for (const b of tv) {
      if (a.id >= b.id || (a.rank === TOWN && b.rank === TOWN)) continue;
      if (!inBox(a, D_ZONE) && !inBox(b, D_ZONE)) continue;
      if (dist(a, b) > MAX_LEN[ROAD_D] || !rngEdge(a, b, tv)) continue;
      const e: RoadEdge = { id: `${a.id}|${b.id}`, cls: ROAD_D, a, b, route: coarseRoute(a, b, field) };
      trunk.push(e);
      if (inCell(a)) edges.push(e);
    }

  // C: each hamlet gets one road to the nearest of: a D-road waypoint, a village or
  // town, or a hamlet that is itself closer to that network. This forms trees that
  // drain into the network (no parallel roads), and junctions sit exactly on a D
  // road's waypoint, which its fine geometry passes through.
  const points: { x: number; y: number; key: string }[] = [];
  for (const e of trunk) for (let i = 0; i < e.route.length; i += 2) points.push({ x: e.route[i], y: e.route[i + 1], key: `${e.id}#${i / 2}` });
  for (const s of tv) points.push({ x: s.x, y: s.y, key: s.id });
  const hamlets = sites(HAMLET, 2 * MAX_LEN[ROAD_C]);
  const netDist = new Map<Site, number>();
  for (const h of hamlets) netDist.set(h, Math.min(...points.map((p) => dist(h, p)), Infinity));
  for (const h of hamlets) {
    if (!inCell(h)) continue;
    const own = netDist.get(h)!;
    let target: { x: number; y: number; key: string } | undefined;
    let td = Infinity;
    for (const p of points)
      if (dist(h, p) < td) {
        td = dist(h, p);
        target = p;
      }
    for (const o of hamlets) {
      if (o === h || netDist.get(o)! >= own) continue;
      const d = dist(h, o);
      if (d < td) {
        td = d;
        target = { x: o.x, y: o.y, key: o.id };
      }
    }
    if (!target || td > 2 * MAX_LEN[ROAD_C]) continue;
    const b: Site = { id: target.key, rank: HAMLET, x: target.x, y: target.y, z: 0, R: h.R };
    edges.push({ id: `${h.id}>${target.key}`, cls: ROAD_C, a: h, b, route: coarseRoute(h, b, field) });
  }

  const all = [...towns, ...tv, ...hamlets];
  const seen = new Set<string>();
  return { sites: all.filter((s) => inCell(s) && !seen.has(s.id) && seen.add(s.id)), edges };
}

// ---------------------------------------------------------------------------
// Coarse routing


/** Coarse moves: 8 neighbours plus knight moves (16 directions), so corridors bend less. */
const CMOVES: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1],
];
/** Gradient scale for coarse routing — the same for every class, so roads heading the
 * same way pick the same corridor (shortest paths to a shared node coincide). */
const COARSE_GRADE = 0.1;

/**
 * Coarse route between two sites. Waypoints are the sites and the coarse grid
 * nodes in between: roads that share a corridor share these exact waypoints, so
 * their fine geometry (a function of the two waypoints only) coincides too.
 */
function coarseRoute(a: Site, b: Site, field: CoarseField): number[] {
  const margin = 1536;
  const ox = Math.floor((Math.min(a.x, b.x) - margin) / COARSE);
  const oy = Math.floor((Math.min(a.y, b.y) - margin) / COARSE);
  const w = Math.ceil((Math.max(a.x, b.x) + margin) / COARSE) - ox + 1;
  const h = Math.ceil((Math.max(a.y, b.y) + margin) / COARSE) - oy + 1;
  const N = w * h;
  const z = new Float32Array(N);
  const river = new Uint8Array(N);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = (ox + i) * COARSE;
      const y = (oy + j) * COARSE;
      z[j * w + i] = field.z(x, y);
      river[j * w + i] = field.area(x, y) > 15 ? 1 : 0;
    }
  // Start from (and finish at) whichever of the 4 grid nodes around a site suits the
  // route: the nearest node can lie behind the site, making the road double back.
  const around = (x: number, y: number) => {
    const i = Math.floor(x / COARSE) - ox;
    const j = Math.floor(y / COARSE) - oy;
    return [j * w + i, j * w + i + 1, (j + 1) * w + i, (j + 1) * w + i + 1];
  };
  const pos = (k: number): [number, number] => [(ox + (k % w)) * COARSE, (oy + Math.floor(k / w)) * COARSE];
  const goals = new Set(around(b.x, b.y));
  const GOAL = N; // virtual node: "arrived at b"
  const cost = new Float64Array(N + 1).fill(Infinity);
  const from = new Int32Array(N + 1).fill(-1);
  const heap = new MinHeap(256);
  const h0 = (k: number) => {
    const [x, y] = pos(k);
    return Math.hypot(x - b.x, y - b.y);
  };
  for (const k of around(a.x, a.y)) {
    const [x, y] = pos(k);
    cost[k] = Math.hypot(x - a.x, y - a.y);
    from[k] = -2; // starts at a
    heap.push(k, cost[k] + h0(k));
  }
  while (heap.size) {
    const c = heap.pop();
    if (c === GOAL) break;
    if (goals.has(c)) {
      const nc = cost[c] + h0(c);
      if (nc < cost[GOAL]) {
        cost[GOAL] = nc;
        from[GOAL] = c;
        heap.push(GOAL, nc);
      }
    }
    const ci = c % w;
    const cj = (c - ci) / w;
    for (const [dx, dy] of CMOVES) {
      const i = ci + dx;
      const j = cj + dy;
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const q = j * w + i;
      const dist = Math.hypot(dx, dy) * COARSE;
      // Knight moves pass between nodes: check the middle too, or they'd hop ridges.
      const zm =
        Math.abs(dx) + Math.abs(dy) === 3 ? field.z((ox + ci + dx / 2) * COARSE, (oy + cj + dy / 2) * COARSE) : (z[c] + z[q]) / 2;
      const g = (Math.abs(zm - z[c]) + Math.abs(z[q] - zm)) / dist;
      let step = dist * (1 + 4 * (g / COARSE_GRADE) ** 2);
      if (g > 2 * COARSE_GRADE) step *= 8; // coarse slopes are smoothed: discourage, don't forbid
      if (river[q] && !river[c]) step += 300; // a bridge
      const nc = cost[c] + step;
      if (nc < cost[q]) {
        cost[q] = nc;
        from[q] = c;
        heap.push(q, nc + h0(q));
      }
    }
  }
  const nodes: number[] = [];
  for (let c = from[GOAL]; c >= 0; c = from[c]) nodes.push(c);
  nodes.reverse();
  const route = [a.x, a.y];
  const add = (x: number, y: number) => {
    if (x !== route[route.length - 2] || y !== route[route.length - 1]) route.push(x, y);
  };
  for (const c of nodes) add(...pos(c));
  add(b.x, b.y);
  return route;
}

/**
 * Greedy line-of-sight simplification: from each kept vertex, jump to the farthest
 * one reachable. A shortcut must pass `ok` and stay within `maxDev` metres of every
 * vertex it skips — enough to iron out the 8-direction staircase, but not to cut a
 * hairpin's U-turn into a V.
 */
export function stringPull(
  pts: number[],
  ok: (x0: number, y0: number, x1: number, y1: number) => boolean,
  maxDev = Infinity,
): number[] {
  const n = pts.length / 2;
  const out = [pts[0], pts[1]];
  const close = (i: number, j: number) => {
    const ax = pts[2 * i];
    const ay = pts[2 * i + 1];
    const dx = pts[2 * j] - ax;
    const dy = pts[2 * j + 1] - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let k = i + 1; k < j; k++) {
      const px = pts[2 * k] - ax;
      const py = pts[2 * k + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      if (Math.hypot(px - t * dx, py - t * dy) > maxDev) return false;
    }
    return true;
  };
  let i = 0;
  while (i < n - 1) {
    let j = n - 1;
    while (j > i + 1 && !(close(i, j) && ok(pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]))) j--;
    out.push(pts[2 * j], pts[2 * j + 1]);
    i = j;
  }
  return out;
}

/** Inserts points so that no piece of the polyline is longer than `step`. */
export function resample(pts: number[], step: number): number[] {
  const out = [pts[0], pts[1]];
  for (let i = 1; i < pts.length / 2; i++) {
    const x0 = pts[2 * i - 2];
    const y0 = pts[2 * i - 1];
    const x1 = pts[2 * i];
    const y1 = pts[2 * i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let s = 1; s <= n; s++) out.push(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fine routing

/** One fine segment between two consecutive waypoints, shared by every road using it. */
export interface SegmentTask {
  /** Canonical key of the waypoint pair (order-independent). */
  key: string;
  /** Highest class of any road using it. */
  cls: RoadClass;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface SegmentPath {
  key: string;
  cls: RoadClass;
  /** Chunk-independent world coordinates [x0, y0, …]. */
  xy: Float32Array;
}

/** Fine node data around a chunk (row-major w × h, origin at global node gx, gy). */
export interface RoadPatch {
  gx: number;
  gy: number;
  w: number;
  h: number;
  zE: Float32Array;
  A: Float32Array;
  lake: Float32Array;
}

/** Fine-patch margin around a chunk (nodes), enough for any owned segment's box. */
export const ROAD_PAD = 32;
const BOX = 14;
/** String pulling may move the road this far (m): staircase yes, hairpin no. */
const STAIR_DEV = 8;
const SNAP = 3;
const SNAP_WIDE = 12;
const FDIST = DX.map((dx, i) => Math.hypot(dx, DY[i]) * NODE);

/**
 * Segments of `edges` whose midpoint lies in chunk (cx, cy), deduplicated: roads
 * sharing a corridor share waypoints, and the stretch between two shared
 * waypoints is one road, drawn in the highest class that uses it.
 */
export function ownedSegments(edges: RoadEdge[], cx: number, cy: number): SegmentTask[] {
  const byKey = new Map<string, SegmentTask>();
  for (const e of edges) {
    const r = e.route;
    for (let k = 0; k < r.length / 2 - 1; k++) {
      const ax = r[2 * k];
      const ay = r[2 * k + 1];
      const bx = r[2 * k + 2];
      const by = r[2 * k + 3];
      if (Math.floor((ax + bx) / 2 / CHUNK) !== cx || Math.floor((ay + by) / 2 / CHUNK) !== cy) continue;
      const p = `${ax},${ay}`;
      const q = `${bx},${by}`;
      const key = p < q ? `${p}|${q}` : `${q}|${p}`;
      const t = byKey.get(key);
      if (!t) byKey.set(key, { key, cls: e.cls, ax, ay, bx, by });
      else if (e.cls < t.cls) t.cls = e.cls;
    }
  }
  // A fixed orientation (by key), so the geometry doesn't depend on which road came first.
  return [...byKey.values()].map((t) =>
    t.key.startsWith(`${t.ax},${t.ay}|`) ? t : { ...t, ax: t.bx, ay: t.by, bx: t.ax, by: t.ay },
  );
}

export function routeSegments(tasks: SegmentTask[], p: RoadPatch): SegmentPath[] {
  const { w, h } = p;
  const at = (x: number, y: number) => [Math.round(x / NODE) - p.gx, Math.round(y / NODE) - p.gy];
  const inside = (i: number, j: number) => i >= 1 && j >= 1 && i < w - 1 && j < h - 1;
  const slopeAt = (k: number) =>
    Math.hypot(p.zE[k + 1] - p.zE[k - 1], p.zE[k + w] - p.zE[k - w]) / (2 * NODE);
  const bad = (k: number) => !Number.isNaN(p.lake[k]);
  /** Bilinear elevation at world (x, y). */
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
  const lakeAt = (x: number, y: number) => {
    const [i, j] = at(x, y);
    return inside(i, j) && bad(j * w + i);
  };

  /** Deterministic local snap of a waypoint to a buildable node nearby. */
  const snap = (x: number, y: number): number => {
    const [ci, cj] = at(x, y);
    let best = -1;
    let bestScore = Infinity;
    // Usually a few nodes; a waypoint that fell in a lake looks further for dry land.
    for (const R of [SNAP, SNAP_WIDE]) {
      if (best >= 0) break;
      for (let dj = -R; dj <= R; dj++)
        for (let di = -R; di <= R; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (!inside(i, j)) continue;
        const k = j * w + i;
        if (bad(k)) continue;
          const score = 10 * slopeAt(k) + (p.A[k] > 0.3 ? 2 : 0) + 0.15 * Math.hypot(di, dj);
          if (score < bestScore) {
            bestScore = score;
            best = k;
          }
        }
    }
    return best >= 0 ? best : Math.max(0, Math.min(w * h - 1, cj * w + ci));
  };

  return tasks.map((t) => {
    const { ax, ay, bx, by } = t;
    const A0 = snap(ax, ay);
    const B0 = snap(bx, by);
    // Water is a last resort (a causeway); if the path still touches it, give the
    // router the whole patch to find a way round the shore.
    const wet = (path: number[]) => path.reduce((n, k) => n + (bad(k) ? 1 : 0), 0);
    let path = fineAStar(p, A0, B0, -1, -1, t.cls, BOX);
    if (wet(path) > 0) {
      const wide = fineAStar(p, A0, B0, -1, -1, t.cls, Math.max(w, h));
      if (wet(wide) < wet(path)) path = wide;
    }
    const pts: number[] = [];
    for (const k of path) pts.push((p.gx + (k % w)) * NODE, (p.gy + Math.floor(k / w)) * NODE);
    // Straighten the 8-direction staircase where a straight line keeps within the
    // class gradient and out of lakes; hairpins survive because they're needed.
    const gmax = MAX_GRADE[t.cls];
    const ok = (x0: number, y0: number, x1: number, y1: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.ceil(len / 8));
      let zp = zAt(x0, y0);
      for (let s = 1; s <= n; s++) {
        const x = x0 + ((x1 - x0) * s) / n;
        const y = y0 + ((y1 - y0) * s) / n;
        if (lakeAt(x, y)) return false;
        const zq = zAt(x, y);
        if (Math.abs(zq - zp) / (len / n) > gmax * 1.05) return false;
        zp = zq;
      }
      return true;
    };
    const xy = Float32Array.from(resample(stringPull(pts, ok, STAIR_DEV), NODE));
    return { key: t.key, cls: t.cls, xy };
  });
}

/** A* over (node, heading) with a hard gradient limit and limited turning. */
function fineAStar(p: RoadPatch, a: number, b: number, hA: number, hB: number, cls: RoadClass, box: number): number[] {
  const { w, h } = p;
  if (a === b) return [a];
  const ai = a % w;
  const aj = (a - ai) / w;
  const bi = b % w;
  const bj = (b - bi) / w;
  const i0 = Math.max(1, Math.min(ai, bi) - box);
  const j0 = Math.max(1, Math.min(aj, bj) - box);
  const i1 = Math.min(w - 2, Math.max(ai, bi) + box);
  const j1 = Math.min(h - 2, Math.max(aj, bj) + box);
  const bw = i1 - i0 + 1;
  const bh = j1 - j0 + 1;
  const S = bw * bh * 8;
  const local = (k: number) => ((Math.floor(k / w) - j0) * bw + (k % w) - i0) * 8;
  const gmax = MAX_GRADE[cls];
  // At most 45° per 16 m step: a hairpin sweeps round over ~4 steps instead of
  // spiking back and forth. Turning costs, so legs between bends stay long.
  const maxTurn = 1;
  const turnCost = cls === ROAD_N ? 45 : cls === ROAD_D ? 28 : 16;
  const cost = new Float64Array(S).fill(Infinity);
  const from = new Int32Array(S).fill(-1);
  const heap = new MinHeap(512);
  // Leaving the waypoint along its heading is preferred, not forced: a forced
  // heading makes the road loop round when the real way out lies elsewhere.
  for (let d = 0; d < 8; d++) {
    const s0 = local(a) + d;
    const dev = hA < 0 ? 0 : Math.min(Math.abs(d - hA), 8 - Math.abs(d - hA));
    cost[s0] = 15 * dev;
    heap.push(s0, cost[s0]);
  }
  let goal = -1;
  while (heap.size) {
    const s = heap.pop();
    const d0 = s & 7;
    const cell = s >> 3;
    const li = cell % bw;
    const lj = (cell - li) / bw;
    const k = (lj + j0) * w + li + i0;
    if (k === b) {
      goal = s;
      break;
    }
    for (let t = -maxTurn; t <= maxTurn; t++) {
      const d = (d0 + t + 8) & 7;
      const ni = li + DX[d];
      const nj = lj + DY[d];
      if (ni < 0 || nj < 0 || ni >= bw || nj >= bh) continue;
      const q = (nj + j0) * w + ni + i0;
      const dist = FDIST[d];
      const g = Math.abs(p.zE[q] - p.zE[k]) / dist;
      let step = dist * (1 + 3 * (g / gmax) ** 2) + turnCost * Math.abs(t);
      if (g > gmax) step += dist * 40 * (g / gmax - 1); // over the limit: only if there's no way round
      if (p.A[q] > 1 && p.A[k] <= 1) step += 40; // bridge
      if (!Number.isNaN(p.lake[q])) step += dist * 60; // across water: only if there's no way round
      // Arriving at the goal against the outgoing heading costs a kink.
      if (q === b && hB >= 0) step += 20 * Math.min(Math.abs(d - hB), 8 - Math.abs(d - hB));
      const ns = ((nj * bw + ni) << 3) | d;
      const nc = cost[s] + step;
      if (nc < cost[ns]) {
        cost[ns] = nc;
        from[ns] = s;
        heap.push(ns, nc + Math.hypot(ni + i0 - bi, nj + j0 - bj) * NODE);
      }
    }
  }
  if (goal < 0) return [a, b]; // no path at all (enclosed by water): draw it straight
  const out: number[] = [];
  for (let s = goal; s >= 0; s = from[s]) {
    const cell = s >> 3;
    const li = cell % bw;
    out.push(((cell - li) / bw + j0) * w + li + i0);
  }
  out.reverse();
  // Collapse repeats (heading-only steps don't exist, but be safe).
  return out.filter((k, n) => n === 0 || k !== out[n - 1]);
}

export const netCellOf = (x: number, y: number): [number, number] => [cellOf(x), cellOf(y)];
