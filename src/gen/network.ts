import { MinHeap } from '../lib/heap';
import { COARSE, type CoarseField } from './hydro';
import {
  coarseRoute,
  joinMap,
  markReuse,
  MAX_LEN,
  NET_CELL,
  type NetCell,
  ROAD_C,
  ROAD_D,
  ROAD_N,
  type RoadClass,
  type RoadEdge,
  RoadGraph,
  rngEdge,
  routeLength,
  segmentsCross,
} from './roads';
import { FARM, HAMLET, type Site, type Settlements, TOWN, VILLAGE } from './settle';

/** 'mesh' (dense first, then classified) or 'tree' (the older network, for comparison). */
let mode: 'mesh' | 'tree' = 'mesh';
export function setNetworkMode(m: string): void {
  mode = m === 'tree' ? 'tree' : 'mesh';
}
export const networkMode = () => mode;

/**
 * Road network, dense first: every settlement is linked to its neighbours, main
 * roads are the cheapest paths through that mesh between towns (N) and villages
 * (D), and the remaining links are thinned to a mesh without redundant ways round.
 * Farms are linked in last, to a neighbour or the nearest bit of road.
 *
 * Neighbouring cells must agree on every decision, so none depends on processing
 * order or on how far a cell happens to look — each is a function of the
 * candidates near the thing decided:
 *
 *  - Candidates: Gabriel links between settlements (no other one inside the circle
 *    spanned by a pair), up to LINK_MAX, each routed on the coarse grid.
 *  - Mesh: a candidate is in the mesh unless it winds far more than the straight
 *    line, crosses a shorter (non-winding) candidate, or mostly runs beside shorter
 *    candidates that are themselves uncrossed. A settlement left without any link
 *    gets its shortest candidate.
 *  - Main roads: for each town pair and village pair (relative-neighbourhood graphs),
 *    the cheapest path over the mesh links inside a fixed corridor around the pair,
 *    with turns at settlements costing extra (much more in hamlets). Links on it
 *    take the pair's class.
 *  - Thinning: a mesh link is kept if it is a main road, or if the way round over
 *    all shorter mesh links is longer than MESH_T × its length. (Every dropped link
 *    has a way round over shorter ones, so the network stays connected.)
 *  - Farms: links to neighbours and to the nearest road waypoint, decided the same
 *    way among farm candidates, never crossing a kept road.
 *  - Geometry: kept links near the cell are routed again, main roads first, each
 *    following roads already routed where it can and never crossing one between
 *    grid nodes. Farm drives to a road come last, joining at first contact.
 *
 * Edges are owned by the cell holding their first endpoint.
 */

/** Longest link between settlements, and from a farm (m). */
const LINK_MAX = 3200;
const FARM_LINK_MAX = 1200;
/** A farm may link to a road waypoint this far away (m). */
const FARM_TO_ROAD = 700;
/** Links whose route is longer than this × the straight line are not in the mesh. */
const LINK_DETOUR = 1.8;
/** Thinning ratios: settlement mesh and farm links. Lower = denser. */
const MESH_T = 1.25;
const FARM_T = 1.4;
/** Passing through a hamlet costs a main road this much (m): it shouldn't collect them all. */
const HAMLET_PASS = 300;
/** Turning straight back costs this much (m) in a village or town, and in a hamlet; less sharp turns pro rata. */
const TURN = 600;
const HAMLET_TURN = 2500;
/** Links mostly on or beside other roads (away from their ends) are redundant. */
const SHADOW_SHARE = 0.5;
const SHADOW_END = 300;
/** Main-road corridor: links whose ends lie within the ellipse |pa| + |pb| ≤ CORRIDOR × d + CORRIDOR_EXTRA. */
const CORRIDOR = 1.25;
const CORRIDOR_EXTRA = 1000;
/** Links re-routed for the final geometry around the cell (m): their predecessors shape them. */
const REROUTE_REACH = 2000;
/** Settlements considered around the cell (m): main-road corridors reaching the re-route region, and their candidates. */
const SITE_REACH = REROUTE_REACH + LINK_MAX + (CORRIDOR * MAX_LEN[ROAD_N] + CORRIDOR_EXTRA) + LINK_MAX + LINK_MAX / 2;

