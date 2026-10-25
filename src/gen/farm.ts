import { rng } from '../lib/hash';
import { lerp, smoothstep } from '../lib/noise';
import { quadsOverlap, segPointDist, segQuadDist } from './buildings';
import { NODE } from './hydro';
import { nearestVertex, vertexPos, VSNAP } from './lattice';
import { MAX_GRADE, ROAD_T, ringDisc, type SegmentPath } from './roads';
import { FARM } from './settle';
import { lineDistance, MW_PLAN_CLEAR } from './motorway';
import { BUILD_STEEP, hashString, PLAN_EXTENT, ROAD_CLEAR, STREAM_A, type PlanInput, type TownPlan } from './town';

/**
 * Farmsteads — a farm's own small plan (as town.ts makes for larger settlements):
 * a pure function of the roads drawn near it and the fine terrain, so every chunk
 * draws it alike.
 *
 * The farmstead stands at the farm's vertex, in the widest open wedge between the ways
 * meeting there (past the end of a road that ends there, beside one that runs on). Its
 * form follows the ground:
 *  - steep ground: one or two small buildings, long sides along the contour;
 *  - middling ground (and where a larger form won't fit): a house and a barn
 *    joined in an L, now and then a shed beside them;
 *  - flat lowland ground: a farmyard — house and barns round a court, open towards
 *    the road or closed but for a gateway — or a looser group of house, barns,
 *    stables and sheds; either often with a machine shed beside it.
 * Larger farms often get a short dead-end track from the vertex into the fields.
 * A farm whose place lies in a lake, or where no house finds dry, gentle ground, is
 * left out.
 */

/** Mean slope (m/m) over the farmstead above which it is one or two small buildings (lowland → mountains). */
const STEEP_FARM = [0.16, 0.11];
/** …and below which a lowland farm may spread round a yard. */
const FLAT_FARM = 0.07;
/** Chance that a farm on flat ground gets a yard or a group (lowland → hills). */
const YARD_CHANCE = [0.85, 0.15];
/** The farmstead's front stands this far (m) past the end of its road (range). */
const OFF = [7, 11];
/** Large buildings (machine sheds, long barns) want gentle ground (m/m). */
const BIG_STEEP = 0.2;
/** Buildings may share walls: overlaps this small don't count (m). */
const TOUCH = 0.3;
/** Buildings keep this far (m) from lake nodes (the drawn shore reaches past the last one). */
const SHORE = 6;
/** Open wedges between the ways at the farm's vertex: alternatives to the widest if this wide (half-angle, rad) or this share of it. */
const WEDGE_MIN = 0.9;
const WEDGE_ALT = 0.75;
/** Tracks into the fields: only into a wedge this wide (half-angle, rad); chance per kind, length range (m), step (m). */
const TRACK_WEDGE = 0.95;
const TRACK_CHANCE: Record<Kind, number> = { small: 0, l: 0.35, yard: 0.75, group: 0.6 };
const TRACK_LEN: Record<Kind, [number, number]> = { small: [0, 0], l: [80, 200], yard: [120, 300], group: [100, 260] };
const TRACK_STEP = 10;
/** Shortest track kept (m). */
const TRACK_MIN = 50;
/** A track keeps this far (m) from buildings, from other ways, and from other ways' dead ends (other farms). */
const TRACK_CLEAR = [4, 20, 80];
/** Ground the track prefers (m/m): steeper costs quadratically. */
const TRACK_EASY = 0.08;

type Kind = 'small' | 'l' | 'yard' | 'group';

/** Debugging: forms chosen and placed, and why buildings were refused, summed over plans. */
export const farmStats: Record<string, number> = {};
const note = (k: string) => (farmStats[k] = (farmStats[k] ?? 0) + 1);

/** A building to place: candidate centres (first that fits), axis of its width, size (m). */
interface Part {
  alts: [number, number][];
  tx: number;
  ty: number;
  w: number;
  d: number;
  /** The farmstead needs it (the house). */
  need: boolean;
  steep: number;
  /** Kept this far (m) from the other buildings (0: may share walls). */
  gap: number;
}

