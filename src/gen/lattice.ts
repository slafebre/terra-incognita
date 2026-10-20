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
  type RoadClass,
  type RoadEdge,
  type RoadPatch,
  rngEdge,
  type SegmentPath,
  type SegmentTask,
} from './roads';
import { FARM, HAMLET, type Site, type Settlements, TOWN, VILLAGE } from './settle';

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
 *  4. Farm roads: the same, grown from main and hamlet roads.
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

const edgeKey = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);

/** Terrain at vertices, cached per field. */
const vertexCache = new WeakMap<CoarseField, Map<number, { x: number; y: number; z: number; valley: number }>>();
function vdata(field: CoarseField, v: number) {
  let m = vertexCache.get(field);
  if (!m) vertexCache.set(field, (m = new Map()));
  let d = m.get(v);
  if (!d) {
    const [x, y] = vertexPos(v);
    d = { x, y, z: field.z(x, y), valley: smoothstep(VALLEY_AREA[0], VALLEY_AREA[1], field.area(x, y)) };
    m.set(v, d);
  }
  return d;
}

/** Cost of edge u–v for a road class (symmetric). */
function edgeCost(field: CoarseField, u: number, v: number, cls: RoadClass): number {
  const a = vdata(field, u);
  const b = vdata(field, v);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const gmax = MAX_GRADE[cls];
  const g = Math.abs(b.z - a.z) / len;
  let c = len * (1 + 3 * (g / gmax) ** 2);
  if (g > gmax) c *= 1 + 15 * (g / gmax - 1); // only where there's no way round
  c *= 1 - (VALLEY_BONUS * (a.valley + b.valley)) / 2;
  const lo = Math.min(u, v);
  const hi = Math.max(u, v);
  c *= 1 + 0.01 * (hash3(hash3(0x7e1d9, vi(lo), vj(lo)), vi(hi), vj(hi)) / 4294967296);
  return c;
}
/** No edge costs less than this × its length (for A* estimates). */
const MIN_FACTOR = 1 - VALLEY_BONUS;

export function latticeCell(gx: number, gy: number, field: CoarseField, set: Settlements): NetCell {
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
  const farmM = FARM_REACH;
  const farmForestM = farmM + FARM_REACH;
  const hamletM = farmForestM + HAMLET_REACH;
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
  const mainPath = (k: RoadClass, a: Site, b: Site) => {
    const d = dist(a, b);
    const reach = CORRIDOR * d + CORRIDOR_EXTRA;
    const inside = (v: number) => {
      const p = pos(v);
      return dist(p, a) + dist(p, b) <= reach;
    };
    const va = nearestVertex(a.x, a.y);
    const vb = nearestVertex(b.x, b.y);
    const pb = pos(vb);
    // States: (vertex, previous vertex), for turn costs.
    const key = (v: number, from: number) => `${v}:${from}`;
    const cost = new Map<string, number>();
    const prev = new Map<string, string>();
    const states: [number, number][] = [[va, -1]];
    const heap = new MinHeap(256);
    cost.set(key(va, -1), 0);
    heap.push(0, MIN_FACTOR * dist(pos(va), pb));
    const done = new Set<string>();
    let goal: string | undefined;
    while (heap.size) {
      const [v, from] = states[heap.pop()];
      const sk = key(v, from);
      if (done.has(sk)) continue;
      done.add(sk);
      if (v === vb) {
        goal = sk;
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
    if (!goal) return;
    for (let s = goal; prev.has(s); s = prev.get(s)!) {
      const [v, from] = s.split(':').map(Number);
      use(from, v, k);
    }
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
  const forest = (sources: Set<number>, m: number, reach: number): Map<number, number> => {
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
        const c = c0 + edgeCost(field, v, w, ROAD_C);
        if (c > reach || c >= (cost.get(w) ?? Infinity)) continue;
        cost.set(w, c);
        parent.set(w, v);
        ids.push(w);
        heap.push(ids.length - 1, c);
      }
    }
    return parent;
  };
  const networkVertices = (extra: Site[]) => {
    const s = new Set<number>();
    for (const e of cls.values()) s.add(e.u).add(e.v);
    for (const t of extra) s.add(nearestVertex(t.x, t.y));
    return s;
  };
  const follow = (parent: Map<number, number>, from: number, k: RoadClass) => {
    for (let v = from; parent.has(v); v = parent.get(v)!) use(v, parent.get(v)!, k);
  };

  // 3. Hamlet roads.
  const tvNear = tv.filter((s) => inBox(s, hamletForestM));
  const pA = forest(networkVertices(tvNear), hamletForestM, HAMLET_REACH * COST_CAP);
  const hamlets = sitesIn(HAMLET, hamletM);
  for (const h of hamlets) follow(pA, nearestVertex(h.x, h.y), ROAD_C);

  // 4. Farm roads.
  const pB = forest(networkVertices([...tvNear, ...hamlets]), farmForestM, FARM_REACH * COST_CAP);
  const farms = sitesIn(FARM, farmM);
  for (const f of farms) follow(pB, nearestVertex(f.x, f.y), ROAD_C);

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
    const n = Math.max(2, Math.ceil(len / 8));
    const xy = new Float32Array(2 * (n + 1));
    for (let s = 0; s <= n; s++) {
      const u = s / n;
      const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
      const h10 = u ** 3 - 2 * u ** 2 + u;
      const h01 = -2 * u ** 3 + 3 * u ** 2;
      const h11 = u ** 3 - u ** 2;
      xy[2 * s] = h00 * ax + h10 * t0x + h01 * bx + h11 * t1x;
      xy[2 * s + 1] = h00 * ay + h10 * t0y + h01 * by + h11 * t1y;
    }
    return { key: t.key, cls: t.cls, xy, curve: true };
  });
}
