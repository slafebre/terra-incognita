import { hash1, hash3, rng } from '../lib/hash';
import { lerp, smoothstep } from '../lib/noise';
import { NODE } from './hydro';
import { nearestVertex, vertexPos } from './lattice';
import type { RoadPatch, SegmentPath } from './roads';
import { TOWN, VILLAGE, type Rank, type Site } from './settle';

/**
 * Street plans for villages and towns — the inner network of a settlement.
 *
 * A plan is made once per settlement, from the roads the network drew through it
 * (their final, terrain-fitted curves) and the fine terrain around it, and every
 * chunk it touches draws it. It is a pure function of those inputs and the site.
 *
 * Streets grow out of the roads entering the settlement. Points along every street
 * so far are candidate branch points, nearest the centre first; a branch leaves at
 * roughly a right angle and walks on in short steps, steering for gentle, dry
 * ground, until it
 *  - runs into another street (a junction: the loops of a clustered village),
 *  - comes too close alongside one, leaves the settlement or the land gets too
 *    steep or wet (a dead end, kept if long enough to be a lane), or
 *  - reaches its length.
 * Some branches bend round the centre after a short run: back lanes that join the
 * next road round, the ring of a nucleated village. Accepted streets branch in turn,
 * a few generations deep. Towns grow an organic core this way, and beyond it
 * straighter, more regular suburban streets.
 *
 * Output: the streets, the built-up frontage along streets and roads, and the
 * centre (the crossroads the roads meet at, where the church stands).
 */

export const STREET = 0;
/** Narrow lanes: short dead ends and the outer, sparser growth. */
export const LANE = 1;
export type StreetClass = typeof STREET | typeof LANE;

export interface Street {
  cls: StreetClass;
  /** World coordinates [x0, y0, …]. */
  xy: Float32Array;
}

export interface TownPlan {
  id: string;
  rank: Rank;
  /** Centre: the crossroads the settlement's roads meet at. */
  x: number;
  y: number;
  streets: Street[];
  /** Road segments the plan redraws, replacing the roads stage's (same keys). */
  roads: SegmentPath[];
  /** Built-up land: a strip `depth` m each side of each polyline. */
  frontage: { depth: number; xy: Float32Array }[];
}

/** Everything a plan draws lies within this distance of its site (m), per rank. */
export const PLAN_EXTENT = [900, 380];
/** Roads and terrain the plan reads: its extent plus this margin (m). */
export const PLAN_MARGIN = 64;
/** What a plan draws reaches this far beyond its extent (frontage, line widths; m). */
export const PLAN_DRAW_PAD = 40;

/** Growth parameters for one zone of a settlement. */
interface Style {
  /** Branch spacing along a street (m). */
  spacing: number;
  /** Chance that a branch point is tried at all (at the centre; falls off outward). */
  density: number;
  /** Branch length range (m). */
  len: [number, number];
  /** Heading jitter at the branch point (rad). */
  jitter: number;
  /** Per-step steering options (rad). */
  steer: number[];
  /** Chance that a branch bends round the centre (back lane). */
  ring: number;
  /** Heading drift per step (rad). */
  wander: number;
  /** Generations of branches off branches. */
  gens: number;
  /** Chance a dead end is kept. */
  deadEnd: number;
  /** Frontage depth (m). */
  depth: number;
  cls: StreetClass;
}

const STEP = 12;
/** A branch ending this close to another street joins it (m). */
const SNAP = 20;
/** Streets keep at least this far apart where they don't meet (m). */
const GAP = 26;
/** Attempts per branch point. */
const RETRIES = 2;
/** Branches leave at least this far from other junctions on their parent (m). */
const BLOCK = 42;
/** Junction angles below this are refused (rad). */
const MIN_ANGLE = (32 * Math.PI) / 180;
/** Gradient limit for streets (soft above SOFT, refused above HARD × it). */
const GRADE = 0.14;
const HARD = 1.6;
/** Drainage area (km²) above which a street won't cross; below it a stream is bridged at most once. */
const RIVER_A = 3;
const STREAM_A = 0.15;