/** Where the farmstead stands: the road's end, the direction away from the road (u), across it (v). */
interface Frame {
  ex: number;
  ey: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  off: number;
}

export function planFarm({ site, roads, patch: p, motorways = [] }: PlanInput): TownPlan {
  if (site.rank !== FARM) throw new Error('farm plans are for farms');
  const rand = rng(hashString(site.id));
  const R = site.R;
  const mount = smoothstep(0.35, 0.85, R);
  const extent = PLAN_EXTENT[FARM];

  // --- Terrain (as town.ts) ---------------------------------------------------------
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
  // Motorways count as water: no building or field track on them.
  const mwDist = lineDistance(motorways, MW_PLAN_CLEAR);
  const wet = (x: number, y: number) => {
    const k = node(x, y);
    return k < 0 || !Number.isNaN(p.lake[k]) || mwDist(x, y) < MW_PLAN_CLEAR;
  };
  /** Dry, off stream channels, and not right on a shore. */
  const dry = (x: number, y: number) => {
    if (wet(x, y) || wet(x + SHORE, y) || wet(x - SHORE, y) || wet(x, y + SHORE) || wet(x, y - SHORE)) return false;
    const k = node(x, y);
    return p.A[k] <= STREAM_A;
  };
  const slope = (x: number, y: number) => Math.hypot(zAt(x + 4, y) - zAt(x - 4, y), zAt(x, y + 4) - zAt(x, y - 4)) / 8;

  // --- Where the farmstead stands -------------------------------------------------------
  const sorted = [...roads].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const [vx, vy] = vertexPos(nearestVertex(site.x, site.y));
  const empty: TownPlan = { id: site.id, rank: FARM, x: vx, y: vy, streets: [], replaced: [], roads: [], frontage: [], buildings: new Float32Array(0), industrial: new Uint8Array(0), pois: [] };
  // A farm the fine terrain puts in a lake isn't there: the network can't see those
  // lakes, and its roads stop at the shore (a drowned vertex is snapped onto it).
  if (wet(vx, vy)) return note('in a lake'), empty;
  // The vertex as the drawn roads have it: snapped to gentler ground nearby. Ways end
  // there, or (a steep piece, drawn as one) pass through it.
  let ex = vx;
  let ey = vy;
  const reach = VSNAP * NODE * Math.SQRT2 + 2;
  let best = reach;
  for (const r of sorted)
    for (const k of [0, r.xy.length - 2]) {
      const d = Math.hypot(r.xy[k] - vx, r.xy[k + 1] - vy);
      if (d < best) {
        best = d;
        ex = r.xy[k];
        ey = r.xy[k + 1];
      }
    }
  if (best === reach)
    for (const r of sorted)
      for (let k = 2; k < r.xy.length - 2; k += 2) {
        const d = Math.hypot(r.xy[k] - vx, r.xy[k + 1] - vy);
        if (d < best) {
          best = d;
          ex = r.xy[k];
          ey = r.xy[k + 1];
        }
      }
  empty.x = ex;
  empty.y = ey;

  // The ways leaving it (farm road, links, tracks), by direction: towards their first
  // point a few metres out.
  const angs: number[] = [];
  for (const r of sorted) {
    const n = r.xy.length / 2;
    for (let k = 0; k < n; k++) {
      if (r.xy[2 * k] !== ex || r.xy[2 * k + 1] !== ey) continue;
      for (const step of [-1, 1]) {
        let m = k + step;
        while (m >= 0 && m < n && Math.hypot(r.xy[2 * m] - ex, r.xy[2 * m + 1] - ey) < 8) m += step;
        m = Math.max(0, Math.min(n - 1, m));
        if (m !== k) angs.push(Math.atan2(r.xy[2 * m + 1] - ey, r.xy[2 * m] - ex));
      }
    }
  }
  angs.sort((a, b) => a - b);
  // The farmstead faces into the open wedges between them, widest first (past the end
  // of a road that ends here, beside one that runs on): bisector and half-angle each.
  const wedges: [number, number][] = [];
  if (!angs.length) wedges.push([rand() * 2 * Math.PI, Math.PI]);
  else {
    const all = angs.map((a, i): [number, number] => {
      const next = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
      return [a + (next - a) / 2, (next - a) / 2];
    });
    all.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const wd of all) if (wd === all[0] || wd[1] >= Math.max(WEDGE_MIN, WEDGE_ALT * all[0][1])) wedges.push(wd);
  }
  const ux = Math.cos(wedges[0][0]);
  const uy = Math.sin(wedges[0][0]);
  const s0 = rand() < 0.5 ? 1 : -1;
  const off0 = lerp(OFF[0], OFF[1], rand());

  // Way pieces near the farm, for clearances; dead ends of other ways (other farms).
  const pieces: { ax: number; ay: number; bx: number; by: number; cls: number; atE: boolean }[] = [];
  const ends = new Map<string, number>();
  const endKey = (x: number, y: number) => `${x},${y}`;
  for (const r of sorted) {
    const n = r.xy.length;
    if (n < 4) continue;
    for (const k of [0, n - 2]) ends.set(endKey(r.xy[k], r.xy[k + 1]), (ends.get(endKey(r.xy[k], r.xy[k + 1])) ?? 0) + 1);
    let atE = false;
    for (let k = 0; k < n && !atE; k += 2) atE = r.xy[k] === ex && r.xy[k + 1] === ey;
    for (let k = 2; k < n; k += 2) {
      const ax = r.xy[k - 2];
      const ay = r.xy[k - 1];
      const bx = r.xy[k];
      const by = r.xy[k + 1];
      if (segPointDist(ax, ay, bx, by, ex, ey) > extent + 40) continue;
      pieces.push({ ax, ay, bx, by, cls: r.cls, atE });
    }
  }
  const deadEnds: [number, number][] = [];
  for (const [k, n] of ends) {
    if (n !== 1) continue;
    const [x, y] = k.split(',').map(Number);
    if (Math.hypot(x - ex, y - ey) > 1 && Math.hypot(x - ex, y - ey) < extent + TRACK_CLEAR[2]) deadEnds.push([x, y]);
  }

  // --- Form ----------------------------------------------------------------------
  // Mean slope over where the farmstead will stand.
  let g = 0;
  for (const a of [off0, off0 + 12, off0 + 24]) g += slope(ex + ux * a, ey + uy * a) / 3;
  let kind: Kind;
  if (g > lerp(STEEP_FARM[0], STEEP_FARM[1], mount)) kind = 'small';
  else if (g < FLAT_FARM && rand() < lerp(YARD_CHANCE[0], YARD_CHANCE[1], smoothstep(0.15, 0.6, R))) kind = rand() < 0.6 ? 'yard' : 'group';
  else kind = rand() < lerp(0.15, 0.5, mount) ? 'small' : 'l';
  const steep = lerp(BUILD_STEEP[0], BUILD_STEEP[1], mount);

  // Each form's sizes are drawn once; `parts` lays them out in a frame.
  const forms: Record<Kind, { parts: (f: Frame) => Part[]; yard?: [number, number] }> = {
    small: smallForm(rand, steep, zAt),
    l: lForm(rand, steep),
    yard: yardForm(rand, steep),
    group: groupForm(rand, steep),
  };
  const order: Kind[] = kind === 'small' ? ['small'] : kind === 'l' ? ['l', 'small'] : [kind, 'l', 'small'];

  // --- Placement ---------------------------------------------------------------------
  const islands = sorted.filter((r) => r.ring).map((r) => ringDisc(r.xy));
  const ok = (x: number, y: number, st: number) => {
    if (Math.hypot(x - site.x, y - site.y) > extent - 5) return note('ground: extent'), false;
    if (!dry(x, y)) return note('ground: water'), false;
    if (islands.some(([rx, ry, r]) => Math.hypot(x - rx, y - ry) < r)) return note('ground: roundabout'), false;
    if (slope(x, y) >= st) return note('ground: steep'), false;
    return true;
  };
  const clearOfWays = (q: number[]) => {
    for (const s of pieces) if (segQuadDist(s.ax, s.ay, s.bx, s.by, q) < ROAD_CLEAR[s.cls]) return false;
    return true;
  };
  const place = (parts: Part[]): { quads: number[][]; area: number } | undefined => {
    const quads: number[][] = [];
    let area = 0;
    for (const pt of parts) {
      let placed: number[] | undefined;
      for (const [mx, my] of pt.alts) {
        // As stored (Float32): tests then agree with what's drawn.
        const q = rect(mx, my, pt.tx, pt.ty, pt.w, pt.d).map(Math.fround);
        let fits = ok(mx, my, pt.steep);
        for (let c = 0; c < 8 && fits; c += 2) fits = ok(q[c], q[c + 1], pt.steep);
        for (let c = 0; c < 8 && fits && pt.w > 20; c += 2) fits = ok((q[c] + q[(c + 2) % 8]) / 2, (q[c + 1] + q[(c + 3) % 8]) / 2, pt.steep);
        if (!fits) {
          note(`${pt.need ? 'house' : 'other'}: ground`);
          continue;
        }
        if (!clearOfWays(q)) {
          note(`${pt.need ? 'house' : 'other'}: way`);
          continue;
        }
        if (quads.some((o) => quadsOverlap(q, o, pt.gap ? -pt.gap : TOUCH))) {
          note(`${pt.need ? 'house' : 'other'}: building`);
          continue;
        }
        placed = q;
        break;
      }
      if (placed) {
        quads.push(placed);
        area += pt.w * pt.d;
      } else if (pt.need) return undefined;
    }
    return { quads, area };
  };
  // In each open wedge, set back further and further, turned a little where the wedge
  // is wide, mirrored: the first frame placing the whole form wins, else the one
  // placing most of it.
  let chosen: { quads: number[][]; area: number; kind: Kind; f: Frame; wedge: [number, number] } | undefined;
  for (const k of order) {
    search: for (const wedge of wedges)
      for (const off of [off0, off0 + 8, off0 + 18, off0 + 30])
        for (const t of wedge[1] > 1.2 ? [0, 0.3, -0.3] : [0])
          for (const sd of [s0, -s0]) {
            const fux = Math.cos(wedge[0] + t);
            const fuy = Math.sin(wedge[0] + t);
            const f: Frame = { ex, ey, ux: fux, uy: fuy, vx: -fuy * sd, vy: fux * sd, off };
            const parts = forms[k].parts(f);
            const r = place(parts);
            if (r && (!chosen || r.area > chosen.area)) chosen = { ...r, kind: k, f, wedge };
            if (r && r.quads.length === parts.length) break search;
          }
    if (chosen) break;
  }
  note(`${Math.min(angs.length, 3)}${angs.length >= 3 ? '+' : ''} ways: ${kind} → ${chosen?.kind ?? 'NONE'}`);
  if (!chosen) return empty;
  const { quads, f } = chosen;

  // --- A track into the fields ----------------------------------------------------------
  const out: SegmentPath[] = [];
  const [bis, half] = chosen.wedge;
  if (half >= TRACK_WEDGE && rand() < TRACK_CHANCE[chosen.kind]) {
    const [l0, l1] = TRACK_LEN[chosen.kind];
    const target = lerp(l0, l1, rand());
    const base = Math.atan2(f.uy, f.ux);
    const turn = lerp(0.35, 0.95, rand());
    // Out along the front of the farmstead, then into the fields past its side.
    const walk = (ts: number) => {
      let hd = base + ts * Math.min(1.4, half - 0.45);
      const pref = base + ts * turn;
      const xy = [ex, ey];
      let x = ex;
      let y = ey;
      let len = 0;
      while (len < target) {
        let bc = Infinity;
        let bx = 0;
        let by = 0;
        let bh = 0;
        for (const dt of [-0.35, -0.17, 0, 0.17, 0.35]) {
          const hn = hd + dt;
          const nx = x + Math.cos(hn) * TRACK_STEP;
          const ny = y + Math.sin(hn) * TRACK_STEP;
          if (Math.hypot(nx - site.x, ny - site.y) > extent - 10) continue;
          // Into the fields of its wedge, not back along the ways.
          if (Math.abs(angDiff(hn, bis)) > half - 0.2) continue;
          if (!dry(nx, ny) || !dry((x + nx) / 2, (y + ny) / 2)) continue;
          const gr = Math.abs(zAt(nx, ny) - zAt(x, y)) / TRACK_STEP;
          if (gr > MAX_GRADE[ROAD_T]) continue;
          if (quads.some((q) => segQuadDist(x, y, nx, ny, q) < TRACK_CLEAR[0])) continue;
          // The ways meeting where it starts only once well away from them.
          if (pieces.some((s) => (!s.atE || len > 40) && segPointDist(s.ax, s.ay, s.bx, s.by, nx, ny) < TRACK_CLEAR[1])) continue;
          if (deadEnds.some(([dx, dy]) => Math.hypot(dx - nx, dy - ny) < TRACK_CLEAR[2])) continue;
          const c = 3 * (gr / TRACK_EASY) ** 2 + 0.8 * Math.abs(angDiff(hn, pref)) + 0.3 * Math.abs(dt);
          if (c < bc) {
            bc = c;
            bx = nx;
            by = ny;
            bh = hn;
          }
        }
        if (bc === Infinity) break;
        x = bx;
        y = by;
        hd = bh;
        xy.push(x, y);
        len += TRACK_STEP;
      }
      return { xy, len };
    };
    // Past one side of the farmstead, or the other if it gets further.
    const ts = rand() < 0.5 ? 1 : -1;
    let t = walk(ts);
    if (t.len < target) {
      const o = walk(-ts);
      if (o.len > t.len) t = o;
    }
    if (t.len >= TRACK_MIN) out.push({ key: `farm:${site.id}`, cls: ROAD_T, xy: Float32Array.from(t.xy) });
    note(t.len >= TRACK_MIN ? 'track' : 'track: too short');
  }

  // --- Output ------------------------------------------------------------------------
  // Built-up land (clears woods under the buildings): along each one's long axis, and the yard.
  const frontage: { depth: number; xy: Float32Array }[] = [];
  for (const q of quads) {
    const lw = Math.hypot(q[2] - q[0], q[3] - q[1]);
    const ld = Math.hypot(q[6] - q[0], q[7] - q[1]);
    const xy =
      lw >= ld
        ? [(q[0] + q[6]) / 2, (q[1] + q[7]) / 2, (q[2] + q[4]) / 2, (q[3] + q[5]) / 2]
        : [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2, (q[6] + q[4]) / 2, (q[7] + q[5]) / 2];
    frontage.push({ depth: Math.min(lw, ld) / 2 + 3, xy: Float32Array.from(xy) });
  }
  const yard = forms[chosen.kind].yard;
  if (yard) {
    const [depth, width] = yard;
    const ax = f.ex + f.ux * f.off;
    const ay = f.ey + f.uy * f.off;
    frontage.push({ depth: width / 2, xy: Float32Array.from([ax, ay, ax + f.ux * depth, ay + f.uy * depth]) });
  }
  return { ...empty, roads: out, frontage, buildings: Float32Array.from(quads.flat()), industrial: new Uint8Array(quads.length) };
}

