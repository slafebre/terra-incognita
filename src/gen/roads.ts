import { CHUNK } from '../lib/constants';
import { hash3 } from '../lib/hash';
import { MinHeap } from '../lib/heap';
import { smoothstep } from '../lib/noise';
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
export const NET_REACH = 56000;
/** D roads with an endpoint this far around a cell are routed by it (m). */
const D_ZONE = 9300;
export const ROAD_N = 0;
export const ROAD_D = 1;
export const ROAD_C = 2;
/** Tracks (unpaved farm and forest ways) and footpaths. */
export const ROAD_T = 3;
export const ROAD_P = 4;
export type RoadClass = typeof ROAD_N | typeof ROAD_D | typeof ROAD_C | typeof ROAD_T | typeof ROAD_P;

/** Maximum sustained gradient per class. */
export const MAX_GRADE = [0.07, 0.1, 0.15, 0.22, 0.45];
/** Longest edge per class (m). */
export const MAX_LEN = [9000, 4500, 1600];

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
export function rngEdge(a: Site, b: Site, others: Site[]): boolean {
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

  // C: each hamlet gets one road towards the nearest of: a D-road waypoint, a village
  // or town, or a hamlet that is itself closer to that network. The road ends at its
  // first contact with the network — on it or one node beside it, joining across —
  // so it never runs alongside. Join targets must be computable identically by every
  // cell: D roads, and roads of hamlets that head straight for the network
  // ("depth 1"). Deeper chains also join the road of the hamlet they head for.
  const points: { x: number; y: number; key: string }[] = [];
  const trunkNodes: number[] = [];
  for (const e of trunk)
    for (let i = 0; i < e.route.length; i += 2) {
      points.push({ x: e.route[i], y: e.route[i + 1], key: `${e.id}#${i / 2}` });
      if (i > 0 && i < e.route.length - 2) trunkNodes.push(e.route[i], e.route[i + 1]);
    }
  const trunkJoins = joinMap(trunkNodes);
  for (const s of tv) points.push({ x: s.x, y: s.y, key: s.id });
  const hamlets = sites(HAMLET, SHORT_ROUTED + 2 * MAX_LEN[ROAD_C]);
  const netDist = new Map<Site, number>();
  for (const h of hamlets) netDist.set(h, Math.min(...points.map((p) => dist(h, p)), Infinity));
  const target = new Map<Site, { x: number; y: number; key: string; hamlet?: Site }>();
  for (const h of hamlets) {
    const own = netDist.get(h)!;
    let best: { x: number; y: number; key: string; hamlet?: Site } | undefined;
    let td = Infinity;
    for (const p of points)
      if (dist(h, p) < td) {
        td = dist(h, p);
        best = p;
      }
    for (const o of hamlets) {
      if (o === h || netDist.get(o)! >= own) continue;
      const d = dist(h, o);
      if (d < td) {
        td = d;
        best = { x: o.x, y: o.y, key: o.id, hamlet: o };
      }
    }
    if (best && td <= 2 * MAX_LEN[ROAD_C]) target.set(h, best);
  }
  const asSite = (t: { x: number; y: number; key: string }, R: number): Site => ({ id: t.key, rank: HAMLET, x: t.x, y: t.y, z: 0, R });
  // Depth-1 roads (every cell computes the same ones), on demand.
  const depth1 = new Map<Site, number[] | undefined>();
  const depth1Of = (h: Site) => {
    if (!depth1.has(h)) {
      const t = target.get(h);
      depth1.set(h, t && !t.hamlet ? coarseRoute(h, asSite(t, h.R), field, trunkJoins) : undefined);
    }
    return depth1.get(h);
  };
  // Every hamlet road near the cell: the shortcuts below need the network around.
  const hamletRoads = new Map<Site, number[]>();
  for (const h of hamlets) {
    const t = target.get(h);
    if (!t || !inBox(h, SHORT_ROUTED)) continue;
    let route = depth1Of(h);
    if (!route) {
      const r1 = t.hamlet ? depth1Of(t.hamlet) : undefined;
      route = coarseRoute(h, asSite(t, h.R), field, r1 ? joinMap([...trunkNodes, ...r1.slice(2)]) : trunkJoins);
    }
    hamletRoads.set(h, route);
    if (inCell(h)) edges.push({ id: `${h.id}>${t.key}`, cls: ROAD_C, a: h, b: asSite(t, h.R), route });
  }

  // Shortcuts: two points of the network (waypoints or sites) close to each other
  // that it joins only by a long way round get a direct minor road, if the ground
  // allows one that is neither steep, nor a detour, nor running beside an existing
  // road. Candidates are taken best first (biggest way round saved); one that
  // duplicates or crosses an accepted shortcut is dropped. Decided on the network
  // above only, so neighbouring cells see (nearly) the same candidates.
  const graph = new RoadGraph();
  const netNodes: number[] = [];
  for (const r of [...trunk.map((e) => e.route), ...hamletRoads.values()]) {
    graph.addRoute(r);
    netNodes.push(...r);
  }
  const beside = joinMap(netNodes);
  const siteAt = new Map<string, Site>();
  for (const s of [...towns, ...tv, ...hamlets]) siteAt.set(`${s.x},${s.y}`, s);
  const asPoint = (x: number, y: number, R: number): Site => siteAt.get(`${x},${y}`) ?? { id: `n:${x},${y}`, rank: HAMLET, x, y, z: 0, R };
  const reach = SHORT_MAX + SHORT_CONFLICT;
  const pts = graph.points().filter((p) => inBox(p, reach));
  const G = 1024;
  const bucket = new Map<string, typeof pts>();
  for (const p of pts) {
    const k = `${Math.floor(p.x / G)},${Math.floor(p.y / G)}`;
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k)!.push(p);
  }
  const nearPts = (x: number, y: number, r: number) => {
    const out: typeof pts = [];
    for (let j = Math.floor((y - r) / G); j <= Math.floor((y + r) / G); j++)
      for (let i = Math.floor((x - r) / G); i <= Math.floor((x + r) / G); i++)
        for (const q of bucket.get(`${i},${j}`) ?? []) if (Math.hypot(q.x - x, q.y - y) <= r) out.push(q);
    return out;
  };
  const cands: { p: (typeof pts)[0]; q: (typeof pts)[0]; d: number; gain: number }[] = [];
  for (const p of pts)
    for (const q of nearPts(p.x, p.y, SHORT_MAX)) {
      if (q.key <= p.key) continue;
      const d = dist(p, q);
      if (d < SHORT_MIN) continue;
      if (Math.abs(field.z(p.x, p.y) - field.z(q.x, q.y)) > SHORT_GRADE * d) continue;
      // It may not cross the network (that would be a crossing without a junction).
      if (graph.crosses(p, q)) continue;
      // The way round must be long, and the loop the shortcut closes big: small
      // triangles at junctions read as knots, not as a road network.
      const need = Math.max(SHORT_RATIO * d, SHORT_LOOP - d);
      const nd = graph.distance(p, q, need);
      if (nd <= need) continue;
      cands.push({ p, q, d, gain: Math.min(nd, 3 * SHORT_MAX) - d });
    }
  cands.sort((a, b) => b.gain - a.gain || (a.p.key + a.q.key < b.p.key + b.q.key ? -1 : 1));
  const accepted: (typeof cands)[0][] = [];
  const crossIndex = new RoadGraph();
  const conflicts = (a: (typeof cands)[0], b: (typeof cands)[0]) =>
    (dist(a.p, b.p) < SHORT_CONFLICT && dist(a.q, b.q) < SHORT_CONFLICT) ||
    (dist(a.p, b.q) < SHORT_CONFLICT && dist(a.q, b.p) < SHORT_CONFLICT) ||
    segmentsCross(a.p, a.q, b.p, b.q);
  for (const c of cands) {
    if (accepted.some((o) => conflicts(c, o))) continue;
    const a = asPoint(c.p.x, c.p.y, 0.5);
    const b = asPoint(c.q.x, c.q.y, 0.5);
    const route = coarseRoute(a, b, field);
    if (routeLength(route) > SHORT_DETOUR * c.d) continue;
    // Not a road shadowing another one: away from its ends, most of its way must be new ground.
    let shared = 0;
    let inner = 0;
    for (let i = 2; i < route.length - 2; i += 2) {
      const m = { x: route[i], y: route[i + 1] };
      if (dist(m, a) < SHORT_END || dist(m, b) < SHORT_END) continue;
      inner++;
      if (beside.has(`${m.x},${m.y}`)) shared++;
    }
    if (shared > SHORT_SHARED * inner) continue;
    // The road as routed may not cross the network or another shortcut either.
    if (graph.routeCrosses(route) || crossIndex.routeCrosses(route)) continue;
    crossIndex.addRoute(route);
    accepted.push(c);
    if (inBox(c.p, 0)) edges.push({ id: `${c.p.key}~${c.q.key}`, cls: ROAD_C, a, b, route });
  }

  const all = [...towns, ...tv, ...hamlets];
  const seen = new Set<string>();
  return { sites: all.filter((s) => inCell(s) && !seen.has(s.id) && seen.add(s.id)), edges };
}

