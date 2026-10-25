import { gnoise, ND, smoothstep } from '../lib/noise';
import type { CoarseField } from './hydro';
import { lakesOf } from './lakes';
import { NET_CELL } from './roads';
import type { Lattice, SeedView } from './seeds';
import { HAMLET, type Rank, type Settlements, type Site, TOWN, VILLAGE } from './settle';
import type { Terrain } from './terrain';

/**
 * Motorways (experimental): long, gently curving dual carriageways that need lead
 * nowhere in particular. There are no cities to join, so a motorway is simply a
 * line through a large noise field (its zero level), kept where a second field (the
 * gate) allows it and out of the mountains; nothing far away is consulted.
 *
 * The line is found per fixed grid cell (MW_CELL) by marching squares on world-aligned
 * samples. Where it crosses a cell's border it has an **anchor**: a point and heading
 * that both cells sharing the border compute from the same samples. Each cell's stretch
 * of line between two anchors is a **piece**, routed on the coarse surface within a band
 * either side of the line (gentle grades, wide curves, off lakes and settlements) and
 * pinned to its anchors with their heading, so pieces join smoothly and each depends
 * only on its own cell (and the line a few cells either way). A motorway ends where the
 * gate closes at an anchor, or where the line turns too sharply to follow (near a saddle
 * of the field) or loops.
 */

/** Grid on which the line's anchors are found (m). */
export const MW_CELL = 4096;
/**
 * How far a piece may lie outside its own cell (m): its raw line keeps inside, towns
 * bend it by up to PUSH and the routing strays up to K × OFF (with a margin for the
 * curve through the routed points). A chunk is drawn once the pieces this near are known.
 */
export const MW_SPILL = 2500;
/** Line-field sample spacing (m): world-aligned, so neighbouring cells share their border samples. */
const SAMPLE = 64;
const NS = MW_CELL / SAMPLE;

/**
 * The line field: two 64 km noises on lattices offset from each other, so the lines
 * lie some 30–40 km apart and bend gently, with a little 32 and 16 km so they wander.
 * (Gradient noise is zero at its lattice points, so the zero line of one lattice's
 * noise threads them all and closes into rings round each; on lattices offset from
 * each other the zeros don't line up.)
 */
const LINE_S = [65536, 65536, 32768, 16384];
const SALT_LINE = [0x6d0a7c13, 0x3a92c5e1, 0x2f81e5b9, 0x4e6b0d27];
const LINE_W = [0.6, 0.6, 0.15, 0.04];
/** Lattice offsets (fractions of the spacing) of the line field's noises. */
const LINE_SHIFT = [
  [0.21, 0.37],
  [0.71, 0.87],
  [0.46, 0.12],
  [0.93, 0.58],
];
/** The gate: a motorway runs where 64 km noise is above GATE_MIN… */
const SALT_GATE = 0x1c4be027;
const GATE_MIN = -0.35;
/**
 * …less the region's penalty: fading out into the mountains, judged from the region
 * averaged over GATE_R_SPAN m around (regions change every 8–20 km: judged on the spot,
 * or from the hills up, the motorways were chopped into short stretches), and out of
 * alpine land on the spot (GATE_ALPINE).
 */
const GATE_R = [0.6, 0.8];
const GATE_R_SPAN = 6000;
const GATE_ALPINE = [0.76, 0.86];
const GATE_R_PENALTY = 2;
/** An anchor this near a saddle of the line field (|∇F| per km; typically ~0.025) is too ill-defined to hold the line. */
const MIN_GRAD = 0.004 / 1000;
/**
 * Towns bend the line away: within PUSH_R m of a town, its points move across the line,
 * away from the town's side, by up to PUSH m (smoothly, so neighbouring anchors move
 * alike). Villages don't: motorways pass close by them.
 */
const PUSH = 1000;
const PUSH_R = 4500;

/** The raw line may not turn tighter than this (m, over BASE_WINDOW of arc), or the piece is dropped. */
const BASE_RMIN = 700;
const BASE_WINDOW = 400;
/**
 * Nor may it turn by more than LOOP_TURN within LOOP_ARC m: small closed loops of the
 * line (round a weak extremum of the field) would be ring roads round nothing.
 */
const LOOP_TURN = (150 * Math.PI) / 180;
const LOOP_ARC = 10000;
/** Runs of motorway shorter than this (m) are dropped: stubs between two gaps. */
const MIN_RUN = 10000;

/**
 * Routing: samples every STEP m along the line, offsets of OFF m up to ±K·OFF from it.
 * (With 200 m steps, a change of one offset already turned tighter than MW_RMIN, so
 * the route never left the line.)
 */