/** Local frame → world: `a` m along u from the front, `b` m along v. */
const at = (f: Frame, a: number, b: number): [number, number] => [f.ex + f.ux * (f.off + a) + f.vx * b, f.ey + f.uy * (f.off + a) + f.vy * b];

/** One or two small buildings along the contour: a house, often a shed beside it. */
function smallForm(rand: () => number, steep: number, zAt: (x: number, y: number) => number) {
  const hw = lerp(8, 11, rand());
  const hd = lerp(6, 8, rand());
  const shed = rand() < 0.6;
  const sw = lerp(6, 10, rand());
  const sdp = lerp(5, 7, rand());
  const gap = lerp(3, 8, rand());
  const side = rand() < 0.5 ? 1 : -1;
  return {
    parts(f: Frame): Part[] {
      // The contour where the house will stand.
      const [px, py] = at(f, 8, 0);
      const gx = zAt(px + 8, py) - zAt(px - 8, py);
      const gy = zAt(px, py + 8) - zAt(px, py - 8);
      const gl = Math.hypot(gx, gy);
      const [tx, ty] = gl > 1e-6 ? [-gy / gl, gx / gl] : [f.vx, f.vy];
      // Set back by the house's reach towards the road.
      const reach = (Math.abs(tx * f.ux + ty * f.uy) * hw) / 2 + (Math.abs(-ty * f.ux + tx * f.uy) * hd) / 2;
      const [hx, hy] = at(f, reach, 0);
      const parts: Part[] = [{ alts: [[hx, hy]], tx, ty, w: hw, d: hd, need: true, steep, gap: 0 }];
      if (shed) {
        const s = hw / 2 + gap + sw / 2;
        parts.push({
          alts: [side, -side].map((k) => [hx + tx * s * k, hy + ty * s * k] as [number, number]),
          tx,
          ty,
          w: sw,
          d: sdp,
          need: false,
          steep,
          gap: gap - 0.5,
        });
      }
      return parts;
    },
  };
}