/** Shortcut length range (m), between points of the network. */
const SHORT_MIN = 500;
const SHORT_MAX = 2000;
/** A pair gets a shortcut when the network's way round is longer than this × the distance. */
const SHORT_RATIO = 2;
/** …and the shortcut itself is no longer than this × the distance. */
const SHORT_DETOUR = 1.5;
/** Smallest loop a shortcut may close (m, its length plus the way round). */
const SHORT_LOOP = 1800;
/** Shortcuts this close at both ends duplicate each other (m). */
const SHORT_CONFLICT = 500;
/** Shortcuts don't climb more than this mean gradient. */
const SHORT_GRADE = 0.08;
/** At most this share of a shortcut's waypoints (SHORT_END m clear of its ends) may lie on or beside the network. */
const SHORT_SHARED = 0.5;
const SHORT_END = 300;
/** Hamlet roads within this of a cell are part of the network its shortcuts see (m). */
const SHORT_ROUTED = SHORT_MAX + SHORT_CONFLICT + SHORT_RATIO * SHORT_MAX / 2 + MAX_LEN[ROAD_C];

/** Do segments ab and cd cross (properly, not at a shared end)? */
export function segmentsCross(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): boolean {
  const o = (p: typeof a, q: typeof a, r: typeof a) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

export function routeLength(r: number[]): number {
  let L = 0;
  for (let i = 2; i < r.length; i += 2) L += Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1]);
  return L;
}

