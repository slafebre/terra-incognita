import { hash1, hash3, rng } from '../lib/hash';
import { lerp, smoothstep } from '../lib/noise';
import { placeBuildings, type Way } from './buildings';
import { NODE } from './hydro';
import { nearestVertex, vertexPos } from './lattice';
import { ROAD_C, ROAD_P, ROAD_T, type RoadPatch, type SegmentPath } from './roads';
import { HAMLET, TOWN, VILLAGE, type Rank, type Site } from './settle';

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
 * Hamlets get the same treatment in miniature: built-up land along their main road
 * only, or one or two short residential streets off it.
 *
 * Output: the streets, the built-up frontage along streets and roads, and the
 * centre (the crossroads the roads meet at, where a village's or town's church
 * stands).
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
  /** Keys of the network's segments the plan redraws (or drops): chunks draw `roads` instead. */
  replaced: string[];
  /** The plan's road pieces (a redrawn segment may become several, keeping its key, or none). */
  roads: SegmentPath[];
  /** Built-up land: a strip `depth` m each side of each polyline. */
  frontage: { depth: number; xy: Float32Array }[];
  /** Building footprints: four corners each, [x0, y0, … x3, y3] (world metres). */
  buildings: Float32Array;
}

/** Everything a plan draws lies within this distance of its site (m), per rank. */
export const PLAN_EXTENT = [900, 380, 220];
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
  /** Streets run straight for this long (m), then turn by up to `kink` (rad). */
  run: [number, number];
  kink: number;
  /** Branches leave at least this far from other junctions on their side of the parent (m). */
  block: number;
  /** Streets keep at least this far apart where they don't meet (m). */
  gap: number;
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
/** Back lanes keep at least this far from other streets where they don't meet (m). */
const GAP = 26;
/** Tracks and footpaths become streets along built-up runs at least this long (m). */
const UPGRADE_MIN = 30;
/** Extra rounds of branch points once the first run out. */
const REFILL = 3;
/** Street length per area (m/m²) the old core adds to the budget, per rank: about 30–40 m blocks. */
const OLD_DENSITY = [0.045, 0.035];
/** Buildings keep this far from a road's centre line (m), per class (N, D, C, track, path): half its width and a margin. */
export const ROAD_CLEAR = [6, 5, 4, 2.5, 1.5];
/** …and from a street's (street, lane). */
export const STREET_CLEAR = [3.5, 3];
/** Terraces line the main roads out to this many times the old core's radius. */
const MAIN_DENSE = 1.25;
/** Ground buildings may stand on (m/m, over 8 m), lowland to mountains: mountain villages climb their slopes. */
const BUILD_STEEP = [0.55, 0.8];
/** Hamlets' houses stand further apart. */
const HAMLET_GAPS = 1.8;
/** No building this close to the church at a village's or town's centre (m). */
const CHURCH_CLEAR = 10;
/** Chance per outer plot of a large building (a factory, a store), per rank; on main roads LARGE_MAIN times that; not within LARGE_FROM times the old core's radius. */
const LARGE_CHANCE = [0.07, 0.025, 0];
const LARGE_MAIN = 2.5;
const LARGE_FROM = 1.3;
/** Attempts per branch point. */
const RETRIES = 2;
/** Junction angles below this are refused (rad). */
const MIN_ANGLE = (38 * Math.PI) / 180;
/** Gradient limit for streets (soft, refused above HARD × it): steeper in towns and hill country. */
const GRADE = [0.16, 0.14, 0.14];
const GRADE_HILL = 0.06;
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
  /** A road's class (streets: -1). */
  cls: number;
  gen: number;
  style: Style | null;
  /** Removed after growth (a stub). */
  pruned?: boolean;
}

/** Debugging: why branches ended or were refused, summed over plans. */
export const planStats: Record<string, number> = {};