const STEP = 400;
const OFF = 100;
const K = 12;
/** Near an anchor the offset may grow only as a circle of this radius leaves the line's tangent. */
const RAMP_R = 1500;
/** On the inside of a bend, offsets keep under this share of the line's radius (normals would fold). */
const FOLD = 0.6;
/**
 * Tightest curve (m), and the cost of a turn (m per rad²). The search aims wider
 * (RMIN_AIM, judged from three points 400 m apart): the curve through its points bends
 * a little tighter than they do.
 */
export const MW_RMIN = 1200;
const RMIN_AIM = 1.3 * MW_RMIN;
const TURN_W = 2500;
const TIGHT = 1e5;
/** Easy grade, the slope penalty's weight and cap (× length). */
export const MW_GRADE = 0.04;
const GRADE_W = 3;
const GRADE_CAP = 30;
/** Cost per metre of crossing a hillside: weight × (slope / SIDE_SLOPE)². */
const SIDE_W = 1.5;
const SIDE_SLOPE = 0.15;
/** Per point in a coarse lake (effectively forbidden). */
const LAKE_COST = 20000;
/** Bridges: much more drainage under a step's middle than at its ends (km², m). */
const BRIDGE_AREA = 1;
const BRIDGE_COST = 150;
/** Keep-off from settlement centres: radius (m) and weight per metre at the centre, by rank. */
const SITE_CLEAR = [1500, 600, 250];
const SITE_W = [25, 12, 6];
/** A small cost per metre for straying from the line (per BAND of offset), so it keeps its character. */
const STRAY_W = 0.08;
const BAND = K * OFF;
/** Passes and strength of the smoothing of the routed points. */
const SMOOTH_PASSES = 8;
const SMOOTH = 0.5;
/** Output: sampled every OUT_STEP m. */
const OUT_STEP = 25;

export interface MotorwayAnchor {
  /** Id of the sample edge it lies on (shared by both cells). */
  id: string;
  /** Where the line crosses the border (raw), or where the motorway does (placed: slid across it). */
  x: number;
  y: number;
  /** Heading (unit), with the line field positive on its left. */
  tx: number;
  ty: number;
}

export interface MotorwayPiece {
  /** Its anchors' ids, in its direction of travel. */
  key: string;
  a: MotorwayAnchor;
  b: MotorwayAnchor;
  /** Routed centre line, world metres [x0, y0, …], every OUT_STEP m or so, anchor to anchor. */
  xy: Float64Array;
  /** The raw line it was routed along (dev; not carried by net cells). */
  base?: number[];
  /** The motorway ends at a (or b): no piece continues it there. */
  endA: boolean;
  endB: boolean;
}

interface RawPiece {
  a: MotorwayAnchor;
  b: MotorwayAnchor;
  base: number[];
  /** Raw line too sharp to follow. */
  sharp: boolean;
}

export class Motorways {
  private readonly l64k: Lattice;
  private readonly lineLat: Lattice[];
  private readonly raw = new Map<string, RawPiece[]>();
  private readonly routed = new Map<string, MotorwayPiece[]>();
  private readonly active = new Map<string, string>();
  private readonly bentAnchors = new Map<string, MotorwayAnchor>();
  private readonly loopy = new Map<string, boolean>();
  /** Pieces no route was found for (drawn along their raw line; dev). */
  unrouted = 0;

  constructor(
    private readonly field: CoarseField,
    private readonly terrain: Terrain,
    private readonly set: Settlements,
    view: SeedView,
  ) {
    this.l64k = view.coarse(65536);
    this.lineLat = LINE_S.map((S, k) => view.shifted(S, LINE_SHIFT[k][0] * S, LINE_SHIFT[k][1] * S, true));
  }

  /** The line field at (x, y); its gradient in `g` if given. */
  line(x: number, y: number, g?: number[]): number {
    let f = 0;
    let gx = 0;
    let gy = 0;
    for (let k = 0; k < LINE_S.length; k++) {
      f += LINE_W[k] * gnoise(this.lineLat[k], SALT_LINE[k], x, y);
      gx += LINE_W[k] * ND[0];
      gy += LINE_W[k] * ND[1];
    }
    if (g) {
      g[0] = gx;
      g[1] = gy;
    }
    // Never exactly zero, so every crossing lies strictly inside a sample edge.
    return f === 0 ? 1e-12 : f;
  }

  /** The gate at (x, y): a motorway may run where this is positive. */
  gate(x: number, y: number): number {
    const R = this.terrain.region(x, y);
    const pen = Math.max(smoothstep(GATE_R[0], GATE_R[1], this.region(x, y)), smoothstep(GATE_ALPINE[0], GATE_ALPINE[1], R));
    return gnoise(this.l64k, SALT_GATE, x, y) - GATE_MIN - GATE_R_PENALTY * pen;
  }