/** Coarse road network as a graph of waypoints, for distances along it. */
export class RoadGraph {
  private readonly id = new Map<string, number>();
  private readonly adj: [number, number][][] = [];
  private static readonly G = 512;
  private readonly edges = new Map<string, [{ x: number; y: number }, { x: number; y: number }][]>();

  private node(x: number, y: number): number {
    const k = `${x},${y}`;
    let i = this.id.get(k);
    if (i === undefined) {
      i = this.adj.length;
      this.id.set(k, i);
      this.adj.push([]);
    }
    return i;
  }

  addRoute(r: number[]): void {
    for (let i = 2; i < r.length; i += 2) {
      const a = this.node(r[i - 2], r[i - 1]);
      const b = this.node(r[i], r[i + 1]);
      // Edges indexed by midpoint (they are at most ~600 m long).
      const k = `${Math.floor((r[i] + r[i - 2]) / 2 / RoadGraph.G)},${Math.floor((r[i + 1] + r[i - 1]) / 2 / RoadGraph.G)}`;
      if (!this.edges.has(k)) this.edges.set(k, []);
      this.edges.get(k)!.push([{ x: r[i - 2], y: r[i - 1] }, { x: r[i], y: r[i + 1] }]);
      const w = Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1]);
      this.adj[a].push([b, w]);
      this.adj[b].push([a, w]);
    }
  }

  /** Does the straight line a–b cross any road of the network (other than at a or b)? */
  crosses(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    const G = RoadGraph.G;
    const x0 = Math.floor((Math.min(a.x, b.x) - 300) / G);
    const x1 = Math.floor((Math.max(a.x, b.x) + 300) / G);
    const y0 = Math.floor((Math.min(a.y, b.y) - 300) / G);
    const y1 = Math.floor((Math.max(a.y, b.y) + 300) / G);
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++)
        for (const [p, q] of this.edges.get(`${i},${j}`) ?? []) if (segmentsCross(a, b, p, q)) return true;
    return false;
  }

  /** Does any piece of route r cross a road of the network (not at a shared node)? */
  routeCrosses(r: number[]): boolean {
    for (let i = 2; i < r.length; i += 2)
      if (this.crosses({ x: r[i - 2], y: r[i - 1] }, { x: r[i], y: r[i + 1] })) return true;
    return false;
  }

  /** Every node: position and key. */
  points(): { x: number; y: number; key: string }[] {
    return [...this.id.keys()].map((key) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y, key };
    });
  }

  /** Network distance between two nodes, or Infinity if more than `limit`. */
  distance(a: { x: number; y: number }, b: { x: number; y: number }, limit: number): number {
    const s = this.id.get(`${a.x},${a.y}`);
    const t = this.id.get(`${b.x},${b.y}`);
    if (s === undefined || t === undefined) return Infinity;
    const dist = new Map<number, number>([[s, 0]]);
    const heap = new MinHeap(64);
    heap.push(s, 0);
    while (heap.size) {
      const u = heap.pop();
      const du = dist.get(u)!;
      if (u === t) return du;
      for (const [v, w] of this.adj[u]) {
        const dv = du + w;
        if (dv > limit || dv >= (dist.get(v) ?? Infinity)) continue;
        dist.set(v, dv);
        heap.push(v, dv);
      }
    }
    return Infinity;
  }
}

// ---------------------------------------------------------------------------
// Coarse routing

/**
 * Where a road may join the network: every grid node on it, and every node next to
 * one (joining across). Grid-aligned nodes only (sites are not join points). Keys are
 * "x,y"; values are the network node to finish on. Depends only on the node set, not
 * on its order, so every cell builds the same map.
 */
export function joinMap(nodes: number[]): Map<string, [number, number]> {
  const on = new Set<string>();
  for (let i = 0; i < nodes.length; i += 2)
    if (nodes[i] % COARSE === 0 && nodes[i + 1] % COARSE === 0) on.add(`${nodes[i]},${nodes[i + 1]}`);
  const out = new Map<string, [number, number]>();
  const best = new Map<string, number>();
  for (const k of on) {
    const [x, y] = k.split(',').map(Number);
    out.set(k, [x, y]);
    best.set(k, -1);
  }
  for (const k of on) {
    const [x, y] = k.split(',').map(Number);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const n = `${x + dx * COARSE},${y + dy * COARSE}`;
        if (on.has(n)) continue;
        // Nearest network node; ties broken by the node itself, never by visiting order.
        const d = Math.abs(dx) + Math.abs(dy) + edgeJitter(x, y, x + dx * COARSE, y + dy * COARSE) * 1e-3;
        if (d < (best.get(n) ?? Infinity)) {
          best.set(n, d);
          out.set(n, [x, y]);
        }
      }
  }
  return out;
}