export function planTown({ site, roads, patch: p }: PlanInput): TownPlan {
  const rank = site.rank;
  if (rank !== TOWN && rank !== VILLAGE && rank !== HAMLET) throw new Error('plans are for hamlets, villages and towns');
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
  const core = (rank === TOWN ? lerp(260, 340, rand()) : rank === VILLAGE ? lerp(140, 200, rand()) : lerp(40, 70, rand())) * size;
  const reach = Math.min(
    extent - 60,
    rank === TOWN ? lerp(650, 850, rand()) * size : rank === VILLAGE ? core * 1.7 : lerp(50, 100, rand()) * size,
  );
  let budget = (rank === TOWN ? lerp(14000, 22000, rand()) : lerp(900, 2000, rand())) * size * size;
  // Character. A village is clustered round its crossroads or strung out along its
  // roads (more often in the mountains, where valleys are narrow). Every settlement
  // leans one way: it grows further and denser there.
  const strung = rank === VILLAGE ? Math.min(1, 0.85 * rand() + 0.4 * mount) : 0;
  const roadStretch = lerp(1, 1.7, strung);
  const lean = rand() * 2 * Math.PI;
  const leanAmt = lerp(0.15, 0.45, rand());
  /**
   * Distance from the centre as the zones see it: shorter towards the lean, and
   * along roads in a strung-out village.
   */
  const zoneDist = (x: number, y: number, road: boolean) =>
    Math.hypot(x - cx, y - cy) / ((1 + leanAmt * Math.cos(Math.atan2(y - cy, x - cx) - lean)) * (road ? roadStretch : 1));
  const hardReach = extent - 30;
  // A hamlet is built up along its main road only, or gets one or two short
  // residential streets off it (fewer in the mountains).
  const lanes = rank === HAMLET ? (rand() < lerp(0.5, 0.25, mount) ? (rand() < 0.4 ? 2 : 1) : 0) : Infinity;
  if (rank === HAMLET) budget = 130 * lanes;
  const grade = GRADE[rank] + GRADE_HILL * smoothstep(0.2, 0.7, R);

  const organic: Style = {
    spacing: rank === TOWN ? 55 : 70,
    density: rank === TOWN ? 0.9 : 0.75,
    len: rank === TOWN ? [50, 160] : [50, 200],
    jitter: rank === TOWN ? 0.35 : 0.6,
    steer: [-1, -0.5, -0.25, 0, 0.25, 0.5, 1],
    run: [25, 80],
    kink: 0.5,
    block: 42,
    gap: 26,
    ring: rank === TOWN ? 0.25 : 0.08,
    gens: rank === TOWN ? 4 : strung > 0.6 ? 1 : 2,
    deadEnd: rank === TOWN ? 0.55 : 0.6,
    depth: rank === TOWN ? 24 : 22,
    cls: STREET,
  };
  const suburb: Style = {
    spacing: lerp(80, 105, rand()),
    density: 0.8,
    len: [90, 260],
    jitter: 0.05,
    steer: [-0.6, -0.15, 0, 0.15, 0.6],
    run: [60, 160],
    kink: 0.25,
    block: 42,
    gap: 26,
    ring: 0,
    gens: 3,
    deadEnd: 0.5,
    depth: 20,
    cls: STREET,
  };
  const outer: Style = { ...organic, density: 0.35, ring: 0.15, gens: 1, deadEnd: 0.8, depth: 18, cls: LANE };
  const lane: Style = { ...organic, spacing: 40, density: 1, len: [40, 110], jitter: 0.4, ring: 0, gens: 1, deadEnd: 1, depth: 18 };
  // The old core round the crossroads: a tight mesh of short, crooked streets and
  // small blocks, most of them meeting others rather than ending.
  const oldCore = core * (rank === TOWN ? lerp(0.6, 0.75, rand()) : lerp(0.4, 0.55, rand()));
  const old: Style = {
    spacing: rank === TOWN ? 30 : 34,
    density: 1,
    len: [25, 90],
    jitter: 0.35,
    steer: [-1, -0.5, -0.25, 0, 0.25, 0.5, 1],
    run: [12, 40],
    kink: 0.6,
    block: 24,
    gap: 17,
    ring: 0,
    gens: 5,
    deadEnd: 0.25,
    depth: rank === TOWN ? 20 : 18,
    cls: STREET,
  };
  if (rank !== HAMLET) budget += OLD_DENSITY[rank] * Math.PI * oldCore * oldCore;
  const styleAt = (d: number): Style | null =>
    rank === HAMLET
      ? d < reach
        ? lane
        : null
      : d < oldCore
        ? old
        : d < core
          ? organic
          : d < reach
            ? rank === TOWN
              ? suburb
              : outer
            : null;

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
  const addLine = (xs: number[], ys: number[], road: boolean, gen: number, style: Style | null, cls = -1) => {
    const s = [0];
    for (let i = 1; i < xs.length; i++) s.push(s[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
    const li = lines.push({ xs, ys, s, road, cls, gen, style }) - 1;
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

  // --- The crossroads: a square, a green or a spindle ----------------------------
  // The roads ending at the centre are cut back and joined by short links round it,
  // each leaving its road at an angle and bulging outward: three or more roads make
  // a triangular green or a small square (a market square in a town), a road passing
  // straight through may part round a long green (an Anger). The cut roads keep
  // their keys and replace the network's; their far ends don't move.
  const redrawn: SegmentPath[] = [];
  let net = sorted;
  {
    const at = sorted.filter((r) => {
      const n = r.xy.length;
      return r.cls <= ROAD_C && (Math.hypot(r.xy[0] - cx, r.xy[1] - cy) < 1 || Math.hypot(r.xy[n - 2] - cx, r.xy[n - 1] - cy) < 1);
    });
    const slope = Math.hypot(zAt(cx + 16, cy) - zAt(cx - 16, cy), zAt(cx, cy + 16) - zAt(cx, cy - 16)) / 32;
    const deg = at.length;
    const r =
      rank === TOWN ? lerp(30, 45, rand()) * Math.sqrt(size) : deg >= 3 ? lerp(24, 34, rand()) : lerp(35, 60, rand());
    const chance = rank === HAMLET ? 0 : rank === TOWN ? 1 : deg >= 3 ? 0.8 : deg === 2 ? lerp(0.4, 0.1, mount) : 0;
    if (deg >= 2 && slope < 0.1 && rand() < chance) {
      // Each road from the centre, cut at r: [kept polyline (outward), cut point, outward direction].
      const cuts: { r: SegmentPath; xs: number[]; ys: number[]; ux: number; uy: number; a: number }[] = [];
      for (const road of at) {
        const n = road.xy.length / 2;
        const fromStart = Math.hypot(road.xy[0] - cx, road.xy[1] - cy) < 1;
        const px: number[] = [];
        const py: number[] = [];
        for (let i = 0; i < n; i++) {
          const k = fromStart ? i : n - 1 - i;
          px.push(road.xy[2 * k]);
          py.push(road.xy[2 * k + 1]);
        }
        // First point at distance r from the centre (the road leaves it).
        let i = 1;
        while (i < n && Math.hypot(px[i] - cx, py[i] - cy) < r) i++;
        if (i >= n - 2) break;
        const d0 = Math.hypot(px[i - 1] - cx, py[i - 1] - cy);
        const d1 = Math.hypot(px[i] - cx, py[i] - cy);
        const t = (r - d0) / (d1 - d0 || 1);
        const qx = px[i - 1] + t * (px[i] - px[i - 1]);
        const qy = py[i - 1] + t * (py[i] - py[i - 1]);
        const xs = [qx, ...px.slice(i)];
        const ys = [qy, ...py.slice(i)];
        // Outward direction: over the first 20 m beyond the cut.
        let j = 1;
        while (j < xs.length - 1 && Math.hypot(xs[j] - qx, ys[j] - qy) < 20) j++;
        const ux = xs[j] - qx;
        const uy = ys[j] - qy;
        const ul = Math.hypot(ux, uy) || 1;
        cuts.push({ r: road, xs, ys, ux: ux / ul, uy: uy / ul, a: Math.atan2(qy - cy, qx - cx) });
      }
      cuts.sort((p1, p2) => p1.a - p2.a);
      // Links between neighbouring cuts round the centre.
      const links: SegmentPath[] = [];
      let ok = cuts.length === deg;
      // Squares and greens: nearly straight sides (a rounded triangle or square, not a
      // ring); spindles: a narrow parting.
      const angle = deg >= 3 || rank === TOWN ? (62 * Math.PI) / 180 : (35 * Math.PI) / 180;
      const pull = deg >= 3 || rank === TOWN ? 0.3 : 0.5;
      for (let i = 0; ok && i < deg; i++) {
        const A = cuts[i];
        const B = cuts[(i + 1) % deg];
        let gap = B.a - A.a;
        if (gap <= 0) gap += 2 * Math.PI;
        if (gap > (200 * Math.PI) / 180 && deg >= 3) continue; // open on that side
        if (deg === 2 && Math.abs(gap - Math.PI) > (40 * Math.PI) / 180) ok = false; // a spindle needs a road passing straight through
        const ax = A.xs[0];
        const ay = A.ys[0];
        const bx = B.xs[0];
        const by = B.ys[0];
        // Leaving each road inward, turned towards the other by `angle`.
        const dir = (C: typeof A, ox: number, oy: number): [number, number] => {
          const side = -C.uy * (ox - C.xs[0]) + C.ux * (oy - C.ys[0]) > 0 ? 1 : -1;
          const nx = -C.uy * side;
          const ny = C.ux * side;
          return [-C.ux * Math.cos(angle) + nx * Math.sin(angle), -C.uy * Math.cos(angle) + ny * Math.sin(angle)];
        };
        const [tax, tay] = dir(A, bx, by);
        const [tbx, tby] = dir(B, ax, ay);
        const d = Math.hypot(bx - ax, by - ay);
        const k = pull * Math.max(d, r);
        const m = Math.max(4, Math.ceil((1.4 * Math.max(d, r)) / 8));
        const xy: number[] = [];
        for (let q = 0; q <= m; q++) {
          const u = q / m;
          const b0 = (1 - u) ** 3;
          const b1 = 3 * u * (1 - u) ** 2;
          const b2 = 3 * u * u * (1 - u);
          const b3 = u ** 3;
          const x = b0 * ax + b1 * (ax + tax * k) + b2 * (bx + tbx * k) + b3 * bx;
          const y = b0 * ay + b1 * (ay + tay * k) + b2 * (by + tby * k) + b3 * by;
          if (wet(x, y)) ok = false;
          xy.push(x, y);
        }
        // A link carries the lesser of its two roads: the through road keeps its class along its side.
        links.push({ key: `${site.id}#sq${i}`, cls: Math.max(A.r.cls, B.r.cls) as SegmentPath['cls'], xy: Float32Array.from(xy) });
      }
      if (ok && links.length) {
        const cutKeys = new Set(cuts.map((c) => c.r.key));
        for (const c of cuts) {
          const xy = new Float32Array(2 * c.xs.length);
          for (let i = 0; i < c.xs.length; i++) {
            xy[2 * i] = c.xs[i];
            xy[2 * i + 1] = c.ys[i];
          }
          redrawn.push({ key: c.r.key, cls: c.r.cls, xy, micro: c.r.micro });
        }
        redrawn.push(...links);
        net = [...sorted.filter((q) => !cutKeys.has(q.key)), ...redrawn].sort((p1, p2) => (p1.key < p2.key ? -1 : p1.key > p2.key ? 1 : 0));
      }
    }
  }

  // Roads seed the network, segments chained into whole roads where two meet end
  // to end (shared vertices are bit-identical), so a road reads as one line.
  {
    const ends = new Map<string, number[]>();
    const ek = (r: SegmentPath, end: number) => `${r.xy[end]},${r.xy[end + 1]}`;
    net.forEach((r, i) => {
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
    net.forEach((r, i) => {
      if (used.has(i)) return;
      used.add(i);
      let chain = pts(r, false);
      // Extend forwards from the end, then backwards from the start.
      for (const back of [false, true]) {
        let cur = i;
        for (;;) {
          const [x, y] = back ? chain[0] : chain[chain.length - 1];
          const j = next(`${x},${y}`, cur);
          if (j < 0 || used.has(j) || net[j].cls !== r.cls) break;
          used.add(j);
          const q = net[j];
          const fwd = q.xy[0] === x && q.xy[1] === y;
          const more = pts(q, back ? fwd : !fwd);
          chain = back ? [...more.slice(0, -1), ...chain] : [...chain, ...more.slice(1)];
          cur = j;
        }
      }
      addLine(chain.map((c) => c[0]), chain.map((c) => c[1]), true, 0, null, r.cls);
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
        const d = zoneDist(x, y, L.road);
        const st = Math.hypot(x - cx, y - cy) < hardReach ? styleAt(d) : null;
        if (!st) {
          s += 30;
          continue;
        }
        const fall = 1 - 0.6 * smoothstep(0, reach, d);
        if (rand() < st.density * fall) push({ li, s, side, prio: d * (0.75 + 0.5 * rand()) + 60 * L.gen, tries: 0 });
        s += st.spacing * (0.6 + 0.8 * rand());
      }
    }
  };
  let built = 0;
  /** Streets grown: the line they start on (parent) and the one they end on (target, -1 for a dead end; -2 for both of a back lane). */
  const streets: { li: number; cls: StreetClass; parent: number; target: number; stop: string; len: number }[] = [];
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
      if (Math.abs(zAt(xs[i], ys[i]) - zAt(xs[i - 1], ys[i - 1])) > HARD * grade * L) steep++;
      if (crossing(xs[i - 1], ys[i - 1], xs[i], ys[i], nearEnd)) return no('link: crosses'), false;
      if (i < n - 1 && nearest(xs[i], ys[i], GAP, nearEnd)) return no('link: alongside'), false;
    }
    if (steep > 1) return no('link: steep'), false;
    let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    const li = addLine(xs, ys, false, gen, st);
    streets.push({ li, cls: st.cls, parent: -2, target: -2, stop: 'link', len });
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
      const rA = r * (0.65 + 0.6 * rand());
      const rB = r * (0.65 + 0.6 * rand());
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
      const k = (gap > 2.4 ? lerp(0.4, 0.65, rand()) : lerp(0.25, 0.5, rand())) * d;
      // Uneven: a slow sideways sway along the lane (no two plots alike).
      const w1 = lerp(-0.12, 0.18, rand()) * d;
      const w2 = lerp(-0.1, 0.1, rand()) * d;
      const ox = -(by - ay) / d;
      const oy = (bx - ax) / d;
      const xs: number[] = [];
      const ys: number[] = [];
      const steps = Math.max(4, Math.ceil((1.3 * d) / STEP));
      for (let j = 0; j <= steps; j++) {
        const u = j / steps;
        const b0 = (1 - u) ** 3;
        const b1 = 3 * u * (1 - u) ** 2;
        const b2 = 3 * u * u * (1 - u);
        const b3 = u ** 3;
        const sway = w1 * Math.sin(Math.PI * u) + w2 * Math.sin(2 * Math.PI * u);
        xs.push(b0 * ax + b1 * (ax + nax * k) + b2 * (bx + nbx * k) + b3 * bx + ox * sway);
        ys.push(b0 * ay + b1 * (ay + nay * k) + b2 * (by + nby * k) + b3 * by + oy * sway);
      }
      // Crooked, like the streets: straight runs between a few points of the curve.
      const kinks = steps >= 10 ? 3 : 2;
      const at = [0];
      for (let q = 1; q < kinks; q++) at.push(Math.round(((q + (rand() - 0.5) * 0.4) / kinks) * steps));
      at.push(steps);
      const px: number[] = [];
      const py: number[] = [];
      for (let q = 1; q < at.length; q++) {
        const [x0, y0, x1, y1] = [xs[at[q - 1]], ys[at[q - 1]], xs[at[q]], ys[at[q]]];
        const m = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / STEP));
        for (let t = q === 1 ? 0 : 1; t <= m; t++) {
          px.push(x0 + ((x1 - x0) * t) / m);
          py.push(y0 + ((y1 - y0) * t) / m);
        }
      }
      tryStreet(px, py, st, 1);
    }
  };
  if (rank === TOWN) {
    ring(core, 0.9, { ...organic, cls: STREET });
    ring(core * 0.55, 0.6, organic);
  } else if (rank === VILLAGE) {
    ring(core * lerp(0.5, 0.85, rand()), lerp(0.8, 0.25, strung), organic);
  }

  for (let li = 0; li < lines.length; li++) offer(li);

  let rounds = 0;
  while (built < budget && streets.length < lanes) {
    // Out of branch points with budget left: offer every street again, at fresh
    // places (towns fill in their blocks this way).
    if (!heap.length) {
      if (rounds++ >= REFILL) break;
      for (let li = 0; li < lines.length; li++) offer(li);
      if (!heap.length) break;
    }
    const c = pop();
    const parent = lines[c.li];
    const P = pointAt(c.li, c.s);
    const d0 = Math.hypot(P.x - cx, P.y - cy);
    const st = styleAt(zoneDist(P.x, P.y, parent.road));
    if (!st) {
      no('outside');
      continue;
    }
    if (!parent.road && parent.gen >= st.gens) {
      no('gens');
      continue;
    }
    // Not off a bridge.
    if (wet(P.x, P.y)) {
      no('bridge');
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
    if (nearest(P.x, P.y, st.block, (li, _s, x, y) => li === c.li || (x - P.x) * nx0 + (y - P.y) * ny0 < 1)) {
      no('junction');
      continue;
    }
    let a = Math.atan2(ny0, nx0) + (rand() * 2 - 1) * st.jitter;
    // Room ahead.
    const ahead0 = Math.min(22, st.gap + 6);
    if (nearest(P.x + Math.cos(a) * ahead0, P.y + Math.sin(a) * ahead0, st.gap * 0.8, (li) => li === c.li)) {
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
    let target = -1;
    let bridged = false;
    let failed = '';
    let stop = 'length';
    // Streets run straight, then turn at a kink: crooked, not smoothly curving.
    let base = a;
    let runLeft = lerp(st.run[0], st.run[1], rand());
    while (len < maxLen) {
      if (runLeft <= 0) {
        base += (rand() < 0.5 ? -1 : 1) * st.kink * (0.3 + 0.7 * rand());
        runLeft = lerp(st.run[0], st.run[1], rand());
      }
      runLeft -= STEP;
      const x = xs[xs.length - 1];
      const y = ys[ys.length - 1];
      const z = zAt(x, y);
      // Desired heading: straight on (to the next kink), or round the centre for a back lane.
      let want = base;
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
        let cost = (g / grade) ** 2 + 0.6 * Math.abs(angDiff(na, want)) + 0.15 * Math.abs(da);
        if (g > HARD * grade) cost += 50;
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
      if (zoneDist(nx, ny, false) > reach || Math.hypot(nx - cx, ny - cy) > hardReach) {
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
        target = hit.li;
        break;
      }
      // Alongside another street without meeting it: stop short.
      if (nearest(nx, ny, st.gap, home)) {
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
    streets.push({ li, cls: joined || st.cls === STREET ? st.cls : LANE, parent: c.li, target, stop, len });
    built += len;
    offer(li);
  }

  // --- Pruning -----------------------------------------------------------------
  // Short dead ends nothing hangs off read as clutter, and hill towns grow many (the
  // slopes stop them early); in towns, so do stubs that stopped alongside another
  // street. Leaves go first, repeatedly, as their parents may become leaves in turn.
  const hilly = smoothstep(0.2, 0.7, R);
  const stub = rank === TOWN ? lerp(60, 130, hilly) : rank === VILLAGE ? lerp(40, 60, hilly) : 35;
  const alive = streets.map(() => true);
  for (let changed = true; changed; ) {
    changed = false;
    const hangers = new Map<number, number>();
    streets.forEach((q, i) => {
      if (!alive[i]) return;
      hangers.set(q.parent, (hangers.get(q.parent) ?? 0) + 1);
      if (q.target >= 0) hangers.set(q.target, (hangers.get(q.target) ?? 0) + 1);
    });
    streets.forEach((q, i) => {
      if (!alive[i] || q.target !== -1 || hangers.get(q.li)) return;
      if (q.len < stub || (rank === TOWN && q.stop === 'alongside' && q.len < 2 * stub)) {
        alive[i] = false;
        lines[q.li].pruned = true;
        changed = true;
        no('PRUNED');
      }
    });
  }
  const kept = streets.filter((_, i) => alive[i]);

  // --- Output ------------------------------------------------------------------
  const out: Street[] = kept.map(({ li, cls }) => {
    const L = lines[li];
    const xy = new Float32Array(2 * L.xs.length);
    for (let i = 0; i < L.xs.length; i++) {
      xy[2 * i] = L.xs[i];
      xy[2 * i + 1] = L.ys[i];
    }
    return { cls, xy };
  });
  const upgraded: Street[] = [];
  // Built-up land: along every street, and along roads near streets or the core.
  const streetNear = (x: number, y: number) => nearest(x, y, 70, (li) => lines[li].road || !!lines[li].pruned);
  /** A hamlet's main road: the roads proper (not tracks or paths) through it. */
  const mainRoad = (li: number) => lines[li].road && lines[li].cls <= ROAD_C;
  const builtAt = (x: number, y: number, track = false) => {
    const d = zoneDist(x, y, true);
    if (d >= reach || Math.hypot(x - cx, y - cy) >= hardReach || wet(x, y)) return false;
    // A hamlet is built up only along its main road and its own streets; a track is
    // only taken in where it runs along the main road.
    if (rank === HAMLET)
      return !!nearest(x, y, 12, (li) => !mainRoad(li)) || (!track && !!nearest(x, y, 25, (li) => lines[li].road || !!lines[li].pruned));
    return d < core * 0.8 || !!streetNear(x, y);
  };

  // Tracks and footpaths through built-up land are residential streets there: the
  // plan redraws those segments, built-up runs as streets and the rest as before.
  const inputKeys = new Set(sorted.map((q) => q.key));
  const replaced = new Set(redrawn.filter((q) => inputKeys.has(q.key)).map((q) => q.key));
  const roadsOut = [...redrawn];
  for (const q of net) {
    if (q.cls !== ROAD_T && q.cls !== ROAD_P) continue;
    const n = q.xy.length / 2;
    const inside: boolean[] = [];
    for (let i = 0; i < n; i++) inside.push(builtAt(q.xy[2 * i], q.xy[2 * i + 1], true));
    // Built-up runs shorter than UPGRADE_MIN stay tracks (a corner clipped at the edge).
    for (let i = 0; i < n; ) {
      if (!inside[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && inside[j + 1]) j++;
      let len = 0;
      for (let k = i + 1; k <= j; k++) len += Math.hypot(q.xy[2 * k] - q.xy[2 * k - 2], q.xy[2 * k + 1] - q.xy[2 * k - 1]);
      if (len < UPGRADE_MIN) for (let k = i; k <= j; k++) inside[k] = false;
      i = j + 1;
    }
    if (!inside.some(Boolean)) continue;
    replaced.add(q.key);
    // Split into runs sharing their boundary points, so the pieces still meet.
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && inside[i] === inside[start]) continue;
      const end = Math.min(i, n - 1);
      const xy = q.xy.slice(2 * start, 2 * end + 2);
      if (xy.length >= 4) {
        if (inside[start]) upgraded.push({ cls: STREET, xy }), no(`UPGRADED ${q.cls === ROAD_T ? "track" : "path"}`);
        else roadsOut.push({ key: q.key, cls: q.cls, xy });
      }
      start = end;
    }
  }

  const frontage: { depth: number; xy: Float32Array }[] = [];
  /**
   * The same, in the order they were built up: the main roads first (their rows came
   * first, and claim the corners), then the streets off them, generation by
   * generation, then tracks taken in; each centre outward.
   */
  const fronts: { xy: Float32Array; main: boolean; order: number }[] = [];
  // (Own copies: a plan's buffers are transferred from the worker, each once.)
  kept.forEach(({ li }, i) => {
    frontage.push({ depth: lines[li].style!.depth, xy: out[i].xy.slice() });
    fronts.push({ xy: out[i].xy, main: false, order: 1 + lines[li].gen });
  });
  const roadDepth = rank === HAMLET ? lane.depth : organic.depth;
  for (const u of upgraded) {
    frontage.push({ depth: roadDepth, xy: u.xy.slice() });
    fronts.push({ xy: u.xy, main: false, order: 10 });
  }
  for (const L of lines) {
    if (!L.road || (rank === HAMLET && L.cls > ROAD_C)) continue;
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 4) {
        const xy = Float32Array.from(run);
        frontage.push({ depth: roadDepth, xy });
        fronts.push({ xy, main: L.cls <= ROAD_C, order: L.cls <= ROAD_C ? 0 : 10 });
      }
      run = [];
    };
    for (let i = 0; i < L.xs.length; i++) {
      if (builtAt(L.xs[i], L.ys[i])) run.push(L.xs[i], L.ys[i]);
      else flush();
    }
    flush();
  }
  // --- Buildings -----------------------------------------------------------------
  const allStreets = [...out, ...upgraded];
  const ways: Way[] = [
    ...sorted.filter((q) => !replaced.has(q.key)).map((q) => ({ xy: q.xy, clear: ROAD_CLEAR[q.cls] })),
    ...roadsOut.map((q) => ({ xy: q.xy, clear: ROAD_CLEAR[q.cls] })),
    ...allStreets.map((q) => ({ xy: q.xy, clear: STREET_CLEAR[q.cls] })),
  ];
  const mid = (xy: Float32Array) => {
    const k = 2 * Math.floor(xy.length / 4);
    return Math.hypot(xy[k] - cx, xy[k + 1] - cy);
  };
  const buildings = placeBuildings({
    fronts: fronts.sort((a, b) => a.order - b.order || mid(a.xy) - mid(b.xy)),
    ways,
    // Main roads keep their terraces a little further out (the faubourgs).
    dense: (x, y, main) => rank !== HAMLET && zoneDist(x, y, main) < oldCore * (main ? MAIN_DENSE : 1),
    ok: (x, y, steep) => {
      const r = Math.hypot(x - cx, y - cy);
      if (wet(x, y)) return no('ground: lake'), false;
      if (areaAt(x, y) > STREAM_A) return no('ground: stream'), false;
      if (r > extent - 5) return no('ground: extent'), false;
      if (rank !== HAMLET && r < CHURCH_CLEAR) return no('ground: church'), false;
      const g = Math.hypot(zAt(x + 4, y) - zAt(x - 4, y), zAt(x, y + 4) - zAt(x, y - 4)) / 8;
      if (g >= steep) return no('ground: steep'), false;
      return true;
    },
    // Factories and stores: in the outer parts only, mostly on the main roads and in towns.
    large: (x, y, main) => (zoneDist(x, y, main) < oldCore * LARGE_FROM ? 0 : LARGE_CHANCE[rank] * (main ? LARGE_MAIN : 1)),
    rand,
    gapScale: rank === HAMLET ? HAMLET_GAPS : 1,
    steep: lerp(BUILD_STEEP[0], BUILD_STEEP[1], mount),
  });

  return {
    id: site.id,
    rank,
    x: cx,
    y: cy,
    streets: allStreets,
    replaced: [...replaced],
    // (Copies: transferred separately from the inputs.)
    roads: roadsOut.map((q) => ({ ...q, xy: q.xy.slice() })),
    frontage,
    buildings,
  };
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