  /** The region field averaged over GATE_R_SPAN around (x, y): the spot and a ring of 8. */
  private region(x: number, y: number): number {
    let R = this.terrain.region(x, y);
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      R += this.terrain.region(x + GATE_R_SPAN * Math.cos(a), y + GATE_R_SPAN * Math.sin(a));
    }
    return R / 9;
  }

  /** The pieces a net cell carries: those of the motorway cells inside it (without their raw lines). */
  netCellPieces(gx: number, gy: number): MotorwayPiece[] {
    const n = NET_CELL / MW_CELL;
    const out: MotorwayPiece[] = [];
    for (let cj = gy * n; cj < (gy + 1) * n; cj++)
      for (let ci = gx * n; ci < (gx + 1) * n; ci++) for (const p of this.cellPieces(ci, cj)) out.push({ ...p, base: undefined });
    return out;
  }

  /** The pieces of every cell overlapping the rectangle. */
  piecesIn(x0: number, y0: number, x1: number, y1: number): MotorwayPiece[] {
    const out: MotorwayPiece[] = [];
    for (let cj = Math.floor(y0 / MW_CELL); cj <= Math.floor(y1 / MW_CELL); cj++)
      for (let ci = Math.floor(x0 / MW_CELL); ci <= Math.floor(x1 / MW_CELL); ci++) out.push(...this.cellPieces(ci, cj));
    return out;
  }

  /** The raw pieces of a cell, for dev views: their line, and why each is dropped ('' if kept). */
  rawIn(ci: number, cj: number): { base: number[]; why: string }[] {
    return this.rawPieces(ci, cj).map((p) => ({ base: p.base, why: this.dropped(p) }));
  }

  /** The cell's routed pieces. */
  cellPieces(ci: number, cj: number): MotorwayPiece[] {
    const k = `${ci},${cj}`;
    let hit = this.routed.get(k);
    if (hit) return hit;
    hit = [];
    for (const p of this.rawPieces(ci, cj)) {
      if (!this.keeps(p)) continue;
      hit.push({
        key: `${p.a.id}|${p.b.id}`,
        a: this.placed(p.a),
        b: this.placed(p.b),
        xy: this.route(p),
        base: p.base,
        endA: !this.continues(p.a, ci, cj),
        endB: !this.continues(p.b, ci, cj),
      });
    }
    this.routed.set(k, hit);
    return hit;
  }

  private keeps(p: RawPiece): boolean {
    return this.dropped(p) === '';
  }

  /**
   * Why a raw piece is dropped: 'sharp', 'loop', why one of its anchors is inactive, or
   * 'stub' (its run is shorter than MIN_RUN); '' if it is kept.
   */
  private dropped(p: RawPiece): string {
    return this.lineDropped(p) || (this.runLength(p) < MIN_RUN ? 'stub' : '');
  }

  private lineDropped(p: RawPiece): string {
    return p.sharp ? 'sharp' : this.loops(p) ? 'loop' : this.inactive(p.a) || this.inactive(p.b);
  }

  /**
   * Length of the run of pieces (not otherwise dropped) the piece belongs to, as far as
   * MIN_RUN: every piece of a shorter run sees all of it, so they are dropped together.
   */
  private runLength(p: RawPiece): number {
    let L = polyLength(p.base);
    for (const forward of [true, false]) {
      let at = forward ? p.b : p.a;
      for (let guard = 0; guard < 32 && L < MIN_RUN; guard++) {
        const q = this.next(at.id, forward);
        if (!q || this.lineDropped(q)) break;
        L += polyLength(q.base);
        at = forward ? q.b : q.a;
      }
    }
    return L;
  }

  /** The raw piece leaving anchor `id` (forwards), or arriving at it (backwards). */
  private next(id: string, forward: boolean): RawPiece | undefined {
    return cellsOf(id)
      .flatMap(([ci, cj]) => this.rawPieces(ci, cj))
      .find((q) => (forward ? q.a.id : q.b.id) === id);
  }

  /** Does the line turn by more than LOOP_TURN within LOOP_ARC m anywhere along the piece? */
  private loops(p: RawPiece): boolean {
    const k = `${p.a.id}|${p.b.id}`;
    let hit = this.loopy.get(k);
    if (hit !== undefined) return hit;
    // The piece and LOOP_ARC / 2 of the line either side, every ~100 m, with unwrapped headings.
    const back = this.walk(p.a, false, LOOP_ARC / 2);
    const line: number[] = [];
    for (let q = back.length - 2; q >= 0; q -= 2) line.push(back[q], back[q + 1]);
    line.push(...p.base, ...this.walk(p.b, true, LOOP_ARC / 2));
    const pts = resample(line, 100);
    const s: number[] = [];
    const th: number[] = [];
    let acc = 0;
    for (let q = 2; q < pts.length; q += 2) {
      const dx = pts[q] - pts[q - 2];
      const dy = pts[q + 1] - pts[q - 1];
      let a = Math.atan2(dy, dx);
      if (th.length) a += 2 * Math.PI * Math.round((th[th.length - 1] - a) / (2 * Math.PI));
      th.push(a);
      acc += Math.hypot(dx, dy);
      s.push(acc);
    }
    hit = false;
    for (let i = 0, j = 0; i < th.length && !hit; i++) {
      while (j < th.length && s[j] - s[i] <= LOOP_ARC) j++;
      let lo = Infinity;
      let hi = -Infinity;
      for (let q = i; q < j; q++) {
        lo = Math.min(lo, th[q]);
        hi = Math.max(hi, th[q]);
      }
      hit = hi - lo > LOOP_TURN;
    }
    this.loopy.set(k, hit);
    return hit;
  }

  /** The raw line beyond anchor `an` (forwards, or backwards from it), as far as `arc` m or so: points leaving it. */
  private walk(an: MotorwayAnchor, forward: boolean, arc: number): number[] {
    const out: number[] = [];
    let at = an;
    let L = 0;
    for (let guard = 0; guard < 32 && L < arc; guard++) {
      const p = this.next(at.id, forward);
      if (!p) break;
      if (forward) out.push(...p.base.slice(2));
      else for (let q = p.base.length - 4; q >= 0; q -= 2) out.push(p.base[q], p.base[q + 1]);
      L += polyLength(p.base);
      at = forward ? p.b : p.a;
    }
    return out;
  }

  /** Does a kept piece of the cell across anchor `an` (from cell ci, cj) continue the line? */
  private continues(an: MotorwayAnchor, ci: number, cj: number): boolean {
    const [oi, oj] = otherCell(an.id, ci, cj);
    return this.rawPieces(oi, oj).some((p) => (p.a.id === an.id || p.b.id === an.id) && this.keeps(p));
  }

  /**
   * Why an anchor can't hold the line ('saddle', 'gate', 'alpine'), or '' where it can.
   * An anchor the gate closes alone, its neighbours along the line both open, holds it
   * anyway: the line skimming the gate's edge left short gaps.
   */
  private inactive(an: MotorwayAnchor): string {
    let hit = this.active.get(an.id);
    if (hit !== undefined) return hit;
    const g = [0, 0];
    this.line(an.x, an.y, g);
    hit = Math.hypot(g[0], g[1]) < MIN_GRAD ? 'saddle' : this.closed(an);
    if (hit !== 'saddle' && hit !== '') {
      // Its pieces in the two cells sharing its border, and their other ends.
      const nb = cellsOf(an.id).map(([ci, cj]) => this.rawPieces(ci, cj).find((p) => p.a.id === an.id || p.b.id === an.id));
      if (nb.every((p) => p && !p.sharp && !this.loops(p) && this.closed(p.a.id === an.id ? p.b : p.a) === '')) hit = '';
    }
    this.active.set(an.id, hit);
    return hit;
  }

  /** Whether the gate closes an anchor ('gate', or 'alpine' for the region), or '' if it is open. */
  private closed(an: MotorwayAnchor): string {
    if (this.gate(an.x, an.y) > 0) return '';
    return gnoise(this.l64k, SALT_GATE, an.x, an.y) <= GATE_MIN ? 'gate' : 'alpine';
  }

  /** Towns whose push reaches the rectangle. */
  private pushers(x0: number, y0: number, x1: number, y1: number): Site[] {
    return this.set.sitesIn(TOWN, x0 - PUSH_R, y0 - PUSH_R, x1 + PUSH_R, y1 + PUSH_R);
  }

  /** A point of the line, bent away from the towns. */
  private bend(x: number, y: number, towns: Site[]): [number, number] {
    let dx = 0;
    let dy = 0;
    let g: number[] | undefined;
    for (const t of towns) {
      const d = Math.hypot(x - t.x, y - t.y);
      if (d >= PUSH_R) continue;
      if (!g) {
        g = [0, 0];
        this.line(x, y, g);
        const n = Math.hypot(g[0], g[1]) || 1;
        g[0] /= n;
        g[1] /= n;
      }
      // Across the line (along the field's gradient), away from the town's side.
      const u = d / PUSH_R;
      const m = (this.line(t.x, t.y) > 0 ? -PUSH : PUSH) * (1 - u * u) ** 2;
      dx += m * g[0];
      dy += m * g[1];
    }
    return [x + dx, y + dy];
  }

  /** A raw line bent away from the towns. */
  private bentLine(xy: number[]): number[] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let q = 0; q < xy.length; q += 2) {
      x0 = Math.min(x0, xy[q]); x1 = Math.max(x1, xy[q]);
      y0 = Math.min(y0, xy[q + 1]); y1 = Math.max(y1, xy[q + 1]);
    }
    const towns = this.pushers(x0, y0, x1, y1);
    if (!towns.length) return xy;
    const out: number[] = [];
    for (let q = 0; q < xy.length; q += 2) out.push(...this.bend(xy[q], xy[q + 1], towns));
    return out;
  }

  /** An anchor bent away from the towns, its heading with it. */
  private bent(an: MotorwayAnchor): MotorwayAnchor {
    let hit = this.bentAnchors.get(an.id);
    if (hit) return hit;
    const towns = this.pushers(an.x, an.y, an.x, an.y);
    const e = 5;
    const [x, y] = this.bend(an.x, an.y, towns);
    const [fx, fy] = this.bend(an.x + e * an.tx, an.y + e * an.ty, towns);
    const [bx, by] = this.bend(an.x - e * an.tx, an.y - e * an.ty, towns);
    const n = Math.hypot(fx - bx, fy - by) || 1;
    hit = { id: an.id, x, y, tx: (fx - bx) / n, ty: (fy - by) / n };
    this.bentAnchors.set(an.id, hit);
    return hit;
  }

  /**
   * The anchor where the motorway crosses its border: bent away from towns. (Where it
   * lies in a lake, the motorway bridges it: anchors slid out of the water made the
   * pieces between them weave.)
   */
  private placed(raw: MotorwayAnchor): MotorwayAnchor {
    return this.bent(raw);
  }

  /** Towns, villages and hamlets within the rectangle grown by their keep-off radius, by rank. */
  private sitesNear(x0: number, y0: number, x1: number, y1: number): Site[][] {
    return [TOWN, VILLAGE, HAMLET].map((r) => {
      const m = SITE_CLEAR[r];
      return this.set.sitesIn(r as Rank, x0 - m, y0 - m, x1 + m, y1 + m);
    });
  }

  /** Cost of the motorway passing (x, y), for h m of its length: hillside, lake, settlements. */
  private pointCost(x: number, y: number, h: number, sites: Site[][]): number {
    const field = this.field;
    const d = 128;
    const slope = Math.hypot(field.z(x + d, y) - field.z(x - d, y), field.z(x, y + d) - field.z(x, y - d)) / (2 * d);
    let c = h * SIDE_W * (slope / SIDE_SLOPE) ** 2;
    if (lakesOf(field).wet(x, y)) c += LAKE_COST;
    for (let r = 0; r < 3; r++)
      for (const st of sites[r]) {
        const ds = Math.hypot(st.x - x, st.y - y);
        if (ds < SITE_CLEAR[r]) c += h * SITE_W[r] * (1 - ds / SITE_CLEAR[r]) ** 2;
      }
    return c;
  }

  /** The line through a cell, by marching squares: one raw piece per stretch from border to border. */
  private rawPieces(ci: number, cj: number): RawPiece[] {
    const k = `${ci},${cj}`;
    const hit = this.raw.get(k);
    if (hit) return hit;
    const gi0 = ci * NS;
    const gj0 = cj * NS;
    const W = NS + 1;
    const f = new Float64Array(W * W);
    for (let j = 0; j <= NS; j++) for (let i = 0; i <= NS; i++) f[j * W + i] = this.line((gi0 + i) * SAMPLE, (gj0 + j) * SAMPLE);
    // Crossings by sample edge: 'h' from sample (gi, gj) to (gi + 1, gj), 'v' to (gi, gj + 1);
    // always interpolated from the lower sample, so both cells get the same point.
    const pts = new Map<string, [number, number]>();
    const crossing = (h: boolean, i: number, j: number): string => {
      const id = `${h ? 'h' : 'v'}${gi0 + i},${gj0 + j}`;
      if (!pts.has(id)) {
        const f0 = f[j * W + i];
        const f1 = h ? f[j * W + i + 1] : f[(j + 1) * W + i];
        const t = f0 / (f0 - f1);
        pts.set(id, [(gi0 + i + (h ? t : 0)) * SAMPLE, (gj0 + j + (h ? 0 : t)) * SAMPLE]);
      }
      return id;
    };
    const links = new Map<string, string[]>();
    const link = (p: string, q: string) => {
      if (!links.has(p)) links.set(p, []);
      if (!links.has(q)) links.set(q, []);
      links.get(p)!.push(q);
      links.get(q)!.push(p);
    };
    for (let j = 0; j < NS; j++)
      for (let i = 0; i < NS; i++) {
        const f00 = f[j * W + i];
        const f10 = f[j * W + i + 1];
        const f01 = f[(j + 1) * W + i];
        const f11 = f[(j + 1) * W + i + 1];
        const bottom = f00 > 0 !== f10 > 0 ? crossing(true, i, j) : null;
        const top = f01 > 0 !== f11 > 0 ? crossing(true, i, j + 1) : null;
        const left = f00 > 0 !== f01 > 0 ? crossing(false, i, j) : null;
        const right = f10 > 0 !== f11 > 0 ? crossing(false, i + 1, j) : null;
        const es = [bottom, right, top, left].filter((e): e is string => e !== null);
        if (es.length === 2) link(es[0], es[1]);
        else if (es.length === 4) {
          // Saddle: the centre's sign decides which corners the line cuts off.
          if (f00 + f10 + f01 + f11 > 0 === f00 > 0) {
            link(bottom!, right!);
            link(left!, top!);
          } else {
            link(bottom!, left!);
            link(right!, top!);
          }
        }
      }
    const onBorder = (id: string) => {
      const [gi, gj] = id.slice(1).split(',').map(Number);
      return id[0] === 'h' ? gj === gj0 || gj === gj0 + NS : gi === gi0 || gi === gi0 + NS;
    };
    const out: RawPiece[] = [];
    const seen = new Set<string>();
    // Ids in a fixed order, so every worker builds the same pieces in the same order.
    for (const start of [...links.keys()].filter(onBorder).sort()) {
      if (seen.has(start)) continue;
      const chain = [start];
      seen.add(start);
      for (;;) {
        const next = links.get(chain[chain.length - 1])!.find((q) => !seen.has(q));
        if (next === undefined) break;
        chain.push(next);
        seen.add(next);
      }
      const end = chain[chain.length - 1];
      if (chain.length < 2 || !onBorder(end)) continue;
      let a = this.anchor(start, pts.get(start)!);
      let b = this.anchor(end, pts.get(end)!);
      let base = chain.flatMap((id) => pts.get(id)!);
      // Travel with the field positive on the left (the anchor's heading).
      if ((base[2] - base[0]) * a.tx + (base[3] - base[1]) * a.ty < 0) {
        [a, b] = [b, a];
        const r: number[] = [];
        for (let q = base.length - 2; q >= 0; q -= 2) r.push(base[q], base[q + 1]);
        base = r;
      }
      out.push({ a, b, base, sharp: tightestRadius(base) < BASE_RMIN });
    }
    this.raw.set(k, out);
    return out;
  }

  private anchor(id: string, p: [number, number]): MotorwayAnchor {
    const g = [0, 0];
    this.line(p[0], p[1], g);
    const n = Math.hypot(g[0], g[1]) || 1;
    return { id, x: p[0], y: p[1], tx: g[1] / n, ty: -g[0] / n };
  }

  /** Routes a piece on the coarse surface, within the band either side of its raw line. */
  private route(p: RawPiece): Float64Array {
    const field = this.field;
    const A = this.placed(p.a);
    const Bn = this.placed(p.b);
    // The line, bent away from towns, resampled every ~STEP m, with normals (to the left).
    const line = this.bentLine(p.base);
    const B = resample(line, STEP);
    const n = B.length / 2 - 1;
    const L = polyLength(line);
    const h = L / n;
    if (n === 1) return hermite([A.x, A.y, Bn.x, Bn.y], A, Bn, h);
    const nx: number[] = [];
    const ny: number[] = [];
    for (let k = 0; k <= n; k++) {
      let dx: number;
      let dy: number;
      if (k === 0) [dx, dy] = [A.tx, A.ty];
      else if (k === n) [dx, dy] = [Bn.tx, Bn.ty];
      else [dx, dy] = [B[2 * k + 2] - B[2 * k - 2], B[2 * k + 3] - B[2 * k - 1]];
      const d = Math.hypot(dx, dy) || 1;
      nx.push(-dy / d);
      ny.push(dx / d);
    }
    const O = 2 * K + 1;
    // Allowed offsets per sample: the ramp from either anchor, the band, and no folding inside bends.
    const allowed = (k: number, o: number): boolean => {
      if (k === 0 || k === n) return o === K;
      const off = (o - K) * OFF;
      const sa = k * h;
      const sb = (n - k) * h;
      if (Math.abs(off) > Math.min(sa * sa, sb * sb) / (2 * RAMP_R)) return false;
      // Signed curvature (left positive) from the turn at k.
      const ax = B[2 * k] - B[2 * k - 2];
      const ay = B[2 * k + 1] - B[2 * k - 1];
      const bx = B[2 * k + 2] - B[2 * k];
      const by = B[2 * k + 3] - B[2 * k + 1];
      const kap = Math.atan2(ax * by - ay * bx, ax * bx + ay * by) / h;
      return off * kap < FOLD;
    };
    const px = new Float64Array((n + 1) * O);
    const py = new Float64Array((n + 1) * O);
    const pz = new Float64Array((n + 1) * O);
    const pc = new Float64Array((n + 1) * O).fill(Infinity);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let q = 0; q < B.length; q += 2) {
      x0 = Math.min(x0, B[q]); x1 = Math.max(x1, B[q]);
      y0 = Math.min(y0, B[q + 1]); y1 = Math.max(y1, B[q + 1]);
    }
    const sites = this.sitesNear(x0 - BAND, y0 - BAND, x1 + BAND, y1 + BAND);
    for (let k = 0; k <= n; k++)
      for (let o = 0; o < O; o++) {
        if (!allowed(k, o)) continue;
        const s = k * O + o;
        const x = B[2 * k] + (o - K) * OFF * nx[k];
        const y = B[2 * k + 1] + (o - K) * OFF * ny[k];
        px[s] = x;
        py[s] = y;
        pz[s] = field.z(x, y);
        pc[s] = this.pointCost(x, y, h, sites) + h * STRAY_W * (Math.abs(o - K) / K);
      }
    // Step cost between offset o at k−1 and q at k: length, grade, a bridge.
    const stepCost = (k: number, o: number, q: number): number => {
      const sa = (k - 1) * O + o;
      const sb = k * O + q;
      const len = Math.hypot(px[sb] - px[sa], py[sb] - py[sa]);
      const g = Math.abs(pz[sb] - pz[sa]) / Math.max(1, len);
      let c = len * Math.min(GRADE_CAP, 1 + GRADE_W * (g / MW_GRADE) ** 2);
      const am = field.area((px[sa] + px[sb]) / 2, (py[sa] + py[sb]) / 2);
      if (am > BRIDGE_AREA && am > 2 * Math.max(field.area(px[sa], py[sa]), field.area(px[sb], py[sb]))) c += BRIDGE_COST;
      return c;
    };
    // Turn at the middle of three points: its cost, and a heavy one where the curve is tighter than MW_RMIN.
    const turnCost = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number => {
      const ax = x1 - x0, ay = y1 - y0, bx = x2 - x1, by = y2 - y1;
      const th = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      const r = (Math.hypot(ax, ay) + Math.hypot(bx, by)) / 2 / Math.max(th, 1e-9);
      return TURN_W * th * th + (r < RMIN_AIM ? TIGHT * (RMIN_AIM / r - 1) : 0);
    };
    // Virtual points one step beyond each anchor, along its heading: the anchors' headings are kept.
    const vax = A.x - A.tx * h, vay = A.y - A.ty * h;
    const vbx = Bn.x + Bn.tx * h, vby = Bn.y + Bn.ty * h;
    // DP over (offset at k−1, offset at k).
    let cost = new Float64Array(O * O).fill(Infinity);
    const back: Int8Array[] = [];
    {
      for (let q = 0; q < O; q++) {
        if (pc[O + q] === Infinity) continue;
        cost[K * O + q] = pc[O + q] + stepCost(1, K, q) + turnCost(vax, vay, px[K], py[K], px[O + q], py[O + q]);
      }
    }
    for (let k = 1; k < n; k++) {
      const next = new Float64Array(O * O).fill(Infinity);
      const bk = new Int8Array(O * O).fill(-1);
      for (let o = 0; o < O; o++)
        for (let q = 0; q < O; q++) {
          const c0 = cost[o * O + q];
          if (c0 === Infinity) continue;
          const sa = (k - 1) * O + o;
          const sb = k * O + q;
          for (let m = 0; m < O; m++) {
            const sc = (k + 1) * O + m;
            if (pc[sc] === Infinity) continue;
            let c = c0 + pc[sc] + stepCost(k + 1, q, m) + turnCost(px[sa], py[sa], px[sb], py[sb], px[sc], py[sc]);
            if (k + 1 === n) c += turnCost(px[sb], py[sb], px[sc], py[sc], vbx, vby);
            if (c < next[q * O + m]) {
              next[q * O + m] = c;
              bk[q * O + m] = o;
            }
          }
        }
      back.push(bk);
      cost = next;
    }
    // Best final state (the anchor's offset at n), then back.
    let best = -1;
    for (let o = 0; o < O; o++) if (best < 0 || cost[o * O + K] < cost[best * O + K]) best = o;
    if (cost[best * O + K] === Infinity) {
      this.unrouted++;
      const Q = [...B];
      [Q[0], Q[1], Q[2 * n], Q[2 * n + 1]] = [A.x, A.y, Bn.x, Bn.y];
      return hermite(Q, A, Bn, h);
    }
    const offs = new Array<number>(n + 1);
    offs[n] = K;
    offs[n - 1] = best;
    for (let k = n - 1; k >= 1; k--) offs[k - 1] = back[k - 1][offs[k] * O + offs[k + 1]];
    const Q: number[] = [];
    for (let k = 0; k <= n; k++) Q.push(px[k * O + offs[k]], py[k * O + offs[k]]);
    // Even out the turns (the search allows each up to the limit, and a curve through
    // such points bunches them), keeping the anchors and their headings.
    for (let pass = 0; pass < SMOOTH_PASSES; pass++)
      for (let k = 1; k < n; k++) {
        let tx = (Q[2 * k - 2] + Q[2 * k + 2]) / 2;
        let ty = (Q[2 * k - 1] + Q[2 * k + 3]) / 2;
        // Next to an anchor, also towards its heading (a step on from the anchor).
        if (k === 1) {
          tx = (tx + 2 * Q[0] - vax) / 2;
          ty = (ty + 2 * Q[1] - vay) / 2;
        }
        if (k === n - 1) {
          tx = (tx + 2 * Q[2 * n] - vbx) / 2;
          ty = (ty + 2 * Q[2 * n + 1] - vby) / 2;
        }
        Q[2 * k] += SMOOTH * (tx - Q[2 * k]);
        Q[2 * k + 1] += SMOOTH * (ty - Q[2 * k + 1]);
      }
    return hermite(Q, A, Bn, h);
  }
}