/** A house across the road's line and a barn off one end of it reaching back; now and then a shed. */
function lForm(rand: () => number, steep: number) {
  const hw = lerp(10, 13, rand());
  const hd = lerp(7, 9, rand());
  const bw = lerp(15, 22, rand());
  const bd = lerp(9, 11, rand());
  const shed = rand() < 0.35;
  const sw = lerp(6, 9, rand());
  const sdp = lerp(5, 7, rand());
  return {
    parts(f: Frame): Part[] {
      const bb = hw / 2 + bd / 2;
      const parts: Part[] = [
        { alts: [at(f, hd / 2, 0)], tx: f.vx, ty: f.vy, w: hw, d: hd, need: true, steep, gap: 0 },
        { alts: [at(f, bw / 2, bb)], tx: f.ux, ty: f.uy, w: bw, d: bd, need: false, steep, gap: 0 },
      ];
      if (shed)
        parts.push({
          alts: [at(f, bw + 5 + sdp / 2, bb), at(f, hd / 2, -(hw / 2 + 5 + sw / 2))],
          tx: f.vx,
          ty: f.vy,
          w: sw,
          d: sdp,
          need: false,
          steep,
          gap: 3,
        });
      return parts;
    },
  };
}

/**
 * A court: house and barn across its back, stables or barns down its sides, open
 * towards the road or closed by a front range but for a gateway; often a machine
 * shed beside it.
 */