interface Route {
  route: number[];
  len: number;
  cost: number;
}

interface Cand {
  a: Site;
  b: Site;
  /** Straight distance: the order in which candidates outrank each other (ties by key). */
  d: number;
  key: string;
  mx: number;
  my: number;
}

/** Link routes are pure functions of their ends; cached per worker across cells. */
const routeCache = new Map<string, Route>();
const ROUTE_CACHE_MAX = 60000;

function routeLink(a: Site, b: Site, field: CoarseField): Route {
  // Site positions are hashed from their seeds: the same ends mean the same terrain.
  const k = `${a.x},${a.y}|${b.x},${b.y}`;
  let r = routeCache.get(k);
  if (!r) {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const out = { cost: 0 };
    const route = coarseRoute(a, b, field, undefined, Math.min(1536, Math.max(512, d / 2)), out);
    r = { route, cost: out.cost, len: routeLength(route) };
    if (routeCache.size >= ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value!);
    routeCache.set(k, r);
  }
  return r;
}

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

/** Gabriel candidates (a.id < b.id) among `nodes`, up to `max` long, where `keep(a, b)` holds. */
function gabriel(nodes: Site[], grid: Grid<Site>, max: number, keep: (a: Site, b: Site) => boolean): Cand[] {
  const out: Cand[] = [];
  for (const a of nodes)
    for (const b of grid.near(a.x, a.y, max)) {
      if (a.id >= b.id || !keep(a, b)) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (grid.near(mx, my, d / 2 - 1e-6).some((c) => c !== a && c !== b)) continue;
      out.push({ a, b, d, key: `${a.id}=${b.id}`, mx, my });
    }
  return out;
}

/** Does p outrank q (shorter, ties by key)? */
const shorter = (p: Cand, q: Cand) => p.d < q.d || (p.d === q.d && p.key < q.key);

/** Do two coarse routes cross properly (not at a shared point)? */
function routesCross(r: number[], s: number[]): boolean {
  for (let i = 2; i < r.length; i += 2) {
    const a = { x: r[i - 2], y: r[i - 1] };
    const b = { x: r[i], y: r[i + 1] };
    for (let j = 2; j < s.length; j += 2)
      if (segmentsCross(a, b, { x: s[j - 2], y: s[j - 1] }, { x: s[j], y: s[j + 1] })) return true;
  }
  return false;
}

/** Grid nodes on or beside some routes. */
function besideOf(routes: number[][]): Set<string> {
  const set = new Set<string>();
  for (const r of routes)
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] % COARSE || r[i + 1] % COARSE) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) set.add(`${r[i] + dx * COARSE},${r[i + 1] + dy * COARSE}`);
    }
  return set;
}

/** Is most of route r (away from its ends a, b) on or beside `set`? */
function shadowed(r: number[], a: Site, b: Site, set: Set<string>): boolean {
  let n = 0;
  let on = 0;
  for (let i = 2; i < r.length - 2; i += 2) {
    if (Math.hypot(r[i] - a.x, r[i + 1] - a.y) < SHADOW_END || Math.hypot(r[i] - b.x, r[i + 1] - b.y) < SHADOW_END) continue;
    n++;
    if (set.has(`${r[i]},${r[i + 1]}`)) on++;
  }
  return on > SHADOW_SHARE * n;
}

