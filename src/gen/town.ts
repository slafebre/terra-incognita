import { hash1, hash3, rng } from '../lib/hash';
import { MinHeap } from '../lib/heap';
import { lerp, smoothstep } from '../lib/noise';
import { placeBuildings, quadsOverlap, segPointDist, segQuadDist, wayClearance, type Way } from './buildings';
import { NODE } from './hydro';
import { lineDistance, MW_BUILD_CLEAR, MW_PLAN_CLEAR } from './motorway';
import { RESERVOIR, TOWER, type Poi } from './poi';
import { nearestVertex, vertexPos } from './lattice';
import { outsideCircle, ROAD_C, ROAD_D, ROAD_P, ROAD_T, ringDisc, ringLine, type RoadPatch, type SegmentPath } from './roads';
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
 * Towns get a small industrial estate (now and then two) where there is flat, dry
 * ground at their edge beside a main road: an access street leaving the road, and
 * side streets off it, kept straight but bending to stay on the flat, ending where
 * it ends (now and then in a turning loop) or meeting each other. Sheds and halls
 * line them, so the estate's outline follows the flat land. The town grows round it.
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
  /** One per building: 1 for an industrial one (a shed, a hall). */
  industrial: Uint8Array;
  /** Its points of interest (a water tower, a reservoir). */
  pois: Poi[];
  /** Its churches: the middles of their footprints (among `buildings`), where the symbol goes. */
  churches: { x: number; y: number }[];
  /** Its squares: open, paved places, as polygons [x0, y0, …] (the streets round them on their edges). */
  squares: Float32Array[];
}

/** Everything a plan draws lies within this distance of its site (m), per rank (farms: farm.ts). */
export const PLAN_EXTENT = [900, 380, 220, 300];
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
export const BUILD_STEEP = [0.55, 0.8];
/** Hamlets' houses stand further apart. */
const HAMLET_GAPS = 1.8;
/** Towns, and villages whose core is wider than this (m), are large: D-road links round the core, more squares and churches. */
const BIG_VILLAGE = 160;
/**
 * D-road links (a tiered network): between neighbouring N and D roads (and C roads,
 * where fewer than three N and D roads leave the centre) LINK_GAP rad apart, round
 * the core at LINK_R × its radius (across a wide gap, an arc of an inner ring road); at most
 * LINK_MAX per (town, large village), each with LINK_CHANCE. Steeper than LINK_GRADE
 * (m/m) at more than one step, refused.
 */
const LINK_R = [
  [0.5, 0.8],
  [0.6, 0.9],
];
const LINK_GAP = [(50 * Math.PI) / 180, (215 * Math.PI) / 180];
const LINK_MAX = [3, 1];
const LINK_CHANCE = [0.7, 0.6];
const LINK_GRADE = 0.16;
/** Radii a link is tried at, as fractions of its first (routed over the ground only at the first two). */
const LINK_TRY = [1, 0.8, 1.25, 0.65, 1.5];
/** A routed link stays within LINK_BAND × its radius of the centre, costs length × (1 + (grade / LINK_ROUTE_GRADE)²) and LINK_BRIDGE m more per river node. */
const LINK_BAND = [0.4, 1.7];
const LINK_ROUTE_GRADE = 0.07;
const LINK_BRIDGE = 150;
/**
 * Squares: chance per (town, large village, village); beside a main road SQUARE_D
 * m from the centre (towns × SQUARE_TOWN), W × D m (along × back from the road; towns
 * × SQUARE_TOWN), framed by streets on its other three sides; flat (under
 * SQUARE_STEEP m/m) and dry.
 */
const SQUARE_CHANCE = [0.6, 0.6, 0.4];
const SQUARE_D = [30, 110];
const SQUARE_W = [28, 44];
const SQUARE_DEPTH = [22, 34];
const SQUARE_TOWN = 1.3;
const SQUARE_STEEP = 0.12;
/**
 * Churches: a nave W × D m (the first in a town larger); further ones in villages
 * whose streets reach CHURCH2_BUILT m (with CHURCH2_CHANCE), in towns 2–4 by their
 * streets; each at least CHURCH_APART m (village, town) from the others and within
 * CHURCH_REACH × the core's radius. Set back CHURCH_SETBACK m from the way it faces,
 * on ground under CHURCH_STEEP m/m; oriented east–west (± CHURCH_TURN rad) where it
 * can be, else square to the way.
 */
const CHURCH_W = [
  [32, 44],
  [20, 28],
];
const CHURCH_D = [
  [14, 18],
  [9, 12],
];
const CHURCH2_W = [18, 26];
const CHURCH2_D = [9, 12];
const CHURCH2_BUILT = 2200;
const CHURCH2_CHANCE = 0.7;
const CHURCH_APART = [180, 260];
const CHURCH_REACH = [1.3, 1.2];
const CHURCH_SETBACK = 2;
const CHURCH_STEEP = 0.35;
const CHURCH_TURN = 0.18;
/** Water towers: chance per (town, village), on the highest free ground from the old core out to the reach, TOWER_CLEAR m from ways and buildings and within TOWER_ACCESS m of a way. In the mountains (from R = TOWER_MOUNTAIN), a reservoir uphill instead, with RESERVOIR_CHANCE. */
const TOWER_CHANCE = [1, 0.75];
const TOWER_MOUNTAIN = 0.52;
const RESERVOIR_CHANCE = 0.6;
const TOWER_CLEAR = 15;
const TOWER_ACCESS = 100;
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
export const STREAM_A = 0.15;
/** Industrial estates (towns) stand on flat ground only: dry, no stream, and no node's neighbours further than IND_FLAT apart in height per metre (across 32 m). */
const IND_FLAT = 0.06;
/** An estate wants at least IND_AREA m² of flat ground within IND_R m of its junction, on its side of the road (sampled every IND_SAMPLE m), and its streets stay within IND_R of it. */
const IND_R = 260;
const IND_AREA = 30000;
const IND_SAMPLE = 24;
/** Street length per estate (m); its access street's length; branches every IND_SPACING m along a street (on each side with IND_BRANCH_CHANCE), and their length. */
const IND_BUDGET = [450, 1000];
const IND_ACCESS = [160, 340];
const IND_SPACING = [55, 95];
const IND_BRANCH_CHANCE = 0.6;
const IND_BRANCH = [50, 190];
/** Generations of branches off branches. */
const IND_GENS = 2;
/** Estate streets keep this far apart where they don't meet (m): blocks deep enough for sheds. */
const IND_GAP = 42;
/** An estate street's heading drifts by up to this much per step (rad): long, gentle curves. */
const IND_DRIFT = 0.025;
/** Dead ends at least IND_LOOP_FROM m long end, with IND_LOOP_CHANCE, in a turning loop of radius IND_LOOP m. */
const IND_LOOP_FROM = 60;
const IND_LOOP_CHANCE = 0.5;
const IND_LOOP = 9;
/** Chance of a second estate. */
const IND_SECOND = 0.3;
/** Chance of a roundabout at an estate's gate (where the road is level and no other way meets it there), and its radius (m): small, an access road's. */
const IND_RING = 0.6;
const IND_RING_R = [10, 12];
/** No streets leave a road this close to a roundabout's ring (m). */
const RING_CLEAR = 25;
/** An estate's land: this far either side of its streets, and of its main road along its front (IND_ROAD_FRONT m either way from its junction; m). */
const IND_FRONT = 45;
const IND_ROAD_FRONT = 110;
/** Estates' land is kept as distances on a grid this fine (m). */
const IND_CELL = 8;
/** Houses keep this far out of an estate's land; the town's streets stop this close to its streets (m). */
const IND_KEEP = 8;
const IND_STREET_KEEP = 30;

export interface PlanInput {
  site: Site;
  /** Drawn road segments near the site (any order). */
  roads: SegmentPath[];
  /** Centre lines of the motorways passing through its extent (experimental): kept clear of, as water. */
  motorways?: Float64Array[];
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
  /** A street of an industrial estate. */
  ind?: boolean;
  /** A roundabout's ring. */
  ring?: boolean;
}