export interface PlanInput {
  site: Site;
  /** Drawn road segments near the site (any order). */
  roads: SegmentPath[];
  /** Fine nodes covering the site's extent plus margin. */
  patch: RoadPatch;
}

interface Line {
  xs: number[];
  ys: number[];
  /** Cumulative arc length at each point. */
  s: number[];
  road: boolean;
  gen: number;
  style: Style | null;
}

/** Debugging: why branches ended or were refused, summed over plans. */
export const planStats: Record<string, number> = {};

export function planTown({ site, roads, patch: p }: PlanInput): TownPlan {
  const rank = site.rank;
  if (rank !== TOWN && rank !== VILLAGE) throw new Error('plans are for villages and towns');
  const seed = hashString(site.id);
  const rand = rng(seed);
  const R = site.R;

  // --- Terrain -----------------------------------------------------------------
  const { w, h } = p;
  const node = (x: number, y: number) => {
    const i = Math.round(x / NODE) - p.gx;
    const j = Math.round(y / NODE) - p.gy;
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };
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
  const wet = (x: number, y: number) => {
    const k = node(x, y);
    return k < 0 || !Number.isNaN(p.lake[k]);
  };
  const areaAt = (x: number, y: number) => {
    const k = node(x, y);
    return k < 0 ? 0 : p.A[k];
  };

  // --- Centre and the roads through the settlement ---------------------------------
  const sorted = [...roads].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const [vx, vy] = vertexPos(nearestVertex(site.x, site.y));
  // The roads meet at the site's lattice vertex, snapped (≤ 32 m) to gentler ground.
  let cx = vx;
  let cy = vy;
  let cd = Infinity;
  for (const r of sorted)
    for (const i of [0, r.xy.length - 2]) {
      const d = Math.hypot(r.xy[i] - vx, r.xy[i + 1] - vy);
      if (d < cd) {
        cd = d;
        cx = r.xy[i];
        cy = r.xy[i + 1];
      }
    }
  const extent = PLAN_EXTENT[rank] - Math.hypot(cx - site.x, cy - site.y);

  // Settlement size: lowland villages sprawl more than mountain ones.
  const mount = smoothstep(0.35, 0.85, R);
  const size = (0.75 + 0.5 * rand()) * lerp(1, 0.6, mount);
  const core = rank === TOWN ? lerp(260, 340, rand()) * size : lerp(140, 200, rand()) * size;
  const reach = Math.min(extent - 30, rank === TOWN ? lerp(650, 850, rand()) * size : core * 1.7);
  const budget = (rank === TOWN ? lerp(14000, 22000, rand()) : lerp(900, 2000, rand())) * size * size;

  const organic: Style = {
    spacing: rank === TOWN ? 55 : 70,
    density: rank === TOWN ? 0.9 : 0.75,
    len: rank === TOWN ? [50, 160] : [50, 200],
    jitter: 0.35,
    steer: [-1, -0.5, -0.25, 0, 0.25, 0.5, 1],
    wander: 0.12,
    ring: rank === TOWN ? 0.25 : 0.25,
    gens: rank === TOWN ? 4 : 2,
    deadEnd: rank === TOWN ? 0.85 : 0.6,
    depth: rank === TOWN ? 24 : 22,
    cls: STREET,
  };
  const suburb: Style = {
    spacing: lerp(80, 105, rand()),
    density: 0.8,
    len: [90, 260],
    jitter: 0.05,
    steer: [-0.6, -0.15, 0, 0.15, 0.6],
    wander: 0.02,
    ring: 0,
    gens: 3,
    deadEnd: 0.5,
    depth: 20,
    cls: STREET,
  };
  const outer: Style = { ...organic, density: 0.35, ring: 0.15, gens: 1, deadEnd: 0.8, depth: 18, cls: LANE };
  const styleAt = (d: number): Style | null =>
    d < core ? organic : d < reach ? (rank === TOWN ? suburb : outer) : null;

  // --- The network so far: lines with a spatial index of their pieces --------------
  const lines: Line[] = [];
  const CELL = 32;
  const grid = new Map<number, number[]>(); // packed (line, piece) ids
  const gkey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  const indexPiece = (li: number, k: number) => {
    const L = lines[li];
    const x0 = Math.min(L.xs[k], L.xs[k + 1]);
    const x1 = Math.max(L.xs[k], L.xs[k + 1]);
    const y0 = Math.min(L.ys[k], L.ys[k + 1]);
    const y1 = Math.max(L.ys[k], L.ys[k + 1]);
    for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++)
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
        const g = gkey(i, j);
        let a = grid.get(g);
        if (!a) grid.set(g, (a = []));
        a.push(li * 4096 + k);
      }
  };
  const addLine = (xs: number[], ys: number[], road: boolean, gen: number, style: Style | null) => {
    const s = [0];
    for (let i = 1; i < xs.length; i++) s.push(s[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
    const li = lines.push({ xs, ys, s, road, gen, style }) - 1;
    for (let k = 0; k + 1 < xs.length; k++) indexPiece(li, k);
    return li;
  };
  /** Pieces near (x, y) within r: [line, piece]. */
  const piecesNear = (x: number, y: number, r: number): [number, number][] => {
    const out: [number, number][] = [];
    const seen = new Set<number>();
    for (let j = Math.floor((y - r) / CELL); j <= Math.floor((y + r) / CELL); j++)
      for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++)
        for (const id of grid.get(gkey(i, j)) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          out.push([Math.floor(id / 4096), id % 4096]);
        }
    return out;
  };
  /** Nearest point on the network to (x, y) within r, skipping `skip(line, s)`. */
  const nearest = (x: number, y: number, r: number, skip?: (li: number, s: number, x: number, y: number) => boolean) => {
    let best: { li: number; k: number; x: number; y: number; d: number; s: number } | null = null;
    for (const [li, k] of piecesNear(x, y, r)) {
      const L = lines[li];
      const ax = L.xs[k];
      const ay = L.ys[k];
      const dx = L.xs[k + 1] - ax;
      const dy = L.ys[k + 1] - ay;
      const l2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = Math.hypot(px - x, py - y);
      const s = L.s[k] + t * Math.sqrt(l2);
      if (d <= r && (!best || d < best.d) && !(skip && skip(li, s, px, py))) best = { li, k, x: px, y: py, d, s };
    }
    return best;
  };
  /** First crossing of segment a→b with the network, skipping `skip`. */
  const crossing = (ax: number, ay: number, bx: number, by: number, skip?: (li: number, s: number, x: number, y: number) => boolean) => {
    let best: { li: number; k: number; x: number; y: number; t: number; s: number } | null = null;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    for (const [li, k] of piecesNear(mx, my, Math.hypot(bx - ax, by - ay) / 2 + 1)) {
      const L = lines[li];
      const cx0 = L.xs[k];
      const cy0 = L.ys[k];
      const ex = L.xs[k + 1] - cx0;
      const ey = L.ys[k + 1] - cy0;
      const dx = bx - ax;
      const dy = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx0 - ax) * ey - (cy0 - ay) * ex) / den;
      const u = ((cx0 - ax) * dy - (cy0 - ay) * dx) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const s = L.s[k] + u * Math.hypot(ex, ey);
      if (skip && skip(li, s, ax + t * dx, ay + t * dy)) continue;
      if (!best || t < best.t) best = { li, k, x: ax + t * dx, y: ay + t * dy, t, s };
    }
    return best;
  };
  /** Unit direction of line li at piece k. */
  const dirAt = (li: number, k: number): [number, number] => {
    const L = lines[li];
    const dx = L.xs[k + 1] - L.xs[k];
    const dy = L.ys[k + 1] - L.ys[k];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };

  // Roads seed the network, segments chained into whole roads where two meet end
  // to end (shared vertices are bit-identical), so a road reads as one line.
  {
    const ends = new Map<string, number[]>();
    const ek = (r: SegmentPath, end: number) => `${r.xy[end]},${r.xy[end + 1]}`;
    sorted.forEach((r, i) => {
      for (const end of [0, r.xy.length - 2]) {
        const k = ek(r, end);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k)!.push(i);
      }
    });
    const used = new Set<number>();
    const pts = (r: SegmentPath, rev: boolean) => {
      const out: [number, number][] = [];
      for (let i = 0; i < r.xy.length; i += 2) out.push([r.xy[i], r.xy[i + 1]]);
      return rev ? out.reverse() : out;
    };
    /** The other segment through a shared end, if the road simply continues there. */
    const next = (k: string, from: number) => {
      const at = ends.get(k)!;
      return at.length === 2 ? at.find((j) => j !== from)! : -1;
    };
    sorted.forEach((r, i) => {
      if (used.has(i)) return;
      used.add(i);
      let chain = pts(r, false);
      // Extend forwards from the end, then backwards from the start.
      for (const back of [false, true]) {
        let cur = i;
        for (;;) {
          const [x, y] = back ? chain[0] : chain[chain.length - 1];
          const j = next(`${x},${y}`, cur);
          if (j < 0 || used.has(j) || sorted[j].cls !== r.cls) break;
          used.add(j);
          const q = sorted[j];
          const fwd = q.xy[0] === x && q.xy[1] === y;
          const more = pts(q, back ? fwd : !fwd);
          chain = back ? [...more.slice(0, -1), ...chain] : [...chain, ...more.slice(1)];
          cur = j;
        }
      }
      addLine(chain.map((c) => c[0]), chain.map((c) => c[1]), true, 0, null);
    });
  }

  // --- Growth ------------------------------------------------------------------
  type Cand = { li: number; s: number; side: number; prio: number; tries: number };
  const heap: Cand[] = [];
  const push = (c: Cand) => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (heap[q].prio <= heap[i].prio) break;
      [heap[q], heap[i]] = [heap[i], heap[q]];
      i = q;
    }
  };
  const pop = (): Cand => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r2 = l + 1;
        let m = i;
        if (l < heap.length && heap[l].prio < heap[m].prio) m = l;
        if (r2 < heap.length && heap[r2].prio < heap[m].prio) m = r2;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const pointAt = (li: number, s: number): { x: number; y: number; k: number } => {
    const L = lines[li];
    let k = 0;
    while (k < L.s.length - 2 && L.s[k + 1] < s) k++;
    const t = (s - L.s[k]) / (L.s[k + 1] - L.s[k] || 1);
    return { x: L.xs[k] + t * (L.xs[k + 1] - L.xs[k]), y: L.ys[k] + t * (L.ys[k + 1] - L.ys[k]), k };
  };
  /** Branch points along line li, on both sides, within the settlement. */
  const offer = (li: number) => {
    const L = lines[li];
    const total = L.s[L.s.length - 1];
    for (const side of [1, -1]) {
      // Spacing comes from the zone at each point.
      let s = 15 + rand() * 40;
      while (s < total - 15) {
        const { x, y } = pointAt(li, s);
        const d = Math.hypot(x - cx, y - cy);
        const st = styleAt(d);
        if (!st) {
          s += 30;
          continue;
        }
        const fall = 1 - 0.6 * smoothstep(0, reach, d);
        if (rand() < st.density * fall) push({ li, s, side, prio: d * (0.75 + 0.5 * rand()) + 60 * L.gen, tries: 0 });
        s += st.spacing * (0.75 + 0.5 * rand());
      }
    }
  };
  let built = 0;
  const streets: { li: number; cls: StreetClass }[] = [];
  const no = (k: string) => (planStats[k] = (planStats[k] ?? 0) + 1);

  /**
   * Checks a proposed street (free of the network except at its two ends) against
   * water, steepness and the network; adds it if fit.
   */
  const tryStreet = (xs: number[], ys: number[], st: Style, gen: number): boolean => {
    const n = xs.length;
    const nearEnd = (_li: number, _s: number, x: number, y: number) =>
      Math.hypot(x - xs[0], y - ys[0]) < 30 || Math.hypot(x - xs[n - 1], y - ys[n - 1]) < 30;
    let steep = 0;
    for (let i = 1; i < n; i++) {
      if (wet(xs[i], ys[i]) || areaAt(xs[i], ys[i]) > RIVER_A) return no('link: water'), false;
      const L = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
      if (Math.abs(zAt(xs[i], ys[i]) - zAt(xs[i - 1], ys[i - 1])) > HARD * GRADE * L) steep++;
      if (crossing(xs[i - 1], ys[i - 1], xs[i], ys[i], nearEnd)) return no('link: crosses'), false;
      if (i < n - 1 && nearest(xs[i], ys[i], GAP, nearEnd)) return no('link: alongside'), false;
    }
    if (steep > 1) return no('link: steep'), false;
    let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const li = addLine(xs, ys, false, gen, st);
    streets.push({ li, cls: st.cls });
    built += len;
    no('LINK');
    return true;
  };

  /**
   * Back lanes: where neighbouring roads leave the centre, a lane from one to the
   * next round the back of the plots between them — leaving and meeting each road
   * square on, bulging outward. Opposite roads (a street village) get a lane along
   * the back on either side. In towns the outermost ring is the boulevard where the
   * walls stood.
   */
  const ring = (r: number, chance: number, st: Style) => {
    // Where lines cross the circle of radius r, by angle.
    const hits: { a: number; x: number; y: number; tx: number; ty: number; li: number }[] = [];
    lines.forEach((L, li) => {
      for (let k = 0; k + 1 < L.xs.length; k++) {
        const d0 = Math.hypot(L.xs[k] - cx, L.ys[k] - cy) - r;
        const d1 = Math.hypot(L.xs[k + 1] - cx, L.ys[k + 1] - cy) - r;
        if (d0 * d1 > 0 || d0 === d1) continue;
        const t = d0 / (d0 - d1);
        const x = L.xs[k] + t * (L.xs[k + 1] - L.xs[k]);
        const y = L.ys[k] + t * (L.ys[k + 1] - L.ys[k]);
        const [tx, ty] = dirAt(li, k);
        hits.push({ a: Math.atan2(y - cy, x - cx), x, y, tx, ty, li });
      }
    });
    hits.sort((p1, p2) => p1.a - p2.a);
    const n = hits.length;
    if (n < 1) return;
    for (let i = 0; i < n; i++) {
      const A = hits[i];
      const B = hits[(i + 1) % n];
      let gap = B.a - A.a;
      if (n === 1 || gap <= 0) gap += 2 * Math.PI;
      if (gap < (35 * Math.PI) / 180 || gap > (215 * Math.PI) / 180 || rand() > chance) continue;
      // Each end leaves its road square on, into the gap.
      const into = (h: typeof A, ox: number, oy: number): [number, number] => {
        const s1 = -h.ty * (ox - h.x) + h.tx * (oy - h.y) > 0 ? 1 : -1;
        return [-h.ty * s1, h.tx * s1];
      };
      // The end points: along each road a little, either way, for irregular plots.
      const rA = r * (0.85 + 0.3 * rand());
      const rB = r * (0.85 + 0.3 * rand());
      const P = (h: typeof A, rr: number) => {
        const L = lines[h.li];
        // Walk the line to radius rr near the hit.
        let best = [h.x, h.y];
        let bd = Infinity;
        for (let k = 0; k < L.xs.length; k++) {
          const dd = Math.abs(Math.hypot(L.xs[k] - cx, L.ys[k] - cy) - rr) + 0.3 * Math.hypot(L.xs[k] - h.x, L.ys[k] - h.y);
          if (dd < bd) {
            bd = dd;
            best = [L.xs[k], L.ys[k]];
          }
        }
        return best;
      };
      const [ax, ay] = P(A, rA);
      const [bx, by] = P(B, rB);
      const [nax, nay] = into(A, B.x, B.y);
      const [nbx, nby] = into(B, A.x, A.y);
      const d = Math.hypot(bx - ax, by - ay);
      if (d < 50) continue;
      const k = (gap > 2.4 ? 0.55 : 0.4) * d;
      const xs: number[] = [];
      const ys: number[] = [];
      const steps = Math.max(4, Math.ceil((1.3 * d) / STEP));
      for (let j = 0; j <= steps; j++) {
        const u = j / steps;
        const b0 = (1 - u) ** 3;
        const b1 = 3 * u * (1 - u) ** 2;
        const b2 = 3 * u * u * (1 - u);
        const b3 = u ** 3;
        xs.push(b0 * ax + b1 * (ax + nax * k) + b2 * (bx + nbx * k) + b3 * bx);
        ys.push(b0 * ay + b1 * (ay + nay * k) + b2 * (by + nby * k) + b3 * by);
      }
      tryStreet(xs, ys, st, 1);
    }
  };
  if (rank === TOWN) {
    ring(core, 0.9, { ...organic, cls: STREET });
    ring(core * 0.55, 0.6, organic);
  } else {
    ring(core * lerp(0.55, 0.8, rand()), 0.65, organic);
  }

  for (let li = 0; li < lines.length; li++) offer(li);

  while (heap.length && built < budget) {
    const c = pop();
    const parent = lines[c.li];
    const P = pointAt(c.li, c.s);
    const d0 = Math.hypot(P.x - cx, P.y - cy);
    const st = styleAt(d0);
    if (!st) {
      no('outside');
      continue;
    }
    if (!parent.road && parent.gen >= st.gens) {
      no('gens');
      continue;
    }
    // Pieces near the branch point don't count as obstacles: they're its own junction.
    const home = (_li: number, _s: number, x: number, y: number) => Math.hypot(x - P.x, y - P.y) < 30;
    const other = (li: number) => li !== c.li;
    const [tx, ty] = dirAt(c.li, P.k);
    // Normal to the parent, on the candidate's side.
    const nx0 = -ty * c.side;
    const ny0 = tx * c.side;
    // Not beside a junction on this side already: blocks need some frontage. (A
    // branch opposite another makes a crossroads, which is fine.)
    if (nearest(P.x, P.y, BLOCK, (li, _s, x, y) => li === c.li || (x - P.x) * nx0 + (y - P.y) * ny0 < 1)) {
      no('junction');
      continue;
    }
    let a = Math.atan2(ny0, nx0) + (rand() * 2 - 1) * st.jitter;
    // Room ahead.
    if (nearest(P.x + Math.cos(a) * 22, P.y + Math.sin(a) * 22, GAP * 0.8, (li) => li === c.li)) {
      no('crowded');
      continue;
    }
    const maxLen = lerp(st.len[0], st.len[1], rand());
    const ring = rand() < st.ring;
    const ringAfter = 25 + rand() * 40;
    const xs = [P.x];
    const ys = [P.y];
    let len = 0;
    let joined = false;
    let bridged = false;
    let failed = '';
    let stop = 'length';
    // Streets wander a little: a slowly drifting preferred heading.
    let drift = 0;
    const base = a;
    while (len < maxLen) {
      drift = Math.max(-0.6, Math.min(0.6, drift + (rand() * 2 - 1) * st.wander));
      const x = xs[xs.length - 1];
      const y = ys[ys.length - 1];
      const z = zAt(x, y);
      // Desired heading: straight on (wandering), or round the centre for a back lane.
      let want = base + drift;
      if (ring && len > ringAfter) {
        const ra = Math.atan2(y - cy, x - cx);
        // Tangent in the direction we're already turning, pulled back to the start radius.
        const t1 = ra + Math.PI / 2;
        const t2 = ra - Math.PI / 2;
        const tang = Math.abs(angDiff(t1, a)) < Math.abs(angDiff(t2, a)) ? t1 : t2;
        const dr = Math.hypot(x - cx, y - cy) - Math.max(d0, 60);
        want = tang + Math.sign(angDiff(ra, tang)) * Math.max(-0.5, Math.min(0.5, dr / 60));
      }
      // A street close ahead draws the branch in, to meet it square-ish (a junction,
      // not a near miss alongside).
      if (len >= STEP) {
        const ahead = nearest(x + Math.cos(a) * 30, y + Math.sin(a) * 30, 30, home);
        if (ahead) want = Math.atan2(ahead.y - y, ahead.x - x);
      }
      let best = Infinity;
      let ba = a;
      for (const da of st.steer) {
        const na = a + da;
        const nx = x + Math.cos(na) * STEP;
        const ny = y + Math.sin(na) * STEP;
        if (wet(nx, ny)) continue;
        const g = Math.abs(zAt(nx, ny) - z) / STEP;
        let cost = (g / GRADE) ** 2 + 0.6 * Math.abs(angDiff(na, want)) + 0.15 * Math.abs(da);
        if (g > HARD * GRADE) cost += 50;
        if (cost < best) {
          best = cost;
          ba = na;
        }
      }
      if (best >= 50) {
        stop = 'terrain';
        break;
      }
      a = ba;
      let nx = x + Math.cos(a) * STEP;
      let ny = y + Math.sin(a) * STEP;
      if (Math.hypot(nx - cx, ny - cy) > reach) {
        stop = 'reach';
        break;
      }
      // Streams: one small one may be bridged.
      const A = areaAt(nx, ny);
      if (A > STREAM_A) {
        if (A > RIVER_A || bridged) {
          stop = 'stream';
          break;
        }
        bridged = true;
      }
      // Running into the network: join where it crosses, or where it comes within reach ahead.
      const hit =
        crossing(x, y, nx, ny, home) ??
        (() => {
          const n = nearest(nx, ny, SNAP, home);
          if (!n) return null;
          const ahead = Math.cos(Math.atan2(n.y - y, n.x - x) - a);
          return ahead > 0.35 ? n : null;
        })();
      if (hit) {
        const [hx, hy] = dirAt(hit.li, hit.k);
        const inc = Math.atan2(hit.y - y, hit.x - x);
        const ang = Math.abs(angDiff(inc, Math.atan2(hy, hx)));
        if (Math.min(ang, Math.PI - ang) < MIN_ANGLE) {
          failed = 'angle';
          break;
        }
        // Back onto the parent itself only if the loop is worth it.
        if (!other(hit.li) && Math.abs(hit.s - c.s) < 2.5 * (len + STEP)) {
          failed = 'short loop';
          break;
        }
        nx = hit.x;
        ny = hit.y;
        xs.push(nx);
        ys.push(ny);
        len += Math.hypot(nx - x, ny - y);
        joined = true;
        break;
      }
      // Alongside another street without meeting it: stop short.
      if (nearest(nx, ny, GAP, home)) {
        stop = 'alongside';
        break;
      }
      xs.push(nx);
      ys.push(ny);
      len += STEP;
    }
    if (failed) {
      no(failed);
      continue;
    }
    if (joined ? len < 25 : len < 40) {
      no(joined ? 'short join' : `short (${stop})`);
      // Another go later, heading elsewhere.
      if (c.tries < RETRIES) push({ ...c, prio: c.prio + 40, tries: c.tries + 1 });
      continue;
    }
    if (!joined && rand() > st.deadEnd) {
      no('dead end dropped');
      continue;
    }
    no(joined ? 'JOINED' : `DEAD END (${stop})`);
    const li = addLine(xs, ys, false, parent.road ? 1 : parent.gen + 1, st);
    streets.push({ li, cls: joined || st.cls === STREET ? st.cls : LANE });
    built += len;
    offer(li);
  }

  // --- Output ------------------------------------------------------------------
  const out: Street[] = streets.map(({ li, cls }) => {
    const L = lines[li];
    const xy = new Float32Array(2 * L.xs.length);
    for (let i = 0; i < L.xs.length; i++) {
      xy[2 * i] = L.xs[i];
      xy[2 * i + 1] = L.ys[i];
    }
    return { cls, xy };
  });
  // Frontage: every street, and road stretches near streets or the core.
  const frontage: { depth: number; xy: Float32Array }[] = [];
  // (Own copies: a plan's buffers are transferred from the worker, each once.)
  streets.forEach(({ li }, i) => frontage.push({ depth: lines[li].style!.depth, xy: out[i].xy.slice() }));
  const streetNear = (x: number, y: number) => nearest(x, y, 70, (li) => lines[li].road);
  for (const L of lines) {
    if (!L.road) continue;
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 4) frontage.push({ depth: organic.depth, xy: Float32Array.from(run) });
      run = [];
    };
    for (let i = 0; i < L.xs.length; i++) {
      const x = L.xs[i];
      const y = L.ys[i];
      const d = Math.hypot(x - cx, y - cy);
      if (d < reach && (d < core * 0.8 || streetNear(x, y))) run.push(x, y);
      else flush();
    }
    flush();
  }
  return { id: site.id, rank, x: cx, y: cy, streets: out, roads: [], frontage };
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = hash1(h ^ s.charCodeAt(i));
  return hash3(h, 0x7e57, 0x51e5);
}
