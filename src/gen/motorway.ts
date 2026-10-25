import { gnoise, ND, smoothstep } from '../lib/noise';
import { hash3 } from '../lib/hash';
import { coarseEpochNow, type CoarseField } from './hydro';
import { lakesOf } from './lakes';
import { NET_CELL, ringDisc } from './roads';
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
/** Width of the dual carriageway (m), and how far (m) from its centre line other things keep. */
export const MW_WIDTH = 24;
/** Width of an interchange's ramps (m). */
export const MW_RAMP_WIDTH = 8;
/** Streets, built-up land and farmsteads: the band either side counts as water (no street, no building, no junction on a bridge). */
export const MW_PLAN_CLEAR = MW_WIDTH / 2 + 12;
/** Building footprints. */
export const MW_BUILD_CLEAR = MW_WIDTH / 2 + 8;
/** Woods, vines, marsh and heath are cleared, and field parcels stop, this far out. */
export const MW_VERGE = MW_WIDTH / 2 + 10;

/**
 * How far a piece may lie outside its own cell (m): its raw line keeps inside, towns
 * and villages bend it by up to PUSH_CLEAR (both at once, 1.8 km) and the routing strays up to K × OFF (with a margin for the
 * curve through the routed points). A chunk is drawn once the pieces this near are known.
 */
export const MW_SPILL = 3500;
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
 * Towns and villages bend the line away: one nearer the line than PUSH_CLEAR m (by rank)
 * moves its points across, away from the settlement's side, by the shortfall, fading
 * along the line over PUSH_R m (smoothly, so neighbouring anchors move alike). (Pushing
 * by a fixed amount, a town 1.9 km off pushed the line onto a village on its other side.)
 * Hamlets don't: motorways pass close by them.
 */
const PUSH_CLEAR = [1200, 600];
const PUSH_R = [4500, 3500];

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
/**
 * How far from its cell a cell's pieces read the line and the land (m): a run is walked
 * ~10 km either way (plus the last piece), each piece on it tested for loops (5 km more)
 * and its anchors' neighbours (a cell more, and the region's 6 km ring). Only noise this
 * far: the coarse terrain is read within MW_SPILL. (NET_REACH allows for it.)
 */