/** Debugging: why branches ended or were refused, summed over plans. */
export const planStats: Record<string, number> = {};
/** Debugging: road links tried, as polylines, and whether they were made. */
export const linkTries: { xy: number[]; made: boolean }[] = [];

export function planTown({ site, roads, patch: p, motorways = [] }: PlanInput): TownPlan {
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
  // Motorways count as water: streets stop short of them, nothing is built on them,
  // no street meets a road where it bridges one.
  const mwDist = lineDistance(motorways, MW_PLAN_CLEAR);
  const wet = (x: number, y: number) => {
    const k = node(x, y);
    return k < 0 || !Number.isNaN(p.lake[k]) || mwDist(x, y) < MW_PLAN_CLEAR;
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
  /** Roundabouts: their centres and radii. Streets meet their rings, but don't leave a road beside one. */
  const rings: { x: number; y: number; r: number }[] = [];
  /** Adds a roundabout's ring (closed polyline xy) as a road line of class cls. */
  const addRing = (xy: ArrayLike<number>, cls: number) => {
    const n = xy.length / 2 - 1;
    const [x, y, r] = ringDisc(xy);
    rings.push({ x, y, r });
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= n; i++) {
      xs.push(xy[2 * i]);
      ys.push(xy[2 * i + 1]);
    }
    lines[addLine(xs, ys, true, 0, null, cls)].ring = true;
  };
  const nearRing = (x: number, y: number, m: number) => rings.some((g) => Math.hypot(x - g.x, y - g.y) < g.r + m);
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
      if (r.ring) return;
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
      if (r.ring) {
        addRing(r.xy, r.cls);
        return;
      }
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
    if (L.ind || L.ring) return;
    const total = L.s[L.s.length - 1];
    for (const side of [1, -1]) {
      // Spacing comes from the zone at each point.
      let s = 15 + rand() * 40;
      while (s < total - 15) {
        const { x, y } = pointAt(li, s);
        const d = zoneDist(x, y, L.road);
        const st = Math.hypot(x - cx, y - cy) < hardReach && !nearRing(x, y, RING_CLEAR) ? styleAt(d) : null;
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

  /** Squares: open places (polygons), streets never across them. */
  const squares: Float32Array[] = [];
  const squarePolys: number[][] = [];
  const inConvexAny = (x: number, y: number) => squarePolys.some((q) => inConvex(q, x, y));
  /** Is (x, y) on a square (within m of it)? */
  const onSquare = (x: number, y: number, m: number) =>
    squarePolys.some((q) => {
      if (inConvex(q, x, y)) return true;
      for (let k = 0; k < 8; k += 2) if (segPointDist(q[k], q[k + 1], q[(k + 2) % 8], q[(k + 3) % 8], x, y) < m) return true;
      return false;
    });

  /**
   * Splits the track or path of the network (or the plan's redrawn piece of one)
   * passing through (x, y) there, so a road link crossing it meets it at a junction:
   * both pieces end at the crossing and are drawn by the plan instead.
   */
  const splitMinor = (x: number, y: number) => {
    for (let qi = 0; qi < net.length; qi++) {
      const q = net[qi];
      if (q.cls <= ROAD_C || q.ring) continue;
      for (let k = 2; k < q.xy.length; k += 2) {
        if (segPointDist(q.xy[k - 2], q.xy[k - 1], q.xy[k], q.xy[k + 1], x, y) > 0.5) continue;
        const a = Float32Array.from([...q.xy.subarray(0, k), x, y]);
        const b = Float32Array.from([x, y, ...q.xy.subarray(k)]);
        const pa = { ...q, xy: a };
        const pb = { ...q, xy: b };
        net = [...net.slice(0, qi), pa, pb, ...net.slice(qi + 1)];
        const own = redrawn.indexOf(q);
        if (own >= 0) redrawn.splice(own, 1);
        redrawn.push(pa, pb);
        return;
      }
    }
  };

  /**
   * Checks a proposed street (free of the network except at its two ends) against
   * water, steepness and the network; adds it if fit.
   */
  const tryStreet = (xs: number[], ys: number[], st: Style, gen: number, roadCls = -1, key = ''): boolean => {
    const n = xs.length;
    const limit = roadCls >= 0 ? LINK_GRADE : HARD * grade;
    /** Tracks and paths a road link crosses: split there afterwards (junctions). */
    const crossed: { x: number; y: number }[] = [];
    const minorLine = (li: number) => roadCls >= 0 && lines[li].road && lines[li].cls > ROAD_C && !lines[li].ring;
    const nearEnd = (_li: number, _s: number, x: number, y: number) =>
      Math.hypot(x - xs[0], y - ys[0]) < 30 || Math.hypot(x - xs[n - 1], y - ys[n - 1]) < 30;
    let steep = 0;
    for (let i = 1; i < n; i++) {
      // (A road of the plan's own bridges a river; a street doesn't. Neither crosses a lake.)
      if (wet(xs[i], ys[i]) || (roadCls < 0 && areaAt(xs[i], ys[i]) > RIVER_A)) return no((roadCls >= 0 ? 'dlink: ' : 'link: ') + 'water'), false;
      const L = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
      if (Math.abs(zAt(xs[i], ys[i]) - zAt(xs[i - 1], ys[i - 1])) > limit * L) steep++;
      if (crossing(xs[i - 1], ys[i - 1], xs[i], ys[i], (li, s0, x, y) => nearEnd(li, s0, x, y) || (minorLine(li) && (crossed.push({ x, y }), true))))
        return no((roadCls >= 0 ? 'dlink: ' : 'link: ') + 'crosses'), false;
      // Not into a roundabout, not even at its ends.
      if (nearRing(xs[i], ys[i], 2) || crossing(xs[i - 1], ys[i - 1], xs[i], ys[i], (li) => !lines[li].ring)) return no((roadCls >= 0 ? 'dlink: ' : 'link: ') + 'roundabout'), false;
      // (A road may run beside a track or a path.)
      const minor = (li: number) => roadCls >= 0 && lines[li].road && lines[li].cls > ROAD_C;
      if (i < n - 1 && nearest(xs[i], ys[i], GAP, (li, s0, x, y) => nearEnd(li, s0, x, y) || minor(li))) return no((roadCls >= 0 ? 'dlink: ' : 'link: ') + 'alongside'), false;
      if (i < n - 1 && inEstate(xs[i], ys[i], IND_STREET_KEEP - IND_FRONT)) return no((roadCls >= 0 ? 'dlink: ' : 'link: ') + 'estate'), false;
      if (onSquare((xs[i - 1] + xs[i]) / 2, (ys[i - 1] + ys[i]) / 2, -0.5) || (i < n - 1 && onSquare(xs[i], ys[i], -0.5))) return no('link: square'), false;
    }
    if (steep > 1) return no((roadCls >= 0 ? 'dlink: ' : 'link: ') + 'steep'), false;
    let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    if (roadCls >= 0) {
      // A road of the plan's own: drawn as one, and grown from like the network's.
      addLine(xs, ys, true, 0, null, roadCls);
      const xy = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) {
        xy[2 * i] = xs[i];
        xy[2 * i + 1] = ys[i];
      }
      redrawn.push({ key, cls: roadCls as SegmentPath['cls'], xy });
      for (const c of crossed) splitMinor(c.x, c.y);
      no('ROAD LINK');
      return true;
    }
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
      if (L.ind) return;
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
  // --- Industrial estates (towns) --------------------------------------------------
  // Where there is flat, dry ground at the edge of town beside a main road (an N
  // road rather than a D or C), clear of the old core: an access street leaving the
  // road, and side streets off it, a generation or two deep. They run straight but
  // drift and bend to stay on the flat, and end where it ends, alongside another
  // street or meeting one (a junction); long dead ends now and then get a turning
  // loop. The estate's land is the strip either side of its streets (and of the road
  // along its front), so its outline follows the flat land. Laid out before the
  // town grows, which then keeps out of it.
  /** Flat ground, by node (made on first use). */
  let flatMask: Uint8Array | null = null;
  const flatAt = (x: number, y: number) => {
    if (!flatMask) {
      flatMask = new Uint8Array(w * h);
      const z = p.zE;
      for (let j = 1; j < h - 1; j++)
        for (let i = 1; i < w - 1; i++) {
          const k = j * w + i;
          if (!Number.isNaN(p.lake[k]) || p.A[k] > STREAM_A) continue;
          if (Math.hypot(z[k + 1] - z[k - 1], z[k + w] - z[k - w]) / (2 * NODE) <= IND_FLAT) flatMask[k] = 1;
        }
    }
    const k = node(x, y);
    return k >= 0 && flatMask[k] === 1;
  };
  /** The estates' main road fronts: the road's points, and the side of it the estate lies on (+1: left of its direction). */
  const roadFronts: { xs: number[]; ys: number[]; side: number }[] = [];
  /** The estates' gates: where their access streets (lines) leave the road, of class cls. */
  const gates: { x: number; y: number; road: number; access: number; cls: number }[] = [];
  /** …those given a roundabout (radius r, ring xy). */
  const gateRings: { x: number; y: number; road: number; access: number; cls: number; r: number; xy: Float32Array }[] = [];
  /** Roundabouts draw on a stream of their own: the rest of the plan is as without them. */
  const ringRand = rng(hash1(seed ^ 0x52b0));
  // How far each place is from the estates' land (to IND_FRONT beyond it), on a
  // grid of IND_CELL m over the patch: their streets, and their road fronts on their side.
  const efW = Math.ceil(((w - 1) * NODE) / IND_CELL) + 1;
  const efH = Math.ceil(((h - 1) * NODE) / IND_CELL) + 1;
  let estDist: Float32Array | null = null;
  const markEstates = () => {
    const D = (estDist = new Float32Array(efW * efH).fill(Infinity));
    const R = 2 * IND_FRONT;
    const mark = (ax: number, ay: number, bx: number, by: number, side: number) => {
      for (let j = Math.max(0, Math.floor((Math.min(ay, by) - R) / IND_CELL - p.gy * (NODE / IND_CELL))); j < efH; j++) {
        const y = p.gy * NODE + j * IND_CELL;
        if (y > Math.max(ay, by) + R) break;
        for (let i = Math.max(0, Math.floor((Math.min(ax, bx) - R) / IND_CELL - p.gx * (NODE / IND_CELL))); i < efW; i++) {
          const x = p.gx * NODE + i * IND_CELL;
          if (x > Math.max(ax, bx) + R) break;
          const dx = bx - ax;
          const dy = by - ay;
          if (side && Math.sign(dx * (y - ay) - dy * (x - ax)) !== side) continue;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
          const px = ax + t * dx;
          const py = ay + t * dy;
          const d = Math.hypot(px - x, py - y);
          // Not across a road (where its streets meet one; tested to a metre past the street, as it may end on the road).
          if (d < D[j * efW + i] && (side || !crossing(x, y, px + (px - x) / (d || 1), py + (py - y) / (d || 1), (li) => !lines[li].road)))
            D[j * efW + i] = d;
        }
      }
    };
    for (const L of lines) if (L.ind) for (let k = 1; k < L.xs.length; k++) mark(L.xs[k - 1], L.ys[k - 1], L.xs[k], L.ys[k], 0);
    for (const f of roadFronts) for (let k = 1; k < f.xs.length; k++) mark(f.xs[k - 1], f.ys[k - 1], f.xs[k], f.ys[k], f.side);
  };
  /** Is (x, y) within IND_FRONT + m (at most 2 × IND_FRONT) of an estate's streets, or of its road front on its side? */
  function inEstate(x: number, y: number, m: number): boolean {
    if (!estDist) return false;
    const i = Math.round((x - p.gx * NODE) / IND_CELL);
    const j = Math.round((y - p.gy * NODE) / IND_CELL);
    return i >= 0 && j >= 0 && i < efW && j < efH && estDist[j * efW + i] <= IND_FRONT + m;
  }
  /** Estates keep out of the old core. */
  const indInner = Math.max(oldCore * LARGE_FROM, core * 0.6);
  /**
   * An estate street from (x0, y0) heading a0, within IND_R of (ex, ey), off line
   * `parent`. Null if it would meet a way at a bad angle or loop straight back.
   */
  const estateWalk = (x0: number, y0: number, a0: number, maxLen: number, ex: number, ey: number, parent: number) => {
    const xs = [x0];
    const ys = [y0];
    // Pieces near its start are its own junction (wide enough that the street it leaves isn't "alongside").
    // Near its start, its parent is no obstacle; other streets only at the junction
    // itself, where it may cross nothing, not even its parent.
    const home = (li: number, _s: number, x: number, y: number) => Math.hypot(x - x0, y - y0) < (li === parent ? IND_GAP + 20 : 2);
    const junction = (_li: number, _s: number, x: number, y: number) => Math.hypot(x - x0, y - y0) < 2;
    let a = a0;
    let base = a0;
    const drift = (rand() * 2 - 1) * IND_DRIFT;
    let len = 0;
    let target = -1;
    while (len < maxLen) {
      const x = xs[xs.length - 1];
      const y = ys[ys.length - 1];
      base += drift;
      // A street close ahead draws it in, to meet it square-ish.
      let want = base;
      if (len >= STEP) {
        const ahead = nearest(x + Math.cos(a) * 30, y + Math.sin(a) * 30, 30, home);
        if (ahead) want = Math.atan2(ahead.y - y, ahead.x - x);
      }
      let best = Infinity;
      let ba = a;
      for (const da of [-0.3, -0.15, -0.06, 0, 0.06, 0.15, 0.3]) {
        const na = a + da;
        if (!flatAt(x + Math.cos(na) * STEP, y + Math.sin(na) * STEP)) continue;
        // Bending early where the flat ends ahead.
        let off = 0;
        for (const k of [2, 3]) if (!flatAt(x + Math.cos(na) * STEP * k, y + Math.sin(na) * STEP * k)) off++;
        const cost = 2 * Math.abs(angDiff(na, want)) + 0.4 * Math.abs(da) + off;
        if (cost < best) {
          best = cost;
          ba = na;
        }
      }
      if (best === Infinity) break; // off the flat
      a = ba;
      let nx = x + Math.cos(a) * STEP;
      let ny = y + Math.sin(a) * STEP;
      const dc = Math.hypot(nx - cx, ny - cy);
      if (Math.hypot(nx - ex, ny - ey) > IND_R || dc > hardReach - IND_KEEP || dc < indInner) break;
      const hit =
        crossing(x, y, nx, ny, junction) ??
        (() => {
          const n = nearest(nx, ny, SNAP, home);
          // On the way there it may cross another street first: it meets that one.
          return n && Math.cos(Math.atan2(n.y - y, n.x - x) - a) > 0.35 ? (crossing(x, y, n.x, n.y, (li, s, px, py) => li === n.li || junction(li, s, px, py)) ?? n) : null;
        })();
      if (hit) {
        // Not onto tracks or paths, nor where it crosses water: a dead end short of them.
        if ((lines[hit.li].road && lines[hit.li].cls > ROAD_C) || wet(hit.x, hit.y)) break;
        const [hx, hy] = dirAt(hit.li, hit.k);
        const ang = Math.abs(angDiff(Math.atan2(hit.y - y, hit.x - x), Math.atan2(hy, hx)));
        if (Math.min(ang, Math.PI - ang) < MIN_ANGLE) return no('estate: angle'), null;
        if (hit.li === parent) return no('estate: short loop'), null;
        nx = hit.x;
        ny = hit.y;
        xs.push(nx);
        ys.push(ny);
        len += Math.hypot(nx - x, ny - y);
        target = hit.li;
        break;
      }
      // Alongside another street without meeting it: stop short.
      const by = nearest(nx, ny, IND_GAP, home);
      if (by && Math.cos(Math.atan2(by.y - ny, by.x - nx) - a) < 0.5) break;
      xs.push(nx);
      ys.push(ny);
      len += STEP;
    }
    return { xs, ys, len, target };
  };
  /** Adds an estate street, and a turning loop at its end if it's a long dead end with room for one. */
  const addEstateStreet = (xs: number[], ys: number[], target: number, len: number) => {
    const li = addLine(xs, ys, false, 1, null);
    lines[li].ind = true;
    const n = xs.length;
    if (target >= 0 || len < IND_LOOP_FROM || rand() >= IND_LOOP_CHANCE) return li;
    const ex = xs[n - 1];
    const ey = ys[n - 1];
    const dl = Math.hypot(ex - xs[n - 2], ey - ys[n - 2]) || 1;
    const ox = ex + ((ex - xs[n - 2]) / dl) * IND_LOOP;
    const oy = ey + ((ey - ys[n - 2]) / dl) * IND_LOOP;
    if (nearest(ox, oy, IND_LOOP + 10, (l2) => l2 === li)) return li;
    const a0 = Math.atan2(ey - oy, ex - ox);
    const lx: number[] = [];
    const ly: number[] = [];
    for (let q = 0; q <= 12; q++) {
      const t = a0 + (2 * Math.PI * q) / 12;
      const x = q % 12 ? ox + IND_LOOP * Math.cos(t) : ex;
      const y = q % 12 ? oy + IND_LOOP * Math.sin(t) : ey;
      if (!flatAt(x, y)) return li;
      lx.push(x);
      ly.push(y);
    }
    lines[addLine(lx, ly, false, 1, null)].ind = true;
    no('ESTATE LOOP');
    return li;
  };
  /** Grows an estate off road line li at s, on its side `side`; false if its access street won't go far enough. */
  const growEstate = (li: number, s: number, side: number): boolean => {
    const P = pointAt(li, s);
    const A = pointAt(li, s - 30);
    const B = pointAt(li, s + 30);
    // Square off the road (on its side), give or take.
    const a0 = Math.atan2((B.x - A.x) * side, -(B.y - A.y) * side) + (rand() * 2 - 1) * 0.15;
    const acc = estateWalk(P.x, P.y, a0, lerp(IND_ACCESS[0], IND_ACCESS[1], rand()), P.x, P.y, li);
    if (!acc || acc.len < 80) return no('estate: access'), false;
    const budget = lerp(IND_BUDGET[0], IND_BUDGET[1], rand());
    let built = acc.len;
    const access = addEstateStreet(acc.xs, acc.ys, acc.target, acc.len);
    gates.push({ x: P.x, y: P.y, road: li, access, cls: lines[li].cls });
    const queue: { li: number; gen: number }[] = [{ li: access, gen: 1 }];
    // Its road front: the road's points within IND_ROAD_FRONT of the junction, while the land beside them is flat.
    {
      const L = lines[li];
      const f = { xs: [] as number[], ys: [] as number[], side };
      for (let i = 0; i < L.xs.length; i++) {
        if (Math.abs(L.s[i] - s) > IND_ROAD_FRONT) continue;
        const [tx, ty] = dirAt(li, Math.min(i, L.xs.length - 2));
        const ok = flatAt(L.xs[i] - ty * side * 20, L.ys[i] + tx * side * 20);
        if (ok) {
          f.xs.push(L.xs[i]);
          f.ys.push(L.ys[i]);
        } else if (L.s[i] > s) break;
        else {
          f.xs.length = 0;
          f.ys.length = 0;
        }
      }
      if (f.xs.length >= 2) roadFronts.push(f);
    }
    while (queue.length && built < budget) {
      const { li: pl, gen } = queue.shift()!;
      const L = lines[pl];
      const total = L.s[L.s.length - 1];
      for (const sd of [1, -1])
        for (let t = 35 + rand() * 20; t < total - 25 && built < budget; t += lerp(IND_SPACING[0], IND_SPACING[1], rand())) {
          if (rand() >= IND_BRANCH_CHANCE) continue;
          const Q = pointAt(pl, t);
          const [tx, ty] = dirAt(pl, Q.k);
          const nx0 = -ty * sd;
          const ny0 = tx * sd;
          // Not beside a junction on this side already.
          if (nearest(Q.x, Q.y, 35, (l2, _s, x, y) => l2 === pl || (x - Q.x) * nx0 + (y - Q.y) * ny0 < 1)) continue;
          const b = estateWalk(Q.x, Q.y, Math.atan2(ny0, nx0) + (rand() * 2 - 1) * 0.15, lerp(IND_BRANCH[0], IND_BRANCH[1], rand()), P.x, P.y, pl);
          if (!b || (b.target >= 0 ? b.len < 25 : b.len < 45)) continue;
          built += b.len;
          const nl = addEstateStreet(b.xs, b.ys, b.target, b.len);
          if (gen < IND_GENS) queue.push({ li: nl, gen: gen + 1 });
        }
    }
    return true;
  };
  /** How much flat, free land lies near a junction at line li, s, on side `side` (m²); 0 if too little. */
  const flatNear = (li: number, s: number, side: number): number => {
    const P = pointAt(li, s);
    const A = pointAt(li, s - 30);
    const B = pointAt(li, s + 30);
    const tl = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const nx = (-(B.y - A.y) / tl) * side;
    const ny = ((B.x - A.x) / tl) * side;
    // Its access street has flat ground to start on.
    for (const d of [12, 24, 36]) if (!flatAt(P.x + nx * d, P.y + ny * d)) return 0;
    let n = 0;
    for (let v = -IND_R; v <= IND_R; v += IND_SAMPLE)
      for (let u = IND_SAMPLE / 2; u <= IND_R; u += IND_SAMPLE) {
        if (u * u + v * v > IND_R * IND_R) continue;
        const x = P.x + nx * u - ny * v;
        const y = P.y + ny * u + nx * v;
        const dc = Math.hypot(x - cx, y - cy);
        if (dc < indInner || dc > hardReach - IND_KEEP || !flatAt(x, y)) continue;
        if (nearest(x, y, 15) || inEstate(x, y, IND_FRONT)) continue;
        n++;
      }
    const area = n * IND_SAMPLE * IND_SAMPLE;
    return area >= IND_AREA ? area : 0;
  };
  if (rank === TOWN) {
    const want = rand() < IND_SECOND ? 2 : 1;
    for (let k = 0; k < want; k++) {
      // Junctions every 30 m along the main roads, both sides, best first: the most
      // flat land (up to twice what's needed), the busier road, nearer 1.3× the core's radius.
      const cands: { li: number; s: number; side: number; score: number }[] = [];
      for (let li = 0; li < lines.length; li++) {
        const L = lines[li];
        if (!L.road || L.cls > ROAD_C || L.ring) continue;
        const total = L.s[L.s.length - 1];
        for (let s = 40; s < total - 40; s += 30) {
          const P = pointAt(li, s);
          const d = Math.hypot(P.x - cx, P.y - cy);
          if (d < 0.8 * core || d > reach || nearRing(P.x, P.y, 40)) continue;
          if (nearest(P.x, P.y, 40, (l2) => l2 === li)) continue; // its own junction alone on the road
          for (const side of [1, -1]) {
            const area = flatNear(li, s, side);
            if (!area) continue;
            const score = -Math.min(area, 2 * IND_AREA) / IND_AREA + 0.5 * L.cls + Math.abs(d - 1.3 * core) / core + 0.3 * rand();
            cands.push({ li, s, side, score });
          }
        }
      }
      cands.sort((c1, c2) => c1.score - c2.score);
      let grown = false;
      for (const c of cands.slice(0, 4)) if ((grown = growEstate(c.li, c.s, c.side))) break;
      if (!grown) break;
      markEstates();
      no('ESTATE');
    }
    // A roundabout at a gate, now and then: where the road is dry and level there, no
    // other street comes near and no other way ends within the ring (the network's
    // segments keep their far ends).
    for (const g of gates) {
      if (ringRand() >= IND_RING) continue;
      const r = lerp(IND_RING_R[0], IND_RING_R[1], ringRand());
      let lo = Infinity;
      let hi = -Infinity;
      let ok = true;
      for (let q = 0; q < 16 && ok; q++)
        for (const f of [0.5, 1, (r + 5) / r]) {
          const x = g.x + f * r * Math.cos((q * Math.PI) / 8);
          const y = g.y + f * r * Math.sin((q * Math.PI) / 8);
          if (wet(x, y) || areaAt(x, y) > STREAM_A) ok = false;
          const z = zAt(x, y);
          lo = Math.min(lo, z);
          hi = Math.max(hi, z);
        }
      for (const q of net)
        for (const i of [0, q.xy.length - 2]) if (Math.hypot(q.xy[i] - g.x, q.xy[i + 1] - g.y) < r + 5) ok = false;
      if (nearest(g.x, g.y, r + 10, (li) => li === g.road || li === g.access)) ok = false;
      if (!ok || hi - lo > 0.06 * 2 * (r + 5)) {
        no('estate: no roundabout');
        continue;
      }
      const xy = ringLine(g.x, g.y, r);
      addRing(xy, g.cls);
      gateRings.push({ ...g, r, xy });
      no('ESTATE ROUNDABOUT');
    }
  }

  // --- D-road links (a tiered network) ---------------------------------------------
  // In towns and large villages, the N and D roads leaving the centre (and C roads,
  // where those are few) are linked round the core by D roads of the plan's own,
  // before any street: neighbouring roads, a link leaving each square on and bulging
  // outward (across a wide gap, an arc of an inner ring road). Streets then grow from
  // them as from the network's roads.
  const big = rank === TOWN || (rank === VILLAGE && core > BIG_VILLAGE);
  if (big) {
    const t = rank === TOWN ? 0 : 1;
    const r0 = core * lerp(LINK_R[t][0], LINK_R[t][1], rand());
    /** Where N, D (and, where those are few, C) roads cross the circle of radius r, by angle. */
    const armsAt = (r: number) => {
      const hits: { a: number; x: number; y: number; tx: number; ty: number; li: number; cls: number }[] = [];
      lines.forEach((L, li) => {
        if (!L.road || L.cls > ROAD_C || L.ring) return;
        for (let k = 0; k + 1 < L.xs.length; k++) {
          const d0 = Math.hypot(L.xs[k] - cx, L.ys[k] - cy) - r;
          const d1 = Math.hypot(L.xs[k + 1] - cx, L.ys[k + 1] - cy) - r;
          if (d0 * d1 > 0 || d0 === d1) continue;
          const u = d0 / (d0 - d1);
          const [tx, ty] = dirAt(li, k);
          hits.push({ a: Math.atan2(L.ys[k] + u * (L.ys[k + 1] - L.ys[k]) - cy, L.xs[k] + u * (L.xs[k + 1] - L.xs[k]) - cx), x: L.xs[k] + u * (L.xs[k + 1] - L.xs[k]), y: L.ys[k] + u * (L.ys[k + 1] - L.ys[k]), tx, ty, li, cls: L.cls });
        }
      });
      const main = hits.filter((hh) => hh.cls <= ROAD_D);
      return (main.length >= 3 ? main : hits).sort((h1, h2) => h1.a - h2.a);
    };
    /** A link across the gap from arm A to arm B: leaving each square on, bulging outward. */
    const link = (A: ReturnType<typeof armsAt>[number], B: ReturnType<typeof armsAt>[number]) => {
      const into = (hh: typeof A, ox: number, oy: number): [number, number] => {
        const sd = -hh.ty * (ox - hh.x) + hh.tx * (oy - hh.y) > 0 ? 1 : -1;
        return [-hh.ty * sd, hh.tx * sd];
      };
      const [nax, nay] = into(A, B.x, B.y);
      const [nbx, nby] = into(B, A.x, A.y);
      const d = Math.hypot(B.x - A.x, B.y - A.y);
      const k = 0.45 * d;
      const steps = Math.max(4, Math.ceil((1.3 * d) / STEP));
      const xs: number[] = [];
      const ys: number[] = [];
      for (let j = 0; j <= steps; j++) {
        const u = j / steps;
        const b0 = (1 - u) ** 3;
        const b1 = 3 * u * (1 - u) ** 2;
        const b2 = 3 * u * u * (1 - u);
        const b3 = u ** 3;
        xs.push(b0 * A.x + b1 * (A.x + nax * k) + b2 * (B.x + nbx * k) + b3 * B.x);
        ys.push(b0 * A.y + b1 * (A.y + nay * k) + b2 * (B.y + nby * k) + b3 * B.y);
      }
      return [xs, ys];
    };
    /**
     * A link routed over the fine nodes (cheapest path: length, more on slopes, much
     * more across a river; never over a lake or near another way but at its ends;
     * kept to a band round the core), then smoothed and resampled. Empty if none.
     */
    const route = (A: ReturnType<typeof armsAt>[number], B: ReturnType<typeof armsAt>[number], r: number): [number[], number[]] => {
      const i0 = Math.max(1, Math.floor((cx - LINK_BAND[1] * r) / NODE) - p.gx);
      const j0 = Math.max(1, Math.floor((cy - LINK_BAND[1] * r) / NODE) - p.gy);
      const i1 = Math.min(w - 2, Math.ceil((cx + LINK_BAND[1] * r) / NODE) - p.gx);
      const j1 = Math.min(h - 2, Math.ceil((cy + LINK_BAND[1] * r) / NODE) - p.gy);
      const bw = i1 - i0 + 1;
      const bh = j1 - j0 + 1;
      if (bw < 3 || bh < 3) return [[], []];
      const id = (i: number, j: number) => (j - j0) * bw + (i - i0);
      const posOf = (k: number): [number, number] => [(i0 + (k % bw) + p.gx) * NODE, (j0 + Math.floor(k / bw) + p.gy) * NODE];
      const free = new Uint8Array(bw * bh);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const [x, y] = [(i + p.gx) * NODE, (j + p.gy) * NODE];
          const d = Math.hypot(x - cx, y - cy);
          if (d < LINK_BAND[0] * r || d > LINK_BAND[1] * r || d > hardReach || wet(x, y)) continue;
          // Off other ways (as the link's checks want: GAP from roads and streets, less
          // from tracks, which it may cross), but at its ends.
          const nearEnds = Math.hypot(x - A.x, y - A.y) < 40 || Math.hypot(x - B.x, y - B.y) < 40;
          if (!nearEnds && nearest(x, y, GAP + 2, (li) => lines[li].road && lines[li].cls > ROAD_C)) continue;
          if (!nearEnds && nearest(x, y, 12)) continue;
          free[id(i, j)] = 1;
        }
      const start = id(Math.round(A.x / NODE) - p.gx, Math.round(A.y / NODE) - p.gy);
      const goal = id(Math.round(B.x / NODE) - p.gx, Math.round(B.y / NODE) - p.gy);
      if (start < 0 || goal < 0 || start >= free.length || goal >= free.length) return [[], []];
      free[start] = free[goal] = 1;
      const cost = new Float64Array(bw * bh).fill(Infinity);
      const from = new Int32Array(bw * bh).fill(-1);
      const open = new MinHeap(256);
      const ids: number[] = [start];
      open.push(0, 0);
      cost[start] = 0;
      while (open.size) {
        const c0 = open.peekKey();
        const k = ids[open.pop()];
        if (c0 > cost[k]) continue;
        if (k === goal) break;
        const ki = k % bw;
        const kj = Math.floor(k / bw);
        const [kx, ky] = posOf(k);
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ni = ki + di;
            const nj = kj + dj;
            if (ni < 0 || nj < 0 || ni >= bw || nj >= bh) continue;
            const nk = nj * bw + ni;
            if (!free[nk]) continue;
            const [nx2, ny2] = posOf(nk);
            const len = NODE * Math.hypot(di, dj);
            const g = Math.abs(zAt(nx2, ny2) - zAt(kx, ky)) / len;
            if (g > LINK_GRADE) continue;
            let c = len * (1 + (g / LINK_ROUTE_GRADE) ** 2);
            if (areaAt(nx2, ny2) > RIVER_A) c += LINK_BRIDGE;
            if (cost[k] + c < cost[nk]) {
              cost[nk] = cost[k] + c;
              from[nk] = k;
              ids.push(nk);
              open.push(ids.length - 1, cost[nk]);
            }
          }
      }
      if (from[goal] < 0) return [[], []];
      const pts: [number, number][] = [[B.x, B.y]];
      for (let k = from[goal]; k >= 0 && k !== start; k = from[k]) pts.push(posOf(k));
      pts.push([A.x, A.y]);
      pts.reverse();
      // Smoothed (Chaikin, ends fixed) and resampled every STEP m.
      let sm = pts;
      for (let pass = 0; pass < 3; pass++) {
        const nx3: [number, number][] = [sm[0]];
        for (let q = 0; q + 1 < sm.length; q++) {
          const [ax2, ay2] = sm[q];
          const [bx2, by2] = sm[q + 1];
          if (q > 0) nx3.push([0.75 * ax2 + 0.25 * bx2, 0.75 * ay2 + 0.25 * by2]);
          if (q + 2 < sm.length) nx3.push([0.25 * ax2 + 0.75 * bx2, 0.25 * ay2 + 0.75 * by2]);
        }
        nx3.push(sm[sm.length - 1]);
        sm = nx3;
      }
      const xs: number[] = [sm[0][0]];
      const ys: number[] = [sm[0][1]];
      let carry = 0;
      for (let q = 1; q < sm.length; q++) {
        const [ax2, ay2] = sm[q - 1];
        const [bx2, by2] = sm[q];
        const l = Math.hypot(bx2 - ax2, by2 - ay2);
        let t = STEP - carry;
        while (t < l) {
          xs.push(ax2 + ((bx2 - ax2) * t) / l);
          ys.push(ay2 + ((by2 - ay2) * t) / l);
          t += STEP;
        }
        carry = l - (t - STEP);
      }
      xs.push(B.x);
      ys.push(B.y);
      return [xs, ys];
    };
    // Each gap between neighbouring arms (as seen at r0), tried at r0 and, failing
    // that, a little inside and outside it.
    const arms = armsAt(r0);
    let made = 0;
    for (let i = 0; i < arms.length && arms.length > 1 && made < LINK_MAX[t]; i++) {
      let gap = arms[(i + 1) % arms.length].a - arms[i].a;
      if (gap <= 0) gap += 2 * Math.PI;
      if (gap < LINK_GAP[0] || gap > LINK_GAP[1] || rand() > LINK_CHANCE[t]) continue;
      const mid = arms[i].a + gap / 2;
      for (const f of LINK_TRY) {
        // The same two arms at this radius: the hits either side of the gap's middle.
        const at = armsAt(r0 * f);
        const after = at.findIndex((hh) => angDiff(hh.a, mid) > 0);
        if (at.length < 2) continue;
        const B = at[after < 0 ? 0 : after];
        const A = at[((after < 0 ? 0 : after) - 1 + at.length) % at.length];
        if (A.li !== arms[i].li || B.li !== arms[(i + 1) % arms.length].li) continue;
        // A smooth curve first; where that fails, a route over the ground.
        let ok = false;
        for (const [xs, ys] of [link(A, B), f >= LINK_TRY[1] ? route(A, B, r0 * f) : [[], []]]) {
          if (!xs.length) continue;
          ok = tryStreet(xs, ys, organic, 0, ROAD_D, `${site.id}#d${made}`);
          linkTries.push({ xy: xs.flatMap((x, q) => [x, ys[q]]), made: ok });
          if (ok) break;
        }
        if (ok) {
          made++;
          break;
        }
      }
    }
  }

  // --- A square ----------------------------------------------------------------
  // Some villages (more of the large ones, and towns besides their market square)
  // have a square: an open place beside a main road near the centre, framed by
  // streets on its other three sides, flat and dry. Houses line it from outside, and
  // the church may face it.
  if (rank !== HAMLET && rand() < SQUARE_CHANCE[rank === TOWN ? 0 : big ? 1 : 2]) {
    const sc = rank === TOWN ? SQUARE_TOWN : 1;
    const W = lerp(SQUARE_W[0], SQUARE_W[1], rand()) * sc;
    const D = lerp(SQUARE_DEPTH[0], SQUARE_DEPTH[1], rand()) * sc;
    const cands: { li: number; s: number; side: number; d: number }[] = [];
    lines.forEach((L, li) => {
      if (!L.road || L.cls > ROAD_C || L.ring) return;
      const total = L.s[L.s.length - 1];
      for (let s0 = W / 2 + 5; s0 < total - W / 2 - 5; s0 += 8) {
        const P = pointAt(li, s0);
        const d = Math.hypot(P.x - cx, P.y - cy);
        if (d < SQUARE_D[0] * sc || d > SQUARE_D[1] * sc || nearRing(P.x, P.y, 30)) continue;
        // Not on a junction: its whole front along the road is free of other ways.
        if (nearest(P.x, P.y, W / 2 + 6, (l2) => l2 === li)) continue;
        for (const side of [1, -1]) cands.push({ li, s: s0, side, d: d + 15 * rand() });
      }
    });
    cands.sort((c1, c2) => c1.d - c2.d);
    no(`square: tried`);
    if (!cands.length) no('square: no spot');
    for (const c of cands) {
      const L = lines[c.li];
      const P0 = pointAt(c.li, c.s - W / 2);
      const P1 = pointAt(c.li, c.s + W / 2);
      const tl = Math.hypot(P1.x - P0.x, P1.y - P0.y) || 1;
      const tx = (P1.x - P0.x) / tl;
      const ty = (P1.y - P0.y) / tl;
      const nx = -ty * c.side;
      const ny = tx * c.side;
      const b = ROAD_CLEAR[L.cls];
      // Its ground: flat, dry, nothing else on it.
      let fits = true;
      for (let u = 0; u <= 1 && fits; u += 0.25)
        for (let v = 0; v <= 1 && fits; v += 0.25) {
          const x = P0.x + tx * W * u + nx * (b + D * v);
          const y = P0.y + ty * W * u + ny * (b + D * v);
          const g = Math.hypot(zAt(x + 8, y) - zAt(x - 8, y), zAt(x, y + 8) - zAt(x, y - 8)) / 16;
          if (wet(x, y) || areaAt(x, y) > STREAM_A || g > SQUARE_STEEP || nearest(x, y, 8, (li) => li === c.li)) fits = false;
        }
      if (!fits) {
        no('square: ground');
        continue;
      }
      // The streets round it: out from the road, along the back, back to the road.
      const corners = [
        [P0.x, P0.y],
        [P0.x + nx * (b + D), P0.y + ny * (b + D)],
        [P1.x + nx * (b + D), P1.y + ny * (b + D)],
        [P1.x, P1.y],
      ];
      const xs: number[] = [];
      const ys: number[] = [];
      for (let q = 1; q < corners.length; q++) {
        const [x0, y0] = corners[q - 1];
        const [x1, y1] = corners[q];
        const m = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / STEP));
        for (let t = q === 1 ? 0 : 1; t <= m; t++) {
          xs.push(x0 + ((x1 - x0) * t) / m);
          ys.push(y0 + ((y1 - y0) * t) / m);
        }
      }
      let clear = true;
      for (let i = 1; i < xs.length && clear; i++) {
        if (crossing(xs[i - 1], ys[i - 1], xs[i], ys[i], (li, _s, x, y) => li === c.li && (Math.hypot(x - P0.x, y - P0.y) < 2 || Math.hypot(x - P1.x, y - P1.y) < 2))) clear = false;
        if (i < xs.length - 1 && nearest(xs[i], ys[i], 12, (li) => li === c.li)) clear = false;
      }
      if (!clear) {
        no('square: ways');
        continue;
      }
      const li = addLine(xs, ys, false, 1, old);
      let len = 0;
      for (let i = 1; i < xs.length; i++) len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
      streets.push({ li, cls: STREET, parent: -2, target: -2, stop: 'square', len });
      built += len;
      const poly = [P0.x + nx * b, P0.y + ny * b, corners[1][0], corners[1][1], corners[2][0], corners[2][1], P1.x + nx * b, P1.y + ny * b];
      squarePolys.push(poly);
      squares.push(Float32Array.from(poly));
      no('SQUARE');
      break;
    }
  }

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
    // Leaving its parent, it may run beside it for a while; other streets only at the
    // junction itself, where it may cross nothing, not even its parent.
    const home = (li: number, _s: number, x: number, y: number) => Math.hypot(x - P.x, y - P.y) < (li === c.li ? 30 : 2);
    const junction = (_li: number, _s: number, x: number, y: number) => Math.hypot(x - P.x, y - P.y) < 2;
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
        crossing(x, y, nx, ny, junction) ??
        (() => {
          const n = nearest(nx, ny, SNAP, home);
          if (!n) return null;
          const ahead = Math.cos(Math.atan2(n.y - y, n.x - x) - a);
          // On the way there it may cross another street first: it meets that one.
          return ahead > 0.35 ? (crossing(x, y, n.x, n.y, (li, s, px, py) => li === n.li || junction(li, s, px, py)) ?? n) : null;
        })();
      // Not onto a street where it crosses water (a bridge): a dead end short of it.
      if (hit && wet(hit.x, hit.y)) {
        stop = 'water';
        break;
      }
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
      // Not into an industrial estate, unless heading to meet one of its streets.
      if (inEstate(nx, ny, IND_STREET_KEEP - IND_FRONT)) {
        const e = nearest(nx, ny, IND_STREET_KEEP, (li) => !lines[li].ind);
        if (!e || Math.cos(Math.atan2(e.y - ny, e.x - nx) - a) < 0.5) {
          stop = 'estate';
          break;
        }
      }
      // Never into a square (its own street is on its edge).
      if (inConvexAny(nx, ny)) {
        failed = 'square';
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
  const estateOut: Street[] = lines
    .filter((L) => L.ind)
    .map((L) => {
      const xy = new Float32Array(2 * L.xs.length);
      for (let i = 0; i < L.xs.length; i++) {
        xy[2 * i] = L.xs[i];
        xy[2 * i + 1] = L.ys[i];
      }
      // An access street leaves from its gate's roundabout.
      const g = gateRings.find((q) => lines[q.access] === L);
      return { cls: STREET, xy: g ? Float32Array.from(outsideCircle(xy, g.x, g.y, g.r)[0]) : xy };
    });
  // The roads through the gates' roundabouts stop at the ring; their pieces keep their keys.
  gateRings.forEach((g, k) => {
    net = net.flatMap((q) => {
      if (q.ring || q.cls > ROAD_C) return [q];
      let near = false;
      for (let i = 2; i < q.xy.length && !near; i += 2) near = segPointDist(q.xy[i - 2], q.xy[i - 1], q.xy[i], q.xy[i + 1], g.x, g.y) < g.r;
      if (!near) return [q];
      const i = redrawn.indexOf(q);
      if (i >= 0) redrawn.splice(i, 1);
      const pieces = outsideCircle(q.xy, g.x, g.y, g.r).map((xy) => ({ key: q.key, cls: q.cls, xy: Float32Array.from(xy), micro: q.micro }));
      redrawn.push(...pieces);
      return pieces;
    });
    redrawn.push({ key: `${site.id}#rb${k}`, cls: g.cls as SegmentPath['cls'], xy: g.xy, ring: true });
  });
  const upgraded: Street[] = [];
  // Built-up land: along every street, and along roads near streets or the core.
  const streetNear = (x: number, y: number) => nearest(x, y, 70, (li) => lines[li].road || !!lines[li].pruned || !!lines[li].ind);
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
    // A piece the plan already redraws (a track split where a road link crosses it) is redrawn as below instead.
    const own = roadsOut.indexOf(q);
    if (own >= 0) roadsOut.splice(own, 1);
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
  const fronts: { xy: Float32Array; main: boolean; ind?: boolean; order: number }[] = [];
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
  // Industrial estates: their streets, and their main road along their front, built up first.
  for (const st of estateOut) {
    frontage.push({ depth: IND_FRONT, xy: st.xy.slice() });
    fronts.push({ xy: st.xy, main: false, ind: true, order: -1 });
  }
  for (const f of roadFronts) {
    const xy = new Float32Array(2 * f.xs.length);
    for (let i = 0; i < f.xs.length; i++) {
      xy[2 * i] = f.xs[i];
      xy[2 * i + 1] = f.ys[i];
    }
    frontage.push({ depth: IND_FRONT, xy });
    fronts.push({ xy: xy.slice(), main: true, ind: true, order: -1 });
  }
  for (const L of lines) {
    if (!L.road || L.ring || (rank === HAMLET && L.cls > ROAD_C)) continue;
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
  const allStreets = [...out, ...upgraded, ...estateOut];
  const ways: Way[] = [
    ...sorted.filter((q) => !replaced.has(q.key)).map((q) => ({ xy: q.xy, clear: ROAD_CLEAR[q.cls] })),
    ...roadsOut.map((q) => ({ xy: q.xy, clear: ROAD_CLEAR[q.cls] })),
    ...allStreets.map((q) => ({ xy: q.xy, clear: STREET_CLEAR[q.cls] })),
    ...motorways.map((xy) => ({ xy: Float32Array.from(xy), clear: MW_BUILD_CLEAR })),
  ];
  const mid = (xy: Float32Array) => {
    const k = 2 * Math.floor(xy.length / 4);
    return Math.hypot(xy[k] - cx, xy[k + 1] - cy);
  };
  // --- Churches -----------------------------------------------------------------
  // Placed before any other building, next to a way, never on one: the first on the
  // crossroads green if there is one, else facing the square, else beside a main
  // road nearest the centre; further ones (large villages, towns) beside a main road
  // or a street, well apart. East–west where they fit, else square to the way.
  const { clashesWay } = wayClearance(ways);
  const churchQuads: number[][] = [];
  const churches: { x: number; y: number }[] = [];
  const nChurches =
    rank === TOWN ? 2 + (built > 12000 ? 1 : 0) + (built > 18000 && rand() < 0.5 ? 1 : 0) : rank === VILLAGE ? (built > CHURCH2_BUILT && rand() < CHURCH2_CHANCE ? 2 : 1) : 0;
  const tw = rank === TOWN ? 0 : 1;
  const churchFits = (q: number[]) => {
    const pts: [number, number][] = [];
    for (let k = 0; k < 8; k += 2) pts.push([q[k], q[k + 1]], [(q[k] + q[(k + 2) % 8]) / 2, (q[k + 1] + q[(k + 3) % 8]) / 2]);
    pts.push([(q[0] + q[4]) / 2, (q[1] + q[5]) / 2]);
    for (const [x, y] of pts) {
      if (wet(x, y) || areaAt(x, y) > STREAM_A || inEstate(x, y, IND_KEEP) || nearRing(x, y, 0) || onSquare(x, y, 0)) return false;
      if (Math.hypot(x - cx, y - cy) > extent - 5) return false;
      const g = Math.hypot(zAt(x + 4, y) - zAt(x - 4, y), zAt(x, y + 4) - zAt(x, y - 4)) / 8;
      if (g > CHURCH_STEEP) return false;
    }
    return !clashesWay(q) && !churchQuads.some((o) => quadsOverlap(q, o, 0));
  };
  /** A nave w × d centred on (x, y), its length at angle a. */
  const nave = (x: number, y: number, a: number, w: number, d: number) => {
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const hw = w / 2;
    const hd = d / 2;
    return [x - ux * hw + uy * hd, y - uy * hw - ux * hd, x + ux * hw + uy * hd, y + uy * hw - ux * hd, x + ux * hw - uy * hd, y + uy * hw + ux * hd, x - ux * hw - uy * hd, y - uy * hw + ux * hd].map(Math.fround);
  };
  for (let k = 0; k < nChurches; k++) {
    const w = k === 0 ? lerp(CHURCH_W[tw][0], CHURCH_W[tw][1], rand()) : lerp(CHURCH2_W[0], CHURCH2_W[1], rand());
    const d = k === 0 ? lerp(CHURCH_D[tw][0], CHURCH_D[tw][1], rand()) : lerp(CHURCH2_D[0], CHURCH2_D[1], rand());
    const east = (rand() - 0.5) * 2 * CHURCH_TURN;
    /** Spots to try, best first: [x, y, angle along the way]. */
    const spots: [number, number, number][] = [];
    if (k === 0 && redrawn.some((q) => q.key.startsWith(`${site.id}#sq`))) spots.push([cx, cy, east]);
    if (k === 0)
      for (const q of squarePolys) {
        // Facing the square across the street round it: its back side first, then its ends.
        for (const [e0, e1] of [
          [2, 4],
          [0, 2],
          [4, 6],
        ]) {
          const ax = q[e0];
          const ay = q[e0 + 1];
          const bx = q[(e1 % 8) || 0];
          const by = q[((e1 % 8) || 0) + 1];
          const ex = bx - ax;
          const ey = by - ay;
          const el = Math.hypot(ex, ey) || 1;
          // Outward: away from the square's middle.
          const mx = (q[0] + q[4]) / 2;
          const my = (q[1] + q[5]) / 2;
          let ox = -ey / el;
          let oy = ex / el;
          if (ox * ((ax + bx) / 2 - mx) + oy * ((ay + by) / 2 - my) < 0) {
            ox = -ox;
            oy = -oy;
          }
          for (const f of [0.5, 0.3, 0.7]) {
            const off = STREET_CLEAR[0] + CHURCH_SETBACK + d / 2;
            spots.push([ax + ex * f + ox * off, ay + ey * f + oy * off, Math.atan2(ey, ex)]);
          }
        }
      }
    // Beside a main road, then a street, nearest the centre first (further ones: far
    // enough from the others, within the core).
    const along: [number, number, number, number][] = [];
    lines.forEach((L, li) => {
      if (L.pruned || L.ind || L.ring) return;
      const clear = L.road ? ROAD_CLEAR[L.cls] : STREET_CLEAR[0];
      if (L.road && L.cls > ROAD_C) return;
      const total = L.s[L.s.length - 1];
      for (let s0 = 0; s0 <= total; s0 += 4) {
        const P = pointAt(li, s0);
        const dc = Math.hypot(P.x - cx, P.y - cy);
        if (dc > core * CHURCH_REACH[tw]) continue;
        const [tx, ty] = dirAt(li, P.k);
        for (const side of [1, -1]) {
          const off = clear + CHURCH_SETBACK + d / 2;
          // The first church on a main road near the centre; further ones on streets too.
          along.push([P.x - ty * side * off, P.y + tx * side * off, Math.atan2(ty, tx), dc + (L.road || k > 0 ? 0 : 60)]);
        }
      }
    });
    along.sort((a1, a2) => a1[3] - a2[3]);
    for (const [x, y, a] of along) spots.push([x, y, a]);
    for (const [x, y, a] of spots) {
      if (churches.some((c) => Math.hypot(c.x - x, c.y - y) < CHURCH_APART[tw])) continue;
      // East–west first (the old way), else square to its way.
      let q = nave(x, y, east, w, d);
      if (!churchFits(q)) q = nave(x, y, a, w, d);
      if (!churchFits(q)) continue;
      churchQuads.push(q);
      churches.push({ x: Math.fround(x), y: Math.fround(y) });
      no('CHURCH');
      break;
    }
  }

  const { buildings, industrial } = placeBuildings({
    preset: churchQuads,
    fronts: fronts.sort((a, b) => a.order - b.order || mid(a.xy) - mid(b.xy)),
    ways,
    // Main roads keep their terraces a little further out (the faubourgs).
    dense: (x, y, main) => rank !== HAMLET && zoneDist(x, y, main) < oldCore * (main ? MAIN_DENSE : 1),
    ok: (x, y, steep, ind) => {
      const r = Math.hypot(x - cx, y - cy);
      // Sheds and halls on the estates' land, houses off it.
      if (ind ? !inEstate(x, y, 0) || !flatAt(x, y) : inEstate(x, y, IND_KEEP)) return no('ground: estate'), false;
      if (wet(x, y)) return no('ground: lake'), false;
      if (areaAt(x, y) > STREAM_A) return no('ground: stream'), false;
      // Not on a roundabout's island.
      if (nearRing(x, y, 0)) return no('ground: roundabout'), false;
      if (r > extent - 5) return no('ground: extent'), false;
      if (onSquare(x, y, 0)) return no('ground: square'), false;
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

  // --- Water tower (in the mountains, a reservoir uphill) --------------------------
  const pois: Poi[] = [];
  const mountain = site.R >= TOWER_MOUNTAIN;
  if (rank !== HAMLET && rand() < (mountain ? RESERVOIR_CHANCE : TOWER_CHANCE[rank])) {
    const r0 = Math.max(oldCore, 60);
    const r1 = Math.min(reach, extent - 40);
    const cands: { x: number; y: number; z: number }[] = [];
    for (let j = 1; j < h - 1; j++)
      for (let i = 1; i < w - 1; i++) {
        const x = (p.gx + i) * NODE;
        const y = (p.gy + j) * NODE;
        const d = Math.hypot(x - cx, y - cy);
        if (d < r0 || d > r1 || wet(x, y) || areaAt(x, y) > STREAM_A || inEstate(x, y, IND_KEEP) || nearRing(x, y, 10)) continue;
        cands.push({ x, y, z: p.zE[j * w + i] });
      }
    cands.sort((a, b) => b.z - a.z || a.x - b.x || a.y - b.y);
    const gone = (li: number) => !!lines[li].pruned;
    for (const c of cands) {
      if (nearest(c.x, c.y, TOWER_CLEAR, gone) || !nearest(c.x, c.y, TOWER_ACCESS, gone)) continue;
      let clear = true;
      for (let k = 0; k < buildings.length && clear; k += 8)
        if (Math.abs(buildings[k] - c.x) < 100 && Math.abs(buildings[k + 1] - c.y) < 100 && segQuadDist(c.x, c.y, c.x, c.y, Array.from(buildings.subarray(k, k + 8))) < TOWER_CLEAR) clear = false;
      if (!clear) continue;
      pois.push({ kind: mountain ? RESERVOIR : TOWER, x: c.x, y: c.y });
      no(mountain ? 'RESERVOIR' : 'TOWER');
      break;
    }
  }

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
    industrial,
    pois,
    churches,
    squares,
  };
}

/** Is (x, y) inside convex polygon q [x0, y0, …]? */
function inConvex(q: number[], x: number, y: number): boolean {
  const n = q.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const ax = q[2 * i];
    const ay = q[2 * i + 1];
    const bx = q[(2 * i + 2) % q.length];
    const by = q[(2 * i + 3) % q.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign && Math.sign(c) !== sign) return false;
      sign = Math.sign(c);
    }
  }
  return true;
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = hash1(h ^ s.charCodeAt(i));
  return hash3(h, 0x7e57, 0x51e5);
}