/** Coarse moves: 8 neighbours plus knight moves (16 directions), so corridors bend less. */
const CMOVES: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1],
];
/** Gradient scale for coarse routing — the same for every class, so roads heading the
 * same way pick the same corridor (shortest paths to a shared node coincide). */
const COARSE_GRADE = 0.1;
/** Valley floors (drainage area ramp, km², around a node) cost up to this much less. */
const VALLEY_AREA = [0.3, 4];
const VALLEY_BONUS = 0.35;
/** Following a road already there costs this share: later roads join it rather than run beside it. */
const REUSE = 0.5;

/** Key of the coarse edge between grid nodes (i0, j0) and (i1, j1), either way round. */
export function edgeKey(i0: number, j0: number, i1: number, j1: number): string {
  return j0 < j1 || (j0 === j1 && i0 < i1) ? `${i0},${j0},${i1},${j1}` : `${i1},${j1},${i0},${j0}`;
}

/** Adds the grid edges of route r (world metres) to a reuse set. */
export function markReuse(set: Set<string>, r: number[]): void {
  for (let i = 2; i < r.length; i += 2) {
    const [x0, y0, x1, y1] = [r[i - 2], r[i - 1], r[i], r[i + 1]];
    if (x0 % COARSE || y0 % COARSE || x1 % COARSE || y1 % COARSE) continue;
    set.add(edgeKey(x0 / COARSE, y0 / COARSE, x1 / COARSE, y1 / COARSE));
  }
}

/**
 * Coarse elevation and drainage area at a (half-)grid point, cached per field:
 * routes in a cell overlap heavily, and the blended lookup is not cheap.
 */
const nodeCache = new WeakMap<CoarseField, Map<number, [number, number]>>();
function nodeData(field: CoarseField, x: number, y: number): [number, number] {
  let m = nodeCache.get(field);
  if (!m) nodeCache.set(field, (m = new Map()));
  // Half-grid index pair packed into one number (|i|, |j| < 2^25).
  const k = Math.round((2 * x) / COARSE) * 67108864 + Math.round((2 * y) / COARSE);
  let v = m.get(k);
  if (!v) m.set(k, (v = [field.z(x, y), field.area(x, y)]));
  return v;
}

/**
 * Fixed tie-break per coarse edge, 0..1, symmetric in its ends. On flat ground many
 * paths cost exactly the same, and which one A* returns depends on where it is
 * heading; then two roads through the same nodes split into parallel tracks between
 * them. With every edge cost distinct (and symmetric), the best path between any two
 * nodes is unique, so roads that meet stay together.
 */
function edgeJitter(i0: number, j0: number, i1: number, j1: number): number {
  const first = j0 < j1 || (j0 === j1 && i0 < i1);
  const h = first ? hash3(hash3(0x51ed27, i0, j0), i1, j1) : hash3(hash3(0x51ed27, i1, j1), i0, j0);
  return h / 4294967296;
}

/**
 * Coarse route between two sites. Waypoints are the sites and the coarse grid
 * nodes in between: roads that share a corridor share these exact waypoints, so
 * their fine geometry (a function of the two waypoints only) coincides too.
 * With `joins` ("x,y" of grid nodes on existing roads), the route ends at the
 * first such node it can reach most cheaply instead of running on beside it.
 */