export function meshCell(gx: number, gy: number, field: CoarseField, set: Settlements): NetCell {
  const x0 = gx * NET_CELL;
  const y0 = gy * NET_CELL;
  const x1 = x0 + NET_CELL;
  const y1 = y0 + NET_CELL;
  const inBox = (s: { x: number; y: number }, m: number) => s.x >= x0 - m && s.x < x1 + m && s.y >= y0 - m && s.y < y1 + m;
  const sitesIn = (rank: 0 | 1 | 2 | 3, m: number) => set.sitesIn(rank, x0 - m, y0 - m, x1 + m, y1 + m);
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const route = (c: Cand) => routeLink(c.a, c.b, field);

  // Candidates between settlements.
  const towns = sitesIn(TOWN, SITE_REACH);
  const villages = sitesIn(VILLAGE, SITE_REACH);
  const settled = [...towns, ...villages, ...sitesIn(HAMLET, SITE_REACH)];
  const sgrid = new Grid(settled, 1024);
  const cands = gabriel(settled, sgrid, LINK_MAX, () => true);
  const cgrid = new Grid(
    cands.map((c) => ({ x: c.mx, y: c.my, c })),
    2048,
  );
  /** Candidates whose routes could come near c's. */
  const around = (c: Cand) => cgrid.near(c.mx, c.my, 0.9 * (c.d + LINK_MAX) + 300).map((g) => g.c);
  const bySite = new Map<Site, Cand[]>();
  for (const c of cands)
    for (const s of [c.a, c.b]) {
      if (!bySite.has(s)) bySite.set(s, []);
      bySite.get(s)!.push(c);
    }

  // Mesh membership (memoised, order-free).
  const memo = <T>(f: (c: Cand) => T) => {
    const m = new Map<Cand, T>();
    return (c: Cand) => {
      let v = m.get(c);
      if (v === undefined) m.set(c, (v = f(c)));
      return v;
    };
  };
  const straightish = memo((c) => route(c).len <= LINK_DETOUR * c.d);
  const uncrossed = memo((c) => straightish(c) && !around(c).some((o) => shorter(o, c) && straightish(o) && routesCross(route(o).route, route(c).route)));
  const meshCore = memo((c) => {
    if (!uncrossed(c)) return false;
    const by = around(c).filter((o) => shorter(o, c) && uncrossed(o));
    return !shadowed(route(c).route, c.a, c.b, besideOf(by.map((o) => route(o).route)));
  });
  /** A settlement left without any link keeps its shortest candidate (straightish if it has one). */
  const rescue = (s: Site) => {
    const cs = bySite.get(s) ?? [];
    if (cs.some(meshCore)) return undefined;
    const pool = cs.some(straightish) ? cs.filter(straightish) : cs;
    return pool.reduce<Cand | undefined>((b, c) => (!b || shorter(c, b) ? c : b), undefined);
  };
  const inMesh = memo((c) => meshCore(c) || rescue(c.a) === c || rescue(c.b) === c);

  // Main roads: cheapest corridor paths, turns included.
  const dirCache = new Map<Cand, [number, number, number, number]>();
  const leave = (c: Cand, s: Site): [number, number] => {
    let d = dirCache.get(c);
    if (!d) {
      const r = route(c).route;
      const out = (from: number, step: number): [number, number] => {
        const x = r[from];
        const y = r[from + 1];
        let k = from;
        while (k + step >= 0 && k + step < r.length && Math.hypot(r[k] - x, r[k + 1] - y) < 300) k += step;
        const L = Math.hypot(r[k] - x, r[k + 1] - y) || 1;
        return [(r[k] - x) / L, (r[k + 1] - y) / L];
      };
      d = [...out(0, 2), ...out(r.length - 2, -2)] as [number, number, number, number];
      dirCache.set(c, d);
    }
    return s === c.a ? [d[0], d[1]] : [d[2], d[3]];
  };
  const passCost = (s: Site, cin: Cand, cout: Cand) => {
    const [ux, uy] = leave(cin, s);
    const [vx, vy] = leave(cout, s);
    const turn = (1 + ux * vx + uy * vy) / 2; // 0 straight on, 1 straight back
    return s.rank === HAMLET ? HAMLET_PASS + HAMLET_TURN * turn : TURN * turn;
  };
  const cls = new Map<Cand, RoadClass>();
  const extra: { a: Site; b: Site; route: number[]; cls: RoadClass }[] = [];
  const classify = (k: RoadClass, a: Site, b: Site) => {
    const d = dist(a, b);
    const reach = CORRIDOR * d + CORRIDOR_EXTRA;
    const inside = (s: Site) => dist(s, a) + dist(s, b) <= reach;
    const links = cgrid
      .near((a.x + b.x) / 2, (a.y + b.y) / 2, reach / 2)
      .map((g) => g.c)
      .filter((c) => inside(c.a) && inside(c.b) && inMesh(c));
    const adj = new Map<Site, { to: Site; c: Cand }[]>();
    for (const c of links)
      for (const [p, q] of [
        [c.a, c.b],
        [c.b, c.a],
      ]) {
        if (!adj.has(p)) adj.set(p, []);
        adj.get(p)!.push({ to: q, c });
      }
    type State = { s: Site; c: Cand | null; cost: number; prev: State | null };
    const best = new Map<string, number>();
    const states: State[] = [{ s: a, c: null, cost: 0, prev: null }];
    const heap = new MinHeap(64);
    heap.push(0, 0);
    const done = new Set<string>();
    while (heap.size) {
      const st = states[heap.pop()];
      const sk = `${st.s.id}|${st.c?.key ?? ''}`;
      if (done.has(sk)) continue;
      done.add(sk);
      if (st.s === b) {
        for (let t: State | null = st; t && t.c; t = t.prev) if (!cls.has(t.c) || k < cls.get(t.c)!) cls.set(t.c, k);
        return;
      }
      for (const { to, c } of adj.get(st.s) ?? []) {
        if (c === st.c) continue;
        const nc = st.cost + route(c).cost + (st.c ? passCost(st.s, st.c, c) : 0);
        const nk = `${to.id}|${c.key}`;
        if (nc >= (best.get(nk) ?? Infinity)) continue;
        best.set(nk, nc);
        states.push({ s: to, c, cost: nc, prev: st });
        heap.push(states.length - 1, nc);
      }
    }
    // No way through the mesh (a lake, a ridge): a direct road.
    extra.push({ a, b, route: coarseRoute(a, b, field), cls: k });
  };
  /** Does the pair's corridor reach the links this cell needs classified? */
  const relevant = (a: Site, b: Site) => {
    const r = (CORRIDOR * dist(a, b) + CORRIDOR_EXTRA) / 2;
    const m = REROUTE_REACH + LINK_MAX;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return mx + r >= x0 - m && mx - r < x1 + m && my + r >= y0 - m && my - r < y1 + m;
  };
  for (const a of towns)
    for (const b of towns)
      if (a.id < b.id && dist(a, b) <= MAX_LEN[ROAD_N] && relevant(a, b) && rngEdge(a, b, towns)) classify(ROAD_N, a, b);
  const tv = [...towns, ...villages];
  for (const a of tv)
    for (const b of tv) {
      if (a.id >= b.id || (a.rank === TOWN && b.rank === TOWN)) continue;
      if (dist(a, b) <= MAX_LEN[ROAD_D] && relevant(a, b) && rngEdge(a, b, tv)) classify(ROAD_D, a, b);
    }

  // Thinning: main roads, and links whose way round over shorter mesh links is long.
  const kept = memo((c) => {
    if (!inMesh(c)) return false;
    if (cls.has(c)) return true;
    const len = route(c).len;
    const g = new RoadGraph();
    for (const o of cgrid.near(c.mx, c.my, (MESH_T * len) / 2 + LINK_MAX / 2).map((x) => x.c))
      if (shorter(o, c) && inMesh(o)) g.addRoute(route(o).route);
    return g.distance(c.a, c.b, MESH_T * len) > MESH_T * len;
  });

  // Farms: candidates to neighbours and to the nearest kept road waypoint.
  const farmReach = REROUTE_REACH;
  const farms = sitesIn(FARM, farmReach + FARM_LINK_MAX);
  const keptNear = cgrid
    .near((x0 + x1) / 2, (y0 + y1) / 2, NET_CELL / 2 + farmReach + 2 * FARM_LINK_MAX + LINK_MAX)
    .map((g) => g.c)
    .filter(kept);
  const keptRoutes = keptNear.map((c) => route(c).route);
  const keptGraph = new RoadGraph();
  for (const r of keptRoutes) keptGraph.addRoute(r);
  const near = [...settled.filter((s) => inBox(s, farmReach + 2 * FARM_LINK_MAX)), ...farms];
  const fcands = gabriel(near, new Grid(near, 512), FARM_LINK_MAX, (a, b) => a.rank === FARM || b.rank === FARM);
  const waypoints = new Grid(
    keptGraph.points().filter((p) => inBox(p, farmReach + FARM_LINK_MAX + FARM_TO_ROAD)),
    512,
  );
  for (const f of farms) {
    let best: { x: number; y: number } | undefined;
    for (const p of waypoints.near(f.x, f.y, FARM_TO_ROAD)) if (!best || dist(f, p) < dist(f, best) || (dist(f, p) === dist(f, best) && p.x < best.x)) best = p;
    if (!best) continue;
    const w: Site = { id: `n:${best.x},${best.y}`, rank: FARM, x: best.x, y: best.y, z: 0, R: f.R };
    fcands.push({ a: f, b: w, d: dist(f, w), key: `${f.id}=${w.id}`, mx: (f.x + w.x) / 2, my: (f.y + w.y) / 2 });
  }
  const fgrid = new Grid(
    fcands.map((c) => ({ x: c.mx, y: c.my, c })),
    1024,
  );
  const faround = (c: Cand) => fgrid.near(c.mx, c.my, c.d + FARM_LINK_MAX).map((g) => g.c);
  const fvalid = memo((c) => route(c).len <= LINK_DETOUR * c.d + 100 && !keptGraph.routeCrosses(route(c).route));
  const funcrossed = memo((c) => fvalid(c) && !faround(c).some((o) => shorter(o, c) && fvalid(o) && routesCross(route(o).route, route(c).route)));
  const farmFirst = new Map<Site, Cand>();
  for (const c of [...fcands].sort((p, q) => (shorter(p, q) ? -1 : 1)))
    for (const s of [c.a, c.b]) if (s.rank === FARM && !farmFirst.has(s) && funcrossed(c)) farmFirst.set(s, c);
  const keptBeside = besideOf(keptRoutes);
  const kgrid = new Grid(
    keptNear.map((c) => ({ x: c.mx, y: c.my, r: route(c).route })),
    2048,
  );
  const fkept = (c: Cand) => {
    if (!funcrossed(c)) return false;
    if (farmFirst.get(c.a) === c || farmFirst.get(c.b) === c) return true;
    const len = route(c).len;
    const others = faround(c).filter((o) => shorter(o, c) && funcrossed(o));
    const beside = besideOf(others.map((o) => route(o).route));
    for (const k of keptBeside) beside.add(k);
    if (shadowed(route(c).route, c.a, c.b, beside)) return false;
    const g = new RoadGraph();
    for (const k of kgrid.near(c.mx, c.my, (FARM_T * len) / 2 + LINK_MAX)) g.addRoute(k.r);
    for (const o of others) g.addRoute(route(o).route);
    return g.distance(c.a, c.b, FARM_T * len) > FARM_T * len;
  };

  // Geometry: re-route kept links near the cell, main roads first, following roads
  // already routed (cheaper) and never crossing one between grid nodes.
  type Final = { a: Site; b: Site; d: number; cls: RoadClass; route?: number[] };
  const finals: Final[] = [];
  const nearCell = (c: { a: Site; b: Site }) => inBox(c.a, REROUTE_REACH) || inBox(c.b, REROUTE_REACH);
  for (const c of keptNear) if (nearCell(c)) finals.push({ a: c.a, b: c.b, d: c.d, cls: cls.get(c) ?? ROAD_C });
  for (const e of extra) if (nearCell(e)) finals.push({ a: e.a, b: e.b, d: dist(e.a, e.b), cls: e.cls, route: e.route });
  const drives: Final[] = [];
  for (const c of fcands)
    if (nearCell(c) && fkept(c)) (c.b.id.startsWith('n:') ? drives : finals).push({ a: c.a, b: c.b, d: c.d, cls: ROAD_C });
  const order = (p: Final, q: Final) => p.cls - q.cls || p.d - q.d || (p.a.id + p.b.id < q.a.id + q.b.id ? -1 : 1);
  finals.sort(order);
  drives.sort(order);

  const reuse = new Set<string>();
  const routed: number[] = [];
  const gridAdj = new Map<string, [number, number][]>();
  const addGrid = (r: number[]) => {
    for (let i = 2; i < r.length; i += 2) {
      const [ax, ay, bx, by] = [r[i - 2], r[i - 1], r[i], r[i + 1]];
      if (ax % COARSE || ay % COARSE || bx % COARSE || by % COARSE) continue;
      const p: [number, number] = [ax / COARSE, ay / COARSE];
      const q: [number, number] = [bx / COARSE, by / COARSE];
      for (const [u, v] of [
        [p, q],
        [q, p],
      ]) {
        const k = `${u[0]},${u[1]}`;
        if (!gridAdj.has(k)) gridAdj.set(k, []);
        gridAdj.get(k)!.push(v);
      }
    }
  };
  const blocked = (i0: number, j0: number, i1: number, j1: number) => {
    if (Math.abs(i1 - i0) + Math.abs(j1 - j0) < 2) return false; // axis moves only meet others at nodes
    const P = { x: i0, y: j0 };
    const Q = { x: i1, y: j1 };
    for (let j = Math.min(j0, j1) - 1; j <= Math.max(j0, j1) + 1; j++)
      for (let i = Math.min(i0, i1) - 1; i <= Math.max(i0, i1) + 1; i++)
        for (const [u, v] of gridAdj.get(`${i},${j}`) ?? []) if (segmentsCross(P, Q, { x: i, y: j }, { x: u, y: v })) return true;
    return false;
  };
  const margin = (f: Final) => Math.min(1536, Math.max(512, f.d / 2));
  const finalRoute = (f: Final, joins?: Map<string, [number, number]>) => {
    if (f.route) return f.route; // direct main roads keep theirs
    const out = { cost: 0 };
    let r = coarseRoute(f.a, f.b, field, joins, margin(f), out, joins ? undefined : reuse, blocked);
    if (out.cost === Infinity) r = coarseRoute(f.a, f.b, field, joins, margin(f), undefined, joins ? undefined : reuse);
    return r;
  };
  const edges: RoadEdge[] = [];
  const emit = (f: Final, r: number[]) => {
    // Owned edges: first endpoint in the cell.
    if (inBox(f.a, 0)) edges.push({ id: `${f.a.id}=${f.b.id}`, cls: f.cls, a: f.a, b: f.b, route: r });
  };
  for (const f of finals) {
    const r = finalRoute(f);
    markReuse(reuse, r);
    addGrid(r);
    routed.push(...r);
    emit(f, r);
  }
  const joins = joinMap(routed);
  for (const f of drives) {
    const r = finalRoute(f, joins);
    addGrid(r);
    emit(f, r);
  }

  const sites = [...settled, ...farms].filter((s) => inBox(s, 0));
  return { sites, edges };
}