/** The two cells sharing the border sample edge `id`. */
function cellsOf(id: string): [number, number][] {
  const [gi, gj] = id.slice(1).split(',').map(Number);
  if (id[0] === 'h') {
    const ci = Math.floor(gi / NS);
    return [[ci, gj / NS - 1], [ci, gj / NS]];
  }
  const cj = Math.floor(gj / NS);
  return [[gi / NS - 1, cj], [gi / NS, cj]];
}

/** The cell on the other side of the border sample edge `id`, seen from cell (ci, cj). */
function otherCell(id: string, ci: number, cj: number): [number, number] {
  const [gi, gj] = id.slice(1).split(',').map(Number);
  if (id[0] === 'h') {
    const bj = gj / NS; // border row between cells bj − 1 and bj
    return [ci, bj === cj ? cj - 1 : cj + 1];
  }
  const bi = gi / NS;
  return [bi === ci ? ci - 1 : ci + 1, cj];
}

function polyLength(xy: ArrayLike<number>): number {
  let L = 0;
  for (let q = 2; q < xy.length; q += 2) L += Math.hypot(xy[q] - xy[q - 2], xy[q + 1] - xy[q - 1]);
  return L;
}

/** Polyline resampled at equal arc steps of about `step`, ends kept. */
function resample(xy: number[], step: number): number[] {
  const L = polyLength(xy);
  const n = Math.max(1, Math.round(L / step));
  const h = L / n;
  const out = [xy[0], xy[1]];
  let q = 2;
  let acc = 0; // arc length at point q − 2
  for (let k = 1; k < n; k++) {
    const s = k * h;
    for (;;) {
      const seg = Math.hypot(xy[q] - xy[q - 2], xy[q + 1] - xy[q - 1]);
      if (acc + seg >= s || q + 2 >= xy.length) {
        const t = seg > 0 ? (s - acc) / seg : 0;
        out.push(xy[q - 2] + t * (xy[q] - xy[q - 2]), xy[q - 1] + t * (xy[q + 1] - xy[q - 1]));
        break;
      }
      acc += seg;
      q += 2;
    }
  }
  out.push(xy[xy.length - 2], xy[xy.length - 1]);
  return out;
}