function yardForm(rand: () => number, steep: number) {
  const X = lerp(24, 36, rand());
  const Y = lerp(26, 38, rand());
  const dB = lerp(9, 12, rand());
  const hw = lerp(12, 16, rand());
  const hd = lerp(8, 10, rand());
  const hs = rand() < 0.5 ? 1 : -1;
  const dW = lerp(8, 11, rand());
  const closed = rand() < 0.3;
  const gapW = !closed && rand() < 0.4 ? lerp(3, 5, rand()) : 0;
  const lw = (Y - dB - gapW) * (closed ? 1 : lerp(0.65, 1, rand()));
  const right = closed || rand() < 0.8;
  const dF = lerp(6, 8, rand());
  const gate = lerp(4.5, 7, rand());
  const gateOff = lerp(-3, 3, rand());
  const machine = rand() < 0.65;
  const mw = lerp(22, 36, rand());
  const md = lerp(12, 18, rand());
  const mAlong = rand() < 0.5;
  const mSide = rand() < 0.5 ? 1 : -1;
  // A small outbuilding apart (a bakehouse, a henhouse, a shed).
  const extra = rand() < 0.6;
  const xw = lerp(5, 8, rand());
  const xd = lerp(4, 6, rand());
  return {
    yard: [Y, X] as [number, number],
    parts(f: Frame): Part[] {
      const across = { tx: f.vx, ty: f.vy };
      const along = { tx: f.ux, ty: f.uy };
      const parts: Part[] = [
        // The house at one back corner, facing the court; the barn along the rest of the back.
        { alts: [at(f, Y - dB + hd / 2, hs * (X / 2 - hw / 2))], ...across, w: hw, d: hd, need: true, steep, gap: 0 },
      ];
      if (X - hw >= 10) parts.push({ alts: [at(f, Y - dB / 2, -hs * (hw / 2))], ...across, w: X - hw, d: dB, need: false, steep: BIG_STEEP, gap: 0 });
      if (lw >= 8)
        for (const k of right ? [1, -1] : [-hs]) {
          const a = Y - dB - gapW - lw / 2;
          parts.push({ alts: [at(f, a, k * (X / 2 - dW / 2))], ...along, w: lw, d: dW, need: false, steep: lw > 20 ? BIG_STEEP : steep, gap: 0 });
        }
      if (closed) {
        // The front range, between the wings, broken by the gateway.
        const l = X / 2 - dW;
        for (const [b0, b1] of [
          [-l, gateOff - gate / 2],
          [gateOff + gate / 2, l],
        ])
          if (b1 - b0 >= 5) parts.push({ alts: [at(f, dF / 2, (b0 + b1) / 2)], ...across, w: b1 - b0, d: dF, need: false, steep, gap: 0 });
      }
      if (machine) {
        const [ma, mb] = mAlong ? [mw / 2, md / 2] : [md / 2, mw / 2];
        parts.push({
          alts: [at(f, Y / 2, mSide * (X / 2 + 10 + mb)), at(f, Y + 10 + ma, 0), at(f, Y / 2, -mSide * (X / 2 + 10 + mb))],
          ...(mAlong ? along : across),
          w: mw,
          d: md,
          need: false,
          steep: BIG_STEEP,
          gap: 6,
        });
      }
      if (extra)
        parts.push({
          alts: [at(f, Y + 6 + xd / 2, -hs * (X / 4)), at(f, Y / 2, -mSide * (X / 2 + 6 + xw / 2)), at(f, -xd / 2 - 1, mSide * (X / 2 + 4))],
          ...across,
          w: xw,
          d: xd,
          need: false,
          steep,
          gap: 4,
        });
      return parts;
    },
  };
}