export const MW_DEPEND = 40000;
/** Per worker: routed pieces by cell and seeds, shared by every task (most cells hold none). */
const shared = { epoch: -1, pieces: new Map<string, MotorwayPiece[]>() };
const SHARED_MAX = 20000;
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
  private readonly offs = new Map<string, [number, number]>();
  /** Pieces no route was found for (drawn along their raw line; dev). */
  unrouted = 0;

  private readonly l32k: Lattice;

  constructor(
    private readonly field: CoarseField,
    private readonly terrain: Terrain,
    private readonly set: Settlements,
    view: SeedView,
  ) {
    this.l64k = view.coarse(65536);
    this.l32k = view.coarse(32768);
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

  /**
   * Where motorways end in the cells overlapping a rectangle: the end anchors as placed,
   * their heading pointing on out of the motorway. From the line alone (no routing), so
   * cheap enough to look far: every cell building main roads near one finds it alike.
   */
  endsIn(x0: number, y0: number, x1: number, y1: number): MotorwayAnchor[] {
    const out: MotorwayAnchor[] = [];
    for (let cj = Math.floor(y0 / MW_CELL); cj <= Math.floor(y1 / MW_CELL); cj++)
      for (let ci = Math.floor(x0 / MW_CELL); ci <= Math.floor(x1 / MW_CELL); ci++)
        for (const p of this.rawPieces(ci, cj)) {
          if (!this.keeps(p)) continue;
          if (!this.continues(p.a, ci, cj)) {
            const a = this.placed(p.a);
            out.push({ ...a, tx: -a.tx, ty: -a.ty });
          }
          if (!this.continues(p.b, ci, cj)) out.push(this.placed(p.b));
        }
    return out;
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
    // Shared by every task on this worker: a pure function of the seeds.
    if (shared.epoch !== coarseEpochNow() || shared.pieces.size > SHARED_MAX) {
      shared.pieces.clear();
      shared.epoch = coarseEpochNow();
    }
    const sk = `${k}|${this.signature(ci, cj)}`;
    hit = shared.pieces.get(sk);
    if (hit) {
      this.routed.set(k, hit);
      return hit;
    }
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
    shared.pieces.set(sk, hit);
    return hit;
  }

  /**
   * Hash of the motorway lattices' seeds (64 and 32 km) a cell's pieces can depend on.
   * The smaller ones are the terrain's, which the coarse epoch follows.
   */
  private signature(ci: number, cj: number): number {
    let h = 0x2545f491;
    for (const L of [this.l64k, this.l32k]) {
      const S = L.S;
      // (Lattices shifted by up to a spacing read up to two points past a sample.)
      for (let iy = Math.floor((cj * MW_CELL - MW_DEPEND) / S); iy <= Math.floor(((cj + 1) * MW_CELL + MW_DEPEND) / S) + 2; iy++)
        for (let ix = Math.floor((ci * MW_CELL - MW_DEPEND) / S); ix <= Math.floor(((ci + 1) * MW_CELL + MW_DEPEND) / S) + 2; ix++)
          h = hash3(h ^ L.seed(ix, iy), ix, iy);
    }
    return h;
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

  /** Towns and villages whose push reaches the rectangle. */
  private pushers(x0: number, y0: number, x1: number, y1: number): Site[] {
    return [TOWN, VILLAGE].flatMap((r) => {
      const m = PUSH_R[r] + PUSH_CLEAR[r];
      return this.set.sitesIn(r as Rank, x0 - m, y0 - m, x1 + m, y1 + m);
    });
  }

  /** A point of the line, bent away from towns and villages. */
  private bend(x: number, y: number, towns: Site[]): [number, number] {
    let dx = 0;
    let dy = 0;
    let g: number[] | undefined;
    for (const t of towns) {
      const [off, side] = this.offLine(t);
      const need = PUSH_CLEAR[t.rank] - off;
      if (need <= 0) continue;
      // Along the line from the point nearest the settlement.
      const along = Math.sqrt(Math.max(0, (x - t.x) ** 2 + (y - t.y) ** 2 - off * off));
      if (along >= PUSH_R[t.rank]) continue;
      if (!g) {
        g = [0, 0];
        this.line(x, y, g);
        const n = Math.hypot(g[0], g[1]) || 1;
        g[0] /= n;
        g[1] /= n;
      }
      // Across the line (along the field's gradient), away from the settlement's side.
      const u = along / PUSH_R[t.rank];
      const m = -side * need * (1 - u * u) ** 2;
      dx += m * g[0];
      dy += m * g[1];
    }
    return [x + dx, y + dy];
  }

  /** A settlement's distance from the raw line (to first order: |F| / |∇F|) and its side (±1). */
  private offLine(t: Site): [number, number] {
    let hit = this.offs.get(t.id);
    if (!hit) {
      const g = [0, 0];
      const f = this.line(t.x, t.y, g);
      this.offs.set(t.id, (hit = [Math.abs(f) / (Math.hypot(g[0], g[1]) || 1e-12), f > 0 ? 1 : -1]));
    }
    return hit;
  }

  /** A raw line bent away from towns and villages. */
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

  /** An anchor bent away from towns and villages, its heading with it. */
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
   * The anchor where the motorway crosses its border: bent away from towns and villages. (Where it
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
    // The line, bent away from towns and villages, resampled every ~STEP m, with normals (to the left).
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

/** Lookup bins (m), and how far from a bin its segments may lie. */
const BIN = 512;
const BIN_REACH = 256;

/**
 * Where motorways run, for the network (lattice.ts): distances and crossings, from the
 * pieces of the cells around, gathered per BIN (most are empty).
 */
export class MotorwayLookup {
  private readonly lines: Float64Array[] = [];
  private readonly lineOf = new Map<string, number>();
  /** Per bin: references to the segments near it, line index × 65536 + segment. */
  private readonly bins = new Map<number, number[]>();

  constructor(private readonly mw: Motorways) {}

  private bin(bi: number, bj: number): number[] {
    const key = (bi + 1048576) * 2097152 + (bj + 1048576);
    let hit = this.bins.get(key);
    if (hit) return hit;
    hit = [];
    const x0 = bi * BIN - BIN_REACH;
    const y0 = bj * BIN - BIN_REACH;
    const x1 = (bi + 1) * BIN + BIN_REACH;
    const y1 = (bj + 1) * BIN + BIN_REACH;
    for (let cj = Math.floor((y0 - MW_SPILL) / MW_CELL); cj <= Math.floor((y1 + MW_SPILL) / MW_CELL); cj++)
      for (let ci = Math.floor((x0 - MW_SPILL) / MW_CELL); ci <= Math.floor((x1 + MW_SPILL) / MW_CELL); ci++)
        for (const p of this.mw.cellPieces(ci, cj)) {
          let li = this.lineOf.get(p.key);
          if (li === undefined) {
            li = this.lines.length;
            this.lines.push(p.xy);
            this.lineOf.set(p.key, li);
          }
          const xy = p.xy;
          for (let k = 0; k + 3 < xy.length; k += 2)
            if (Math.max(xy[k], xy[k + 2]) >= x0 && Math.min(xy[k], xy[k + 2]) <= x1 && Math.max(xy[k + 1], xy[k + 3]) >= y0 && Math.min(xy[k + 1], xy[k + 3]) <= y1)
              hit.push(li * 65536 + k / 2);
        }
    this.bins.set(key, hit);
    return hit;
  }

  /** Distance (m) from (x, y) to the nearest motorway centre line, if within BIN_REACH; else Infinity. */
  dist(x: number, y: number): number {
    let d = Infinity;
    for (const r of this.bin(Math.floor(x / BIN), Math.floor(y / BIN))) {
      const xy = this.lines[Math.floor(r / 65536)];
      const k = 2 * (r % 65536);
      d = Math.min(d, pointSeg(x, y, xy[k], xy[k + 1], xy[k + 2], xy[k + 3]));
    }
    return d < BIN_REACH ? d : Infinity;
  }

  /**
   * Segment a–b against the motorways (at most 2 × BIN_REACH long): how many
   * times it crosses one, the smallest angle (rad, 0 to π/2) of those crossings, its
   * least distance from a centre line where it doesn't cross, and where it crosses (one
   * of the crossings).
   */
  crossing(ax: number, ay: number, bx: number, by: number): { n: number; angle: number; dist: number; x: number; y: number } {
    const refs = new Set<number>();
    for (const [x, y] of [[ax, ay], [bx, by]]) for (const r of this.bin(Math.floor(x / BIN), Math.floor(y / BIN))) refs.add(r);
    let n = 0;
    let angle = Math.PI / 2;
    let dist = Infinity;
    let x = NaN;
    let y = NaN;
    const dx = bx - ax;
    const dy = by - ay;
    for (const r of refs) {
      const xy = this.lines[Math.floor(r / 65536)];
      const k = 2 * (r % 65536);
      const [cx, cy, ex, ey] = [xy[k], xy[k + 1], xy[k + 2], xy[k + 3]];
      const fx = ex - cx;
      const fy = ey - cy;
      const den = dx * fy - dy * fx;
      if (den !== 0) {
        const t = ((cx - ax) * fy - (cy - ay) * fx) / den;
        const u = ((cx - ax) * dy - (cy - ay) * dx) / den;
        // Half-open along the motorway, so a crossing at a shared point counts once.
        if (t >= 0 && t <= 1 && u >= 0 && u < 1) {
          n++;
          x = ax + t * dx;
          y = ay + t * dy;
          angle = Math.min(angle, Math.asin(Math.min(1, Math.abs(den) / (Math.hypot(dx, dy) * Math.hypot(fx, fy)))));
          continue;
        }
      }
      dist = Math.min(dist, pointSeg(ax, ay, cx, cy, ex, ey), pointSeg(bx, by, cx, cy, ex, ey), pointSeg(cx, cy, ax, ay, bx, by), pointSeg(ex, ey, ax, ay, bx, by));
    }
    return { n, angle, dist, x, y };
  }
}

function pointSeg(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/**
 * Distance (m) to the nearest of some centre lines, when within `reach`; else Infinity.
 * Segments are binned (`bin` m) once, for many queries.
 */
export function lineDistance(lines: ArrayLike<number>[], reach: number, bin = 64): (x: number, y: number) => number {
  const bins = new Map<number, number[]>();
  const key = (bi: number, bj: number) => (bi + 1048576) * 2097152 + (bj + 1048576);
  lines.forEach((xy, li) => {
    for (let k = 0; k + 3 < xy.length; k += 2) {
      const bi0 = Math.floor((Math.min(xy[k], xy[k + 2]) - reach) / bin);
      const bi1 = Math.floor((Math.max(xy[k], xy[k + 2]) + reach) / bin);
      const bj0 = Math.floor((Math.min(xy[k + 1], xy[k + 3]) - reach) / bin);
      const bj1 = Math.floor((Math.max(xy[k + 1], xy[k + 3]) + reach) / bin);
      for (let bj = bj0; bj <= bj1; bj++)
        for (let bi = bi0; bi <= bi1; bi++) {
          const kk = key(bi, bj);
          let b = bins.get(kk);
          if (!b) bins.set(kk, (b = []));
          b.push(li, k);
        }
    }
  });
  return (x, y) => {
    const b = bins.get(key(Math.floor(x / bin), Math.floor(y / bin)));
    if (!b) return Infinity;
    let d = Infinity;
    for (let q = 0; q < b.length; q += 2) {
      const xy = lines[b[q]];
      const k = b[q + 1];
      d = Math.min(d, pointSeg(x, y, xy[k], xy[k + 1], xy[k + 2], xy[k + 3]));
    }
    return d < reach ? d : Infinity;
  };
}

/** Where polyline `pts` crosses any of the centre lines: the points [x, y, …]. */
export function lineCrossings(pts: ArrayLike<number>, lines: ArrayLike<number>[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const [ax, ay, bx, by] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
    for (const xy of lines)
      for (let k = 0; k + 3 < xy.length; k += 2) {
        const [cx, cy, ex, ey] = [xy[k], xy[k + 1], xy[k + 2], xy[k + 3]];
        if (Math.max(cx, ex) < Math.min(ax, bx) || Math.min(cx, ex) > Math.max(ax, bx)) continue;
        if (Math.max(cy, ey) < Math.min(ay, by) || Math.min(cy, ey) > Math.max(ay, by)) continue;
        const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const d2 = (bx - ax) * (ey - ay) - (by - ay) * (ex - ax);
        const d3 = (ex - cx) * (ay - cy) - (ey - cy) * (ax - cx);
        const d4 = (ex - cx) * (by - cy) - (ey - cy) * (bx - cx);
        if (d1 * d2 <= 0 && d3 * d4 <= 0 && d1 !== d2) {
          const t = d1 / (d1 - d2);
          out.push(cx + (ex - cx) * t, cy + (ey - cy) * t);
        }
      }
  }
  return out;
}

/**
 * Diamond interchanges: on each side, the ramps leave the crossing road IC_JOIN m from
 * the motorway's centre line (or at the road's end, if nearer), and merge into the
 * motorway IC_MERGE m along it from the crossing, either way, their outer edge on its.
 */
const IC_JOIN = 90;
const IC_MERGE = 380;
const IC_STEP = 10;
/**
 * The ramps swing out to about this far from the centre line (m) before running in to
 * merge: the road's crossing edge often ends near the motorway (its vertices keep only
 * MW_VERTEX away, and are snapped closer), which made the diamond a sliver.
 */
const IC_SWING = 70;

/**
 * The four ramps of a diamond where `road` crosses one of the motorways `lines` (their
 * centre lines, pieces joined end to end): cubic curves from the road, leaving along the
 * motorway, to its edge, tangent to it. Empty where the road doesn't cross one.
 */
export function diamondRamps(road: ArrayLike<number>, lines: ArrayLike<number>[]): number[][] {
  // The crossing: the road's segment i, the motorway's line li and segment k.
  let hit: { i: number; li: number; k: number; x: number; y: number } | undefined;
  for (let i = 0; i + 3 < road.length && !hit; i += 2)
    lines.forEach((xy, li) => {
      if (hit) return;
      const one = lineCrossings([road[i], road[i + 1], road[i + 2], road[i + 3]], [xy]);
      if (!one.length) return;
      for (let k = 0; k + 3 < xy.length; k += 2)
        if (lineCrossings([xy[k], xy[k + 1], xy[k + 2], xy[k + 3]], [[road[i], road[i + 1], road[i + 2], road[i + 3]]]).length) {
          hit = { i, li, k, x: one[0], y: one[1] };
          return;
        }
    });
  if (!hit) return [];
  const { i, li, k, x: X, y: Y } = hit;
  const near = lineDistance(lines, 2 * IC_JOIN);
  /** The point `dist` m along the motorway from the crossing (dir ±1), and the heading there, onward; across joined pieces. */
  const along = (dir: number, dist: number): [number, number, number, number] => {
    let xy = lines[li];
    let q = dir > 0 ? k + 2 : k; // the next point
    let px = X;
    let py = Y;
    let left = dist;
    for (let guard = 0; guard < 10000; guard++) {
      if (q < 0 || q >= xy.length) {
        // Onto the piece joined here, if any.
        const next = lines.find((o) => o !== xy && Math.hypot(o[dir > 0 ? 0 : o.length - 2] - px, o[dir > 0 ? 1 : o.length - 1] - py) < 1);
        if (!next) break;
        xy = next;
        q = dir > 0 ? 2 : next.length - 4;
        continue;
      }
      const sx = xy[q] - px;
      const sy = xy[q + 1] - py;
      const L = Math.hypot(sx, sy);
      // (sx, sy) points the way we go: onward is the heading, whichever way that is.
      if (L >= left && L > 0) return [px + (sx * left) / L, py + (sy * left) / L, sx / L, sy / L];
      left -= L;
      px = xy[q];
      py = xy[q + 1];
      q += 2 * dir;
    }
    // Ran out of motorway (it ends): as far as it goes.
    const b = dir > 0 ? xy.length - 4 : 0;
    const L = Math.hypot(xy[b + 2] - xy[b], xy[b + 3] - xy[b + 1]) || 1;
    return [px, py, (dir * (xy[b + 2] - xy[b])) / L, (dir * (xy[b + 3] - xy[b + 1])) / L];
  };
  const out: number[][] = [];
  for (const side of [-1, 1]) {
    // Where the ramps leave the road on this side.
    let j = side < 0 ? i : i + 2;
    while (j > 0 && j < road.length - 2 && near(road[j], road[j + 1]) < IC_JOIN) j += 2 * side;
    const jx = road[j];
    const jy = road[j + 1];
    for (const dir of [-1, 1]) {
      const [mx, my, tx, ty] = along(dir, IC_MERGE);
      // The side of the motorway the road leaves it on, and where the ramp ends: its outer
      // edge on the carriageway's (ending on the edge line, half of it stuck out in a bump).
      const s = Math.sign(-ty * (jx - mx) + tx * (jy - my)) || 1;
      const edge = (MW_WIDTH - MW_RAMP_WIDTH) / 2;
      const ex = mx - s * ty * edge;
      const ey = my + s * tx * edge;
      const L = Math.hypot(ex - jx, ey - jy);
      // Leaving the road along the motorway's heading at the crossing (swung out if the
      // road meets it close by), arriving along it at the merge.
      const [cx0, cy0] = along(dir, 1).slice(2) as [number, number];
      const out0 = 1.6 * Math.max(0, IC_SWING - near(jx, jy));
      const p1x = jx + cx0 * 0.35 * L - s * cy0 * out0;
      const p1y = jy + cy0 * 0.35 * L + s * cx0 * out0;
      const p2x = ex - tx * 0.5 * L;
      const p2y = ey - ty * 0.5 * L;
      const n = Math.max(4, Math.ceil(L / IC_STEP));
      const pts: number[] = [];
      for (let q = 0; q <= n; q++) {
        const u = q / n;
        const a = (1 - u) ** 3;
        const b = 3 * u * (1 - u) ** 2;
        const c = 3 * u * u * (1 - u);
        const d = u ** 3;
        pts.push(a * jx + b * p1x + c * p2x + d * ex, a * jy + b * p1y + c * p2y + d * ey);
      }
      out.push(pts);
    }
  }
  return out;
}

/** How far beyond its end a motorway looks for its terminus (m): MW_END_RUN (lattice.ts) and a vertex's jitter. */
export const MW_END_REACH = 300;

/**
 * Where a motorway runs into a roundabout, its carriageways part this far (m) before the
 * ring, into lanes meeting it MW_END_SPREAD (rad) either side, arriving MW_END_FLARE
 * (rad) off the line to the ring's centre, away from the way in: they flare round onto
 * the ring (aimed at its centre, they met it square on).
 */
const MW_END_SPLIT = 50;
const MW_END_SPREAD = (40 * Math.PI) / 180;
const MW_END_FLARE = (60 * Math.PI) / 180;

/**
 * A piece's centre line, run on where the motorway ends (endA, endB) to its terminus as
 * drawn: towards the roundabout ahead, parting MW_END_SPLIT m before its ring into two
 * lanes (an island between, as ramps: `lanes`); else to the main road starting there
 * (its end). Cubic curves, leaving along the motorway.
 */
export function motorwayEnd(
  p: MotorwayPiece,
  roads: { xy: ArrayLike<number>; ring?: boolean; ramp?: boolean; cls: number }[],
): { xy: Float64Array; lanes: number[][] } {
  const xy = p.xy;
  const n = xy.length;
  const lanes: number[][] = [];
  const cubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, step: number) => {
    const L = Math.hypot(x3 - x0, y3 - y0);
    const m = Math.max(2, Math.ceil(L / step));
    const out: number[] = [];
    for (let q = 1; q <= m; q++) {
      const u = q / m;
      const a = (1 - u) ** 3;
      const b = 3 * u * (1 - u) ** 2;
      const c = 3 * u * u * (1 - u);
      const d = u ** 3;
      out.push(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3);
    }
    return out;
  };
  const runOn = (ex: number, ey: number, ux: number, uy: number): number[] | undefined => {
    const L = Math.hypot(ux, uy) || 1;
    ux /= L;
    uy /= L;
    const ahead = (x: number, y: number) => {
      const d = Math.hypot(x - ex, y - ey);
      return d > 1 && d < MW_END_REACH && ((x - ex) * ux + (y - ey) * uy) / d > 0.6;
    };
    let ring: [number, number, number] | undefined;
    let end: [number, number] | undefined;
    let bd = Infinity;
    for (const r of roads) {
      if (r.ramp) continue;
      if (r.ring) {
        const [cx, cy, rad] = ringDisc(r.xy);
        const d = Math.hypot(cx - ex, cy - ey);
        if (!ahead(cx, cy) || d >= bd) continue;
        bd = d;
        ring = [cx, cy, rad];
        end = undefined;
      } else if (r.cls <= 1)
        for (const k of [0, r.xy.length - 2]) {
          const [x, y] = [r.xy[k], r.xy[k + 1]];
          const d = Math.hypot(x - ex, y - ey);
          if (!ahead(x, y) || d >= bd - 40) continue; // a ring wins over a road end nearby
          bd = d;
          end = [x, y];
          ring = undefined;
        }
    }
    if (end) {
      const [tx, ty] = end;
      const D = Math.hypot(tx - ex, ty - ey);
      const ax = (tx - ex) / D;
      const ay = (ty - ey) / D;
      return cubic(ex, ey, ex + (ux * D) / 3, ey + (uy * D) / 3, tx - (ax * D) / 3, ty - (ay * D) / 3, tx, ty, OUT_STEP);
    }
    if (!ring) return undefined;
    // On towards the ring's centre, to MW_END_SPLIT short of the ring…
    const [cx, cy, rad] = ring;
    const d0 = Math.hypot(cx - ex, cy - ey);
    const ax = (cx - ex) / d0;
    const ay = (cy - ey) / d0;
    const back = Math.min(rad + MW_END_SPLIT, d0 - 1);
    const sx = cx - ax * back;
    const sy = cy - ay * back;
    const D = Math.hypot(sx - ex, sy - ey);
    const line = D > 1 ? cubic(ex, ey, ex + (ux * D) / 3, ey + (uy * D) / 3, sx - (ax * D) / 3, sy - (ay * D) / 3, sx, sy, OUT_STEP) : [];
    // …then two lanes, from the carriageway's edges, into the ring either side of the way in.
    const off = (MW_WIDTH - MW_RAMP_WIDTH) / 2;
    for (const side of [-1, 1]) {
      const lx = sx - side * ay * off;
      const ly = sy + side * ax * off;
      // Where it meets the ring, on its own side of the way in (turning (−ax, −ay) by +θ
      // goes to the right of the heading, the lane's offset side·(−ay, ax) to its left).
      const ang = Math.atan2(-ay, -ax) - side * MW_END_SPREAD;
      const rx = cx + rad * Math.cos(ang);
      const ry = cy + rad * Math.sin(ang);
      // Arriving between the ring's centre and its tangent leading away from the way in.
      const inx = -Math.cos(ang);
      const iny = -Math.sin(ang);
      const away = Math.sign(-iny * (-ay * side) + inx * (ax * side)) || 1;
      const hx = Math.cos(MW_END_FLARE) * inx - away * Math.sin(MW_END_FLARE) * iny;
      const hy = Math.cos(MW_END_FLARE) * iny + away * Math.sin(MW_END_FLARE) * inx;
      const Ls = Math.hypot(rx - lx, ry - ly);
      lanes.push([lx, ly, ...cubic(lx, ly, lx + (ax * Ls) / 2, ly + (ay * Ls) / 2, rx - (hx * Ls) / 2, ry - (hy * Ls) / 2, rx, ry, IC_STEP / 2)]);
    }
    return line;
  };
  let line = Array.from(xy);
  if (p.endA) {
    const r = runOn(xy[0], xy[1], xy[0] - xy[2], xy[1] - xy[3]);
    if (r) {
      const rev: number[] = [];
      for (let q = r.length - 2; q >= 0; q -= 2) rev.push(r[q], r[q + 1]);
      line = [...rev, ...line];
    }
  }
  if (p.endB) {
    const r = runOn(xy[n - 2], xy[n - 1], xy[n - 2] - xy[n - 4], xy[n - 1] - xy[n - 3]);
    if (r) line = [...line, ...r];
  }
  return { xy: Float64Array.from(line), lanes };
}