export function coarseRoute(
  a: Site,
  b: Site,
  field: CoarseField,
  joins?: Map<string, [number, number]>,
  margin = 1536,
  out?: { cost: number },
  reuse?: Set<string>,
  /** Moves (grid indices) that would cross an existing road between nodes: forbidden. */
  blocked?: (i0: number, j0: number, i1: number, j1: number) => boolean,
): number[] {
  const ox = Math.floor((Math.min(a.x, b.x) - margin) / COARSE);
  const oy = Math.floor((Math.min(a.y, b.y) - margin) / COARSE);
  const w = Math.ceil((Math.max(a.x, b.x) + margin) / COARSE) - ox + 1;
  const h = Math.ceil((Math.max(a.y, b.y) + margin) / COARSE) - oy + 1;
  const N = w * h;
  const z = new Float32Array(N);
  const river = new Uint8Array(N);
  const area = new Float32Array(N);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = (ox + i) * COARSE;
      const y = (oy + j) * COARSE;
      const [zz, aa] = nodeData(field, x, y);
      z[j * w + i] = zz;
      area[j * w + i] = aa;
      river[j * w + i] = area[j * w + i] > 15 ? 1 : 0;
    }
  // Valley floors: on or beside a stream. Roads run along them (gentle, and where
  // people live) rather than over the spurs between.
  const valley = new Float32Array(N);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let A = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const u = i + di;
          const v = j + dj;
          if (u >= 0 && v >= 0 && u < w && v < h) A = Math.max(A, area[v * w + u]);
        }
      valley[j * w + i] = smoothstep(VALLEY_AREA[0], VALLEY_AREA[1], A);
    }
  // Start from (and finish at) whichever of the 4 grid nodes around a site suits the
  // route: the nearest node can lie behind the site, making the road double back.
  // A point on a grid node (a waypoint) is that node: no stepping off and back.
  const around = (x: number, y: number) => {
    const i = Math.floor(x / COARSE) - ox;
    const j = Math.floor(y / COARSE) - oy;
    if (x % COARSE === 0 && y % COARSE === 0) return [j * w + i];
    return [j * w + i, j * w + i + 1, (j + 1) * w + i, (j + 1) * w + i + 1];
  };
  const pos = (k: number): [number, number] => [(ox + (k % w)) * COARSE, (oy + Math.floor(k / w)) * COARSE];
  // Only corners on the side facing the other end: a corner behind the site makes
  // the road leave backwards and curl round it.
  const facing = (s: Site, o: Site) =>
    around(s.x, s.y).filter((k, _n, all) => {
      if (all.length === 1) return true;
      const [x, y] = pos(k);
      return (x - s.x) * (o.x - s.x) + (y - s.y) * (o.y - s.y) >= 0;
    });
  const goals = new Set(facing(b, a));
  const GOAL = N; // virtual node: "arrived at b"
  let join: [number, number] | undefined;
  const cost = new Float64Array(N + 1).fill(Infinity);
  const from = new Int32Array(N + 1).fill(-1);
  const heap = new MinHeap(256);
  const h0 = (k: number) => {
    const [x, y] = pos(k);
    return Math.hypot(x - b.x, y - b.y);
  };
  // Heuristic: a step can cost as little as (1 - VALLEY_BONUS) × its length.
  // (Not scaled for reuse: an optimistic estimate there would search nearly the whole
  // window; slightly suboptimal joins are fine.)
  const hA = (k: number) => (1 - VALLEY_BONUS) * h0(k);
  for (const k of facing(a, b)) {
    const [x, y] = pos(k);
    cost[k] = Math.hypot(x - a.x, y - a.y);
    from[k] = -2; // starts at a
    heap.push(k, cost[k] + hA(k));
  }
  while (heap.size) {
    const c = heap.pop();
    if (c === GOAL) break;
    const joinHere = joins?.get(pos(c).join(','));
    if (goals.has(c) || joinHere) {
      const nc = cost[c] + (joinHere ? 0 : h0(c));
      if (nc < cost[GOAL]) {
        cost[GOAL] = nc;
        from[GOAL] = c;
        join = joinHere;
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
      if (blocked?.(ox + ci, oy + cj, ox + i, oy + j)) continue;
      const dist = Math.hypot(dx, dy) * COARSE;
      // Knight moves pass between nodes: check the middle too, or they'd hop ridges.
      const zm =
        Math.abs(dx) + Math.abs(dy) === 3 ? nodeData(field, (ox + ci + dx / 2) * COARSE, (oy + cj + dy / 2) * COARSE)[0] : (z[c] + z[q]) / 2;
      const g = (Math.abs(zm - z[c]) + Math.abs(z[q] - zm)) / dist;
      let step = dist * (1 + 4 * (g / COARSE_GRADE) ** 2);
      if (g > 2 * COARSE_GRADE) step *= 8; // coarse slopes are smoothed: discourage, don't forbid
      if (river[q] !== river[c]) step += 150; // a bridge (half on each bank: costs are symmetric)
      step *= 1 - (VALLEY_BONUS * (valley[c] + valley[q])) / 2;
      if (reuse?.has(edgeKey(ox + ci, oy + cj, ox + i, oy + j))) step *= REUSE; // along an existing road
      step *= 1 + 0.01 * edgeJitter(ox + ci, oy + cj, ox + i, oy + j);
      const nc = cost[c] + step;
      if (nc < cost[q]) {
        cost[q] = nc;
        from[q] = c;
        heap.push(q, nc + hA(q));
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
  if (join) add(...join);
  else add(b.x, b.y);
  if (out) out.cost = cost[GOAL];
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
  /** Lattice edges: drawn as a curve, continuing smoothly into these neighbours (if any). */
  curve?: boolean;
  pa?: [number, number];
  pb?: [number, number];
}

export interface SegmentPath {
  key: string;
  cls: RoadClass;
  /** Chunk-independent world coordinates [x0, y0, …]. */
  xy: Float32Array;
  /** Already joins its neighbours smoothly (lattice curves): no junction merging. */
  curve?: boolean;
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
    let path = fineAStar(p, A0, B0, t.cls, BOX);
    if (wet(path) > 0) {
      const wide = fineAStar(p, A0, B0, t.cls, Math.max(w, h));
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

/**
 * Approach trees: near a waypoint, every segment ending there follows the same
 * cheapest-path tree grown from it (radius TREE_R nodes, or less on short segments).
 * Roads leaving a waypoint the same way then share one track until they part, the
 * way real roads fork, instead of running side by side into the waypoint. The tree
 * depends only on the waypoint, the class and the (shared) node data.
 */
const TREE_R = 8;
/** At most 45° per 16 m step: a hairpin sweeps round over ~4 steps instead of spiking. */
const MAX_TURN = 1;
const TURN_COST = [45, 28, 16];

/** Cost of the step k → q in direction d; symmetric, so a path costs the same both ways. */
function stepCost(p: RoadPatch, k: number, q: number, d: number, cls: RoadClass): number {
  const dist = FDIST[d];
  const gmax = MAX_GRADE[cls];
  const g = Math.abs(p.zE[q] - p.zE[k]) / dist;
  let step = dist * (1 + 3 * (g / gmax) ** 2);
  if (g > gmax) step += dist * 40 * (g / gmax - 1); // over the limit: only if there's no way round
  if (p.A[q] > 1 !== p.A[k] > 1) step += 20; // a bridge: half on each bank
  // Across water: only if there's no way round.
  step += dist * 30 * ((Number.isNaN(p.lake[q]) ? 0 : 1) + (Number.isNaN(p.lake[k]) ? 0 : 1));
  return step;
}

const turnOf = (d0: number, d1: number) => Math.min((d1 - d0 + 8) & 7, (d0 - d1 + 8) & 7);

interface Tree {
  /** Centre node (patch index), radius (nodes), local box side. */
  c: number;
  r: number;
  side: number;
  /** Per local (node, heading) state: cost from the centre, and predecessor state. */
  cost: Float64Array;
  from: Int32Array;
  /**
   * Per local node: its cheapest state (or -1). Only these are used — the others
   * reach the node with an awkward heading, by curling round.
   */
  best: Int32Array;
}

/** Cheapest-path tree from node c over (node, heading) states within radius r. */
function approachTree(p: RoadPatch, c: number, r: number, cls: RoadClass): Tree {
  const { w } = p;
  const ci = c % w;
  const cj = (c - ci) / w;
  const side = 2 * r + 1;
  const cost = new Float64Array(side * side * 8).fill(Infinity);
  const from = new Int32Array(side * side * 8).fill(-1);
  const heap = new MinHeap(256);
  const centre = (r * side + r) * 8;
  for (let d = 0; d < 8; d++) {
    cost[centre + d] = 0;
    heap.push(centre + d, 0);
  }
  while (heap.size) {
    const s = heap.pop();
    const d0 = s & 7;
    const cell = s >> 3;
    const li = cell % side;
    const lj = (cell - li) / side;
    const k = (cj + lj - r) * w + ci + li - r;
    for (let t = -MAX_TURN; t <= MAX_TURN; t++) {
      const d = (d0 + t + 8) & 7;
      const ni = li + DX[d];
      const nj = lj + DY[d];
      if ((ni - r) ** 2 + (nj - r) ** 2 > r * r) continue;
      const gi = ci + ni - r;
      const gj = cj + nj - r;
      if (gi < 1 || gj < 1 || gi >= w - 1 || gj >= p.h - 1) continue;
      const ns = ((nj * side + ni) << 3) | d;
      const nc = cost[s] + stepCost(p, k, gj * w + gi, d, cls) + TURN_COST[cls] * Math.abs(t);
      if (nc < cost[ns]) {
        cost[ns] = nc;
        from[ns] = s;
        heap.push(ns, nc);
      }
    }
  }
  const best = new Int32Array(side * side).fill(-1);
  for (let cell = 0; cell < side * side; cell++)
    for (let d = 0; d < 8; d++) {
      const st = cell * 8 + d;
      if (cost[st] < Infinity && (best[cell] < 0 || cost[st] < cost[best[cell]])) best[cell] = st;
    }
  return { c, r, side, cost, from, best };
}

/** Local tree cell of patch node k, or -1 outside the tree's disc. */
function treeCell(t: Tree, k: number, w: number): number {
  const ci = t.c % w;
  const cj = (t.c - ci) / w;
  const ki = k % w;
  const kj = (k - ki) / w;
  const li = ki - ci + t.r;
  const lj = kj - cj + t.r;
  if ((li - t.r) ** 2 + (lj - t.r) ** 2 > t.r * t.r) return -1;
  return lj * t.side + li;
}

/** Patch nodes of the tree path from the centre to state s (centre first). */
function treePath(t: Tree, s: number, w: number): number[] {
  const ci = t.c % w;
  const cj = (t.c - ci) / w;
  const out: number[] = [];
  for (let q = s; q >= 0; q = t.from[q]) {
    const cell = q >> 3;
    const li = cell % t.side;
    out.push((cj + (cell - li) / t.side - t.r) * w + ci + li - t.r);
  }
  out.reverse();
  return out.filter((k, n) => n === 0 || k !== out[n - 1]);
}

/**
 * A* over (node, heading) with a hard gradient limit and limited turning, from a to
 * b. Within the approach trees of a and b the path is the tree's: the search starts
 * from every state of a's tree and finishes as soon as it steps into b's.
 */
function fineAStar(p: RoadPatch, a: number, b: number, cls: RoadClass, box: number): number[] {
  const { w, h } = p;
  if (a === b) return [a];
  const ai = a % w;
  const aj = (a - ai) / w;
  const bi = b % w;
  const bj = (b - bi) / w;
  // Trees may not overlap: short segments get smaller ones.
  const r = Math.min(TREE_R, Math.floor((Math.max(Math.abs(ai - bi), Math.abs(aj - bj)) - 1) / 2));
  const ta = r >= 1 ? approachTree(p, a, r, cls) : undefined;
  const tb = r >= 1 ? approachTree(p, b, r, cls) : undefined;
  const i0 = Math.max(1, Math.min(ai, bi) - box);
  const j0 = Math.max(1, Math.min(aj, bj) - box);
  const i1 = Math.min(w - 2, Math.max(ai, bi) + box);
  const j1 = Math.min(h - 2, Math.max(aj, bj) + box);
  const bw = i1 - i0 + 1;
  const bh = j1 - j0 + 1;
  const S = bw * bh * 8;
  const local = (k: number) => ((Math.floor(k / w) - j0) * bw + (k % w) - i0) * 8;
  const turnCost = TURN_COST[cls];
  const cost = new Float64Array(S).fill(Infinity);
  const from = new Int32Array(S).fill(-1);
  /** For states seeded from a's tree: the tree state they stand for. */
  const seedOf = new Map<number, number>();
  const heap = new MinHeap(512);
  const hEst = (k: number) => Math.hypot((k % w) - bi, Math.floor(k / w) - bj) * NODE;
  const GOAL = S;
  let goalCost = Infinity;
  let goalFrom = -1;
  let goalTree = -1;
  if (ta) {
    for (let cell = 0; cell < ta.side * ta.side; cell++) {
      const st = ta.best[cell];
      if (st < 0) continue;
      const li = cell % ta.side;
      const k = (aj + (cell - li) / ta.side - ta.r) * w + ai + li - ta.r;
      const s0 = local(k) + (st & 7);
      cost[s0] = ta.cost[st];
      seedOf.set(s0, st);
      heap.push(s0, ta.cost[st] + hEst(k));
    }
  } else
    for (let d = 0; d < 8; d++) {
      cost[local(a) + d] = 0;
      heap.push(local(a) + d, hEst(a));
    }
  while (heap.size) {
    const s = heap.pop();
    if (s === GOAL) break;
    const d0 = s & 7;
    const cell = s >> 3;
    const li = cell % bw;
    const lj = (cell - li) / bw;
    const k = (lj + j0) * w + li + i0;
    if (!tb && k === b) {
      goalCost = cost[s];
      goalFrom = s;
      break;
    }
    for (let t = -MAX_TURN; t <= MAX_TURN; t++) {
      const d = (d0 + t + 8) & 7;
      const ni = li + DX[d];
      const nj = lj + DY[d];
      if (ni < 0 || nj < 0 || ni >= bw || nj >= bh) continue;
      const q = (nj + j0) * w + ni + i0;
      // a's tree is fixed: no way back into it.
      if (ta && treeCell(ta, q, w) >= 0) continue;
      const nc = cost[s] + stepCost(p, k, q, d, cls) + turnCost * Math.abs(t);
      const bc = tb ? treeCell(tb, q, w) : -1;
      if (bc >= 0) {
        // Into b's tree: finish along its path, reversed (leaving q against the
        // heading the tree arrived with). A join at up to 90° is a junction-like bend.
        const st = tb!.best[bc];
        if (st < 0) continue;
        const atB = q === b; // b itself has no arriving heading: any will do
        const turn = atB ? 0 : turnOf(d, ((st & 7) + 4) & 7);
        if (turn > 2) continue;
        const total = nc + tb!.cost[st] + turnCost * turn;
        if (total < goalCost) {
          goalCost = total;
          goalFrom = s;
          goalTree = st;
          heap.push(GOAL, total);
        }
        continue;
      }
      const ns = ((nj * bw + ni) << 3) | d;
      if (nc < cost[ns]) {
        cost[ns] = nc;
        from[ns] = s;
        heap.push(ns, nc + hEst(q));
      }
    }
  }
  if (goalFrom < 0) return [a, b]; // no path at all (enclosed by water): draw it straight
  const out: number[] = [];
  let s = goalFrom;
  for (; s >= 0 && !seedOf.has(s); s = from[s]) {
    const cell = s >> 3;
    const li = cell % bw;
    out.push(((cell - li) / bw + j0) * w + li + i0);
  }
  out.reverse();
  const head = ta ? treePath(ta, seedOf.get(s)!, w) : [];
  const tail = tb && goalTree >= 0 ? treePath(tb, goalTree, w).reverse() : [];
  const all = [...head, ...out, ...tail];
  // Collapse repeats (heading-only steps don't exist, but be safe).
  return all.filter((k, n) => n === 0 || k !== all[n - 1]);
}

// ---------------------------------------------------------------------------
// Junction merging

/** Roads closer than this (m) near a shared waypoint are drawn as one. */
const MERGE_DIST = 24;
/** Longest shared stretch (m), and at most this share of a segment's length. */
const MERGE_MAX = 240;
const MERGE_SHARE = 0.4;

/**
 * Where roads leave a waypoint the same way, draw them on one line until they
 * really part: the later road (by class, then key) takes the earlier one's geometry
 * up to the point where it moves more than MERGE_DIST away, so the junction sits
 * where the roads fork rather than at the waypoint. Depends only on the segments
 * at each waypoint, so every chunk drawing a junction draws it the same.
 */
export function mergeApproaches(segs: SegmentPath[]): SegmentPath[] {
  const orient = (xy: number[], rev: boolean) => {
    if (!rev) return xy.slice();
    const r: number[] = [];
    for (let i = xy.length - 2; i >= 0; i -= 2) r.push(xy[i], xy[i + 1]);
    return r;
  };
  const original = segs.map((s) => Array.from(s.xy));
  const edited = original.map((xy) => xy);
  const ends = new Map<string, { i: number; rev: boolean }[]>();
  original.forEach((xy, i) => {
    const n = xy.length;
    const a = `${xy[0]},${xy[1]}`;
    const b = `${xy[n - 2]},${xy[n - 1]}`;
    if (n < 4 || a === b) return;
    for (const [k, rev] of [[a, false], [b, true]] as const) {
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k)!.push({ i, rev });
    }
  });
  // Edits at the two ends of a segment never overlap (MERGE_SHARE < 0.5), so the
  // order of waypoints doesn't matter.
  for (const inc of ends.values()) {
    if (inc.length < 2) continue;
    inc.sort((a, b) => segs[a.i].cls - segs[b.i].cls || (segs[a.i].key < segs[b.i].key ? -1 : 1));
    // Leading stretches (from the waypoint) of the roads drawn so far.
    const placed: number[][] = [];
    for (const { i, rev } of inc) {
      const t = orient(original[i], rev);
      const limit = Math.min(MERGE_MAX, MERGE_SHARE * lengthTo(t, t.length - 2));
      let best: { m: number[]; ti: number; mj: number; px: number; py: number } | undefined;
      let bestLen = 24;
      for (const m of placed) {
        // Walk t from the waypoint while it stays close to m (to m's middle at most:
        // its far end may be edited by another junction).
        const reach = Math.min(MERGE_MAX + 64, 0.5 * lengthTo(m, m.length - 2));
        let s = 0;
        for (let ti = 2; ti < t.length; ti += 2) {
          s += Math.hypot(t[ti] - t[ti - 2], t[ti + 1] - t[ti - 1]);
          if (s > limit) break;
          const pr = nearestOn(m, t[ti], t[ti + 1], reach);
          if (pr.d > MERGE_DIST) break;
          if (s > bestLen) {
            bestLen = s;
            best = { m, ti, mj: pr.j, px: pr.x, py: pr.y };
          }
        }
      }
      if (!best) {
        placed.push(t);
        continue;
      }
      // Shared stretch: m up to the fork point, then t's own way on.
      const prefix = best.m.slice(0, best.mj + 2);
      prefix.push(best.px, best.py);
      placed.push([...prefix, ...t.slice(best.ti + 2)]);
      // The rest comes from the current geometry: its far end may be edited already.
      const cur = orient(edited[i], rev);
      edited[i] = orient([...prefix, ...cur.slice(best.ti + 2)], rev);
    }
  }
  return segs.map((s, i) => (edited[i] === original[i] ? s : { ...s, xy: Float32Array.from(edited[i]) }));
}

function lengthTo(xy: number[], upto: number): number {
  let L = 0;
  for (let i = 2; i <= upto; i += 2) L += Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]);
  return L;
}

/** Nearest point on polyline m (first `reach` metres) to (x, y): distance, piece start index, point. */
function nearestOn(m: number[], x: number, y: number, reach: number): { d: number; j: number; x: number; y: number } {
  let best = { d: Infinity, j: 0, x: m[0], y: m[1] };
  let s = 0;
  for (let j = 0; j + 3 < m.length && s <= reach; j += 2) {
    const ax = m[j];
    const ay = m[j + 1];
    const dx = m[j + 2] - ax;
    const dy = m[j + 3] - ay;
    const L2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const px = ax + u * dx;
    const py = ay + u * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { d, j, x: px, y: py };
    s += Math.sqrt(L2);
  }
  return best;
}

export const netCellOf = (x: number, y: number): [number, number] => [cellOf(x), cellOf(y)];