/** Tightest radius of a polyline (m), measured as the turn over BASE_WINDOW of arc. */
export function tightestRadius(xy: ArrayLike<number>, window = BASE_WINDOW): number {
  const pts = resample(Array.from(xy), 25);
  const n = pts.length / 2;
  const w = Math.max(1, Math.round(window / 25 / 2));
  let rmin = Infinity;
  for (let k = w; k + w < n; k++) {
    const ax = pts[2 * k] - pts[2 * (k - w)];
    const ay = pts[2 * k + 1] - pts[2 * (k - w) + 1];
    const bx = pts[2 * (k + w)] - pts[2 * k];
    const by = pts[2 * (k + w) + 1] - pts[2 * k + 1];
    const th = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    const arc = (Math.hypot(ax, ay) + Math.hypot(bx, by)) / 2;
    if (th > 1e-9) rmin = Math.min(rmin, arc / th);
  }
  return rmin;
}

/**
 * A C1 curve through points Q (every ~h m) sampled every OUT_STEP m: cubic Hermite,
 * Catmull–Rom tangents inside, the anchors' headings at the ends.
 */
function hermite(Q: number[], a: MotorwayAnchor, b: MotorwayAnchor, h: number): Float64Array {
  const n = Q.length / 2 - 1;
  const tan = (k: number): [number, number] => {
    if (k === 0) return [a.tx * h, a.ty * h];
    if (k === n) return [b.tx * h, b.ty * h];
    return [(Q[2 * k + 2] - Q[2 * k - 2]) / 2, (Q[2 * k + 3] - Q[2 * k - 1]) / 2];
  };
  const out: number[] = [Q[0], Q[1]];
  for (let k = 0; k < n; k++) {
    const [x0, y0, x1, y1] = [Q[2 * k], Q[2 * k + 1], Q[2 * k + 2], Q[2 * k + 3]];
    const [m0x, m0y] = tan(k);
    const [m1x, m1y] = tan(k + 1);
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / OUT_STEP));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      out.push(h00 * x0 + h10 * m0x + h01 * x1 + h11 * m1x, h00 * y0 + h10 * m0y + h01 * y1 + h11 * m1y);
    }
  }
  return Float64Array.from(out);
}

if (NET_CELL % MW_CELL) throw new Error('net cells must hold whole motorway cells');