/** A looser group: the house near the road, two to four barns, stables and sheds about a yard. */
function groupForm(rand: () => number, steep: number) {
  const hw = lerp(11, 15, rand());
  const hd = lerp(8, 10, rand());
  const hb = lerp(-10, 10, rand());
  // Barns, stables, sheds, machine sheds (m).
  const kinds = [
    { w: [14, 26], d: [9, 13] },
    { w: [12, 20], d: [7, 10] },
    { w: [6, 10], d: [5, 7] },
    { w: [20, 32], d: [12, 16] },
  ];
  const n = 2 + Math.floor(rand() * 3);
  const others: { a: number; b: number; w: number; d: number; along: boolean; gap: number }[][] = [];
  for (let i = 0; i < n; i++) {
    const k = kinds[Math.floor(rand() * kinds.length)];
    const w = lerp(k.w[0], k.w[1], rand());
    const d = lerp(k.d[0], k.d[1], rand());
    const along = rand() < 0.5;
    const gap = lerp(4, 9, rand());
    const alts = [];
    for (let j = 0; j < 8; j++) alts.push({ a: lerp(hd + 4, 55, rand()), b: lerp(-32, 32, rand()), w, d, along, gap });
    others.push(alts);
  }
  return {
    parts(f: Frame): Part[] {
      const parts: Part[] = [{ alts: [at(f, hd / 2, hb)], tx: f.vx, ty: f.vy, w: hw, d: hd, need: true, steep, gap: 0 }];
      for (const alts of others) {
        const o = alts[0];
        parts.push({
          alts: alts.map((q) => at(f, q.a, q.b)),
          tx: o.along ? f.ux : f.vx,
          ty: o.along ? f.uy : f.vy,
          w: o.w,
          d: o.d,
          need: false,
          steep: o.w > 20 ? BIG_STEEP : steep,
          gap: o.gap,
        });
      }
      return parts;
    },
  };
}

/** Rectangle `w` along (tx, ty) by `d` across it, centred on (mx, my). */
function rect(mx: number, my: number, tx: number, ty: number, w: number, d: number): number[] {
  const hx = (tx * w) / 2;
  const hy = (ty * w) / 2;
  const nx = (-ty * d) / 2;
  const ny = (tx * d) / 2;
  return [mx - hx - nx, my - hy - ny, mx + hx - nx, my + hy - ny, mx + hx + nx, my + hy + ny, mx - hx + nx, my - hy + ny];
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
