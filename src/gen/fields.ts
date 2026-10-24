import { CHUNK } from '../lib/constants';
import { hash3 } from '../lib/hash';
import { lerp, smoothstep } from '../lib/noise';
import { segPointDist } from './buildings';
import { NODE } from './hydro';
import { nearestVertex, neighbours, vertexPos, verticesIn } from './lattice';
import type { PoiPatch } from './poi';
import { ROAD_P, ROAD_T, type SegmentPath } from './roads';
import type { TownPlan } from './town';

/**
 * Field parcels and hedges.
 *
 * The farmland is divided first into **blocks**: the land enclosed by ways. Every
 * way runs along edges of one triangular lattice (lattice.ts), so a block is a set of
 * lattice triangles joined across edges that carry no way. The net cells know which
 * edges carry ways far around, so every chunk finds the same blocks (a block more
 * than BLOCK_MAX across is left undivided: forest, mountain pasture, or open land far
 * from any way).
 *
 * Each block is then cut into **fields** in the style of its region:
 *  - lowland open field: large consolidated fields, hardly a hedge;
 *  - strip fields (lowland): narrow parallel strips in furlongs;
 *  - bocage (lowland and hills): small irregular fields hedged all round, lanes
 *    lined with hedges;
 *  - hill fields: medium fields, along the contours on slopes, now and then hedged;
 *  - mountain meadows: large, few hedges.
 * Fields front the block's longest way and run back from it in parallel strips
 * (along the contours where the block slopes); a block deeper than a furlong is cut
 * across into furlongs, each with its own strips. Bocage cuts lean every which way.
 *
 * The cuts are straight lines in the lattice's straight-edged blocks. Each is then
 * fitted to the map: its ends stop at the drawn ways (which wander up to ~30 m off
 * the lattice edges), and it is drawn only on farmland — not in forest, rock, water or
 * built-up land, nor on steep ground. Those tests read only what every chunk near the
 * point sees alike, so lines cross chunk borders unbroken.
 *
 * Output: unhedged field edges (drawn faintly) and hedges, as straight pieces.
 */

export interface FieldInput {
  cx: number;
  cy: number;
  /** Lattice edges carrying ways within FIELD_REACH of the chunk: their two vertices [ax, ay, bx, by] each. */
  edges: number[][];
  /** Fine nodes round the chunk (heights and region). */
  patch: PoiPatch;
  /** Ways drawn in and around the chunk (the plans' redrawn roads included). */
  roads: SegmentPath[];
  /** Plans drawing into the chunk. */
  plans: TownPlan[];
  /** Is (x, y) open farmland (no forest, rock, water; world metres, within the chunk and its apron)? */
  open: (x: number, y: number) => boolean;
  /** Ground slope (m/m) at (x, y), likewise. */
  slope: (x: number, y: number) => number;
}

export interface Fields {
  /** Field edges, [x0, y0, x1, y1] per piece (world metres). */
  edges: number[];
  /** Hedges, likewise. */
  hedges: number[];
}

/** Blocks more than this across (m) are left undivided. */
export const BLOCK_MAX = 760;
/** Lattice edges a chunk needs: within this far of it (m). */
export const FIELD_REACH = BLOCK_MAX + 180;
/** Nodes a block's style and slope read: as far as a block reaches beyond the chunk. */
export const FIELD_PAD = Math.ceil((BLOCK_MAX + 40) / NODE) + 2;

interface Style {
  name: string;
  /** Field width across the strips (m) and furlong depth along them (m). */
  w: [number, number];
  L: [number, number];
  /** Cuts lean by up to this much (rad). */
  lean: number;
  /** Chance a field edge is a hedge; chance a way side is lined with one. */
  hedge: number;
  lane: number;
}
const OPEN: Style = { name: 'open', w: [60, 200], L: [220, 450], lean: 0.05, hedge: 0.05, lane: 0.08 };
const STRIPS: Style = { name: 'strips', w: [18, 45], L: [140, 300], lean: 0.03, hedge: 0.03, lane: 0.04 };
const BOCAGE: Style = { name: 'bocage', w: [70, 150], L: [80, 170], lean: 0.25, hedge: 0.75, lane: 0.7 };
const HILL: Style = { name: 'hill', w: [45, 110], L: [90, 200], lean: 0.17, hedge: 0.35, lane: 0.3 };
const MEADOW: Style = { name: 'meadow', w: [80, 220], L: [120, 260], lean: 0.2, hedge: 0.15, lane: 0.1 };
export const STYLES = [OPEN, STRIPS, BOCAGE, HILL, MEADOW];

/** Regions: lowland below HILLS, mountains from MOUNTAINS. */
const HILLS = 0.25;
const MOUNTAINS = 0.55;
/** Bocage and strip-field country: where their noise (3 km) exceeds these (bocage: lowland, hills). */
const BOCAGE_AT = [0.62, 0.5];
const STRIPS_AT = 0.6;
const STYLE_SCALE = 3000;
/** Blocks sloping more than this (m/m) are cut along the contours (strip fields excepted). */
const CONTOUR_SLOPE = 0.06;
/** Farmland: no steeper than this (m/m). */
const FIELD_STEEP = 0.4;
/** A way's clearance (m), per class (N, D, C, track, path): field edges stop there, way-side hedges stand just beyond. */
const WAY_CLEAR = [6, 5, 4, 2.5, 1.5];
const HEDGE_OFF = 2.5;
/** Field edges keep this far from buildings and inside nothing built up (m). */
const BUILT_CLEAR = 10;
/** Built-up land is tested on a mask this fine (m). */
const BUILT_CELL = 4;
/** Ends: from this far inside (m), a cut runs to the first way, up to END_EXT beyond its lattice end. */
const END_IN = 40;
const END_EXT = 35;
/** Sampling along cuts (m); pieces shorter than MIN_PIECE are dropped, as are cuts shorter than MIN_CUT. */
const STEP = 3;
const MIN_PIECE = 6;
const MIN_CUT = 15;
/** Way-side hedges stop this short of the way's ends (junctions; m). */
const LANE_END = 14;
/** Pieces are fitted within this far of the chunk (m). */
const MARGIN = 8;
/** Furlongs in large blocks: a jittered grid of FURLONG m (± FURLONG_JITTER of it); strips square to a way within FURLONG_WAY m. */
const FURLONG = 360;
const FURLONG_JITTER = 0.3;
const FURLONG_WAY = 450;

/** Debugging: blocks cut, blocks too large, furlong cells, summed over calls. */
export const fieldStats: Record<string, number> = {};
/** Debugging: when an array, each piece's origin is pushed to it (hedges and edges alike, in order). */
export const fieldOrigins: { on: boolean; tags: string[] } = { on: false, tags: [] };
let origin = '';

/** Smooth value noise in [0, 1] on a world lattice of S m. */
function vnoise(salt: number, x: number, y: number, S: number): number {
  const fx = x / S;
  const fy = y / S;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const u = smoothstep(0, 1, fx - ix);
  const v = smoothstep(0, 1, fy - iy);
  const h = (i: number, j: number) => hash3(salt, i, j) / 4294967296;
  return lerp(lerp(h(ix, iy), h(ix + 1, iy), u), lerp(h(ix, iy + 1), h(ix + 1, iy + 1), u), v);
}

/** The field style at (x, y) in region R. */
export function styleAt(x: number, y: number, R: number): Style {
  if (R >= MOUNTAINS) return MEADOW;
  const b = 0.65 * vnoise(0xb0ca, x, y, STYLE_SCALE) + 0.35 * vnoise(0xb0cb, x, y, STYLE_SCALE / 2.7);
  if (b > (R < HILLS ? BOCAGE_AT[0] : BOCAGE_AT[1])) return BOCAGE;
  if (R >= HILLS) return HILL;
  return vnoise(0x5717, x, y, STYLE_SCALE) > STRIPS_AT ? STRIPS : OPEN;
}

type Seg = { ax: number; ay: number; bx: number; by: number };

/** Parameter intervals where the line P + t·u lies inside an outline (even–odd). */
function intervals(outline: Seg[], px: number, py: number, ux: number, uy: number): [number, number][] {
  const ts: number[] = [];
  for (const s of outline) {
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((s.ax - px) * ey - (s.ay - py) * ex) / den;
    const v = ((s.ax - px) * uy - (s.ay - py) * ux) / den;
    if (v >= 0 && v < 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const iv: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) iv.push([ts[i], ts[i + 1]]);
  return iv;
}

/** …inside every one of several outlines. */
function insideAll(outlines: Seg[][], px: number, py: number, ux: number, uy: number): [number, number][] {
  let iv = intervals(outlines[0], px, py, ux, uy);
  for (let k = 1; k < outlines.length && iv.length; k++) {
    const other = intervals(outlines[k], px, py, ux, uy);
    const next: [number, number][] = [];
    for (const [a0, a1] of iv) for (const [b0, b1] of other) if (Math.min(a1, b1) > Math.max(a0, b0)) next.push([Math.max(a0, b0), Math.min(a1, b1)]);
    iv = next;
  }
  return iv;
}

/** Intervals of the line P + t·u split where it crosses any of `cracks`. */
function splitAt(cracks: Seg[], px: number, py: number, ux: number, uy: number, iv: [number, number][]): [number, number][] {
  if (!cracks.length) return iv;
  const ts: number[] = [];
  for (const s of cracks) {
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((s.ax - px) * ey - (s.ay - py) * ex) / den;
    const v = ((s.ax - px) * uy - (s.ay - py) * ux) / den;
    if (v >= 0 && v <= 1) ts.push(t);
  }
  const out: [number, number][] = [];
  for (const [a, b] of iv) {
    let lo = a;
    for (const t of ts.filter((q) => q > a && q < b).sort((m, n) => m - n)) {
      out.push([lo, t]);
      lo = t;
    }
    out.push([lo, b]);
  }
  return out;
}

const triKey = (a: number, b: number, c: number) => [a, b, c].sort((m, n) => m - n).join('_');
const edgeKey = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);

export function layFields({ cx, cy, edges, patch: p, roads, plans, open, slope }: FieldInput): Fields {
  const out: Fields = { edges: [], hedges: [] };
  const X0 = cx * CHUNK - MARGIN;
  const Y0 = cy * CHUNK - MARGIN;
  const X1 = (cx + 1) * CHUNK + MARGIN;
  const Y1 = (cy + 1) * CHUNK + MARGIN;

  // --- Terrain, ways and built-up land ---------------------------------------------
  const node = (x: number, y: number) => {
    const i = Math.min(p.w - 1, Math.max(0, Math.round(x / NODE) - p.gx));
    const j = Math.min(p.h - 1, Math.max(0, Math.round(y / NODE) - p.gy));
    return j * p.w + i;
  };
  // Drawn ways in a grid, for clearance tests.
  const CELL = 32;
  const grid = new Map<number, number[]>();
  const pieces: { ax: number; ay: number; bx: number; by: number; clear: number }[] = [];
  const gk = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  for (const r of roads)
    for (let k = 2; k < r.xy.length; k += 2) {
      const q = { ax: r.xy[k - 2], ay: r.xy[k - 1], bx: r.xy[k], by: r.xy[k + 1], clear: WAY_CLEAR[r.cls] };
      const id = pieces.push(q) - 1;
      for (let j = Math.floor((Math.min(q.ay, q.by) - 8) / CELL); j <= Math.floor((Math.max(q.ay, q.by) + 8) / CELL); j++)
        for (let i = Math.floor((Math.min(q.ax, q.bx) - 8) / CELL); i <= Math.floor((Math.max(q.ax, q.bx) + 8) / CELL); i++) {
          const g = gk(i, j);
          let a = grid.get(g);
          if (!a) grid.set(g, (a = []));
          a.push(id);
        }
    }
  /** Is (x, y) within a way's clearance (plus `extra` m)? */
  const onWay = (x: number, y: number, extra = 0) => {
    for (const id of grid.get(gk(Math.floor(x / CELL), Math.floor(y / CELL))) ?? []) {
      const q = pieces[id];
      if (segPointDist(q.ax, q.ay, q.bx, q.by, x, y) < q.clear + extra) return true;
    }
    return false;
  };
  // Built-up land (buildings, with a margin, and the plans' built-up strips), as a mask of BUILT_CELL m over the chunk.
  const bw = Math.ceil((X1 - X0) / BUILT_CELL) + 1;
  const bmask = new Uint8Array(bw * bw);
  const markNear = (ax: number, ay: number, bx: number, by: number, r: number) => {
    for (let j = Math.max(0, Math.floor((Math.min(ay, by) - r - Y0) / BUILT_CELL)); j <= Math.min(bw - 1, Math.ceil((Math.max(ay, by) + r - Y0) / BUILT_CELL)); j++)
      for (let i = Math.max(0, Math.floor((Math.min(ax, bx) - r - X0) / BUILT_CELL)); i <= Math.min(bw - 1, Math.ceil((Math.max(ax, bx) + r - X0) / BUILT_CELL)); i++)
        if (!bmask[j * bw + i] && segPointDist(ax, ay, bx, by, X0 + i * BUILT_CELL, Y0 + j * BUILT_CELL) < r) bmask[j * bw + i] = 1;
  };
  for (const pl of plans) {
    const b = pl.buildings;
    for (let i = 0; i < b.length; i += 8) {
      if (b[i] < X0 - 60 || b[i] > X1 + 60 || b[i + 1] < Y0 - 60 || b[i + 1] > Y1 + 60) continue;
      for (let c = 0; c < 8; c += 2) markNear(b[i + c], b[i + c + 1], b[i + ((c + 2) % 8)], b[i + ((c + 3) % 8)], BUILT_CLEAR);
      // (Inside: its diagonals.)
      markNear(b[i], b[i + 1], b[i + 4], b[i + 5], BUILT_CLEAR);
      markNear(b[i + 2], b[i + 3], b[i + 6], b[i + 7], BUILT_CLEAR);
    }
    for (const f of pl.frontage)
      for (let k = 2; k < f.xy.length; k += 2) {
        const [ax, ay, bx, by] = [f.xy[k - 2], f.xy[k - 1], f.xy[k], f.xy[k + 1]];
        if (Math.max(ax, bx) < X0 - f.depth || Math.min(ax, bx) > X1 + f.depth || Math.max(ay, by) < Y0 - f.depth || Math.min(ay, by) > Y1 + f.depth) continue;
        markNear(ax, ay, bx, by, f.depth);
      }
  }
  const built = (x: number, y: number) => {
    const i = Math.round((x - X0) / BUILT_CELL);
    const j = Math.round((y - Y0) / BUILT_CELL);
    return i >= 0 && j >= 0 && i < bw && j < bw && bmask[j * bw + i] === 1;
  };
  const farmland = (x: number, y: number) => open(x, y) && slope(x, y) <= FIELD_STEEP && !built(x, y);

  /**
   * Draws the cut a→b (`hedge` or a plain field edge): the part near the chunk, on
   * farmland and clear of the ways, its ends run to the drawn ways (up to END_EXT
   * beyond them: the lattice's straight edges lie up to ~30 m off the drawn ways).
   */
  const emit = (ax: number, ay: number, bx: number, by: number, hedge: boolean) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < MIN_CUT) return;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // Near the chunk at all?
    if (Math.max(ax, bx) < X0 - END_EXT || Math.min(ax, bx) > X1 + END_EXT || Math.max(ay, by) < Y0 - END_EXT || Math.min(ay, by) > Y1 + END_EXT) return;
    /** An end at `from` (moving `dir`): from END_IN inside, on to the first way (up to END_EXT beyond); else `from`. */
    const end = (from: number, dir: number) => {
      const s0 = from - dir * Math.min(END_IN, len / 2);
      for (let s = s0; dir > 0 ? s <= from + END_EXT : s >= from - END_EXT; s += dir * 2) if (onWay(ax + ux * s, ay + uy * s)) return s;
      return from;
    };
    const s0 = end(0, -1);
    const s1 = end(len, 1);
    // Farmland, clear of ways, near the chunk: runs of samples, their ends found to within half a metre.
    const ok = (t: number) => !onWay(ax + ux * t, ay + uy * t) && farmland(ax + ux * t, ay + uy * t);
    /** Between a good sample g and a bad one b: the last good point. */
    const edge = (g: number, b: number) => {
      for (let k = 0; k < 3; k++) {
        const m = (g + b) / 2;
        if (ok(m)) g = m;
        else b = m;
      }
      return g;
    };
    let run = -1;
    let prev = NaN;
    let prevOk = false;
    // Runs are judged whole (MIN_PIECE beyond the margin, so every chunk drawing a run
    // keeps it or drops it alike), then clipped to the margin.
    const flush = (t: number) => {
      if (run >= 0 && t - run >= MIN_PIECE) {
        let a = run;
        let b = t;
        for (const [p0, d, lo, hi] of [
          [ax, ux, X0, X1],
          [ay, uy, Y0, Y1],
        ]) {
          if (Math.abs(d) < 1e-12) continue;
          const u0 = (lo - p0) / d;
          const u1 = (hi - p0) / d;
          a = Math.max(a, Math.min(u0, u1));
          b = Math.min(b, Math.max(u0, u1));
        }
        if (b > a) {
          (hedge ? out.hedges : out.edges).push(ax + ux * a, ay + uy * a, ax + ux * b, ay + uy * b);
          if (fieldOrigins.on) fieldOrigins.tags.push(`${hedge ? 'H' : 'E'} ${origin}`);
        }
      }
      run = -1;
    };
    for (let t = s0; ; t = Math.min(t + STEP, s1)) {
      const x = ax + ux * t;
      const y = ay + uy * t;
      const near = x >= X0 - MIN_PIECE && x <= X1 + MIN_PIECE && y >= Y0 - MIN_PIECE && y <= Y1 + MIN_PIECE;
      const good = ok(t);
      if (near && good) {
        if (run < 0) run = prevOk || Number.isNaN(prev) ? t : edge(t, prev);
      } else if (run >= 0) flush(good ? prev : edge(prev, t));
      prev = t;
      prevOk = good;
      if (t === s1) {
        flush(t);
        break;
      }
    }
  };

  // --- Blocks: lattice triangles joined across edges without a way --------------------
  const ways = new Set<string>();
  const vcache = new Map<number, [number, number]>();
  const pos = (v: number) => {
    let q = vcache.get(v);
    if (!q) vcache.set(v, (q = vertexPos(v)));
    return q;
  };
  for (const e of edges) ways.add(edgeKey(nearestVertex(e[0], e[1]), nearestVertex(e[2], e[3])));
  const nb = new Map<number, number[]>();
  const nbOf = (v: number) => {
    let a = nb.get(v);
    if (!a) nb.set(v, (a = neighbours(v)));
    return a;
  };
  /** The two triangles' third vertices across edge u–w. */
  const thirds = (u: number, w: number) => nbOf(u).filter((t) => nbOf(w).includes(t));
  const seen = new Set<string>();
  /** Triangles of blocks too large to cut (their land gets furlongs instead, below). */
  const largeTris = new Set<string>();
  const starts: number[][] = [];
  for (const v of verticesIn({ x0: X0 - 160, y0: Y0 - 160, x1: X1 + 160, y1: Y1 + 160 })) {
    const n = nbOf(v);
    for (let a = 0; a < n.length; a++)
      for (let b = a + 1; b < n.length; b++) if (nbOf(n[a]).includes(n[b])) starts.push([v, n[a], n[b]]);
  }
  for (const t0 of starts) {
    const k0 = triKey(t0[0], t0[1], t0[2]);
    if (seen.has(k0)) continue;
    // Flood, stopping once the block is too large.
    const tris: number[][] = [];
    const inBlock = new Set<string>([k0]);
    const queue = [t0];
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    let large = false;
    while (queue.length && !large) {
      const t = queue.pop()!;
      tris.push(t);
      for (const v of t) {
        const [x, y] = pos(v);
        bx0 = Math.min(bx0, x);
        by0 = Math.min(by0, y);
        bx1 = Math.max(bx1, x);
        by1 = Math.max(by1, y);
      }
      if (bx1 - bx0 > BLOCK_MAX || by1 - by0 > BLOCK_MAX) large = true;
      for (let e = 0; e < 3; e++) {
        const u = t[e];
        const w = t[(e + 1) % 3];
        if (ways.has(edgeKey(u, w))) continue;
        for (const o of thirds(u, w)) {
          if (o === t[(e + 2) % 3]) continue;
          const k = triKey(u, w, o);
          if (inBlock.has(k)) continue;
          inBlock.add(k);
          queue.push([u, w, o]);
        }
      }
    }
    for (const k of inBlock) seen.add(k);
    if (large) {
      for (const k of inBlock) largeTris.add(k);
      fieldStats.large = (fieldStats.large ?? 0) + 1;
      continue;
    }
    fieldStats.blocks = (fieldStats.blocks ?? 0) + 1;
    cutBlock(tris, inBlock);
  }

  /** Cuts one block into fields. */
  function cutBlock(tris: number[][], inBlock: Set<string>) {
    // Its outline: way edges with the other side outside the block.
    const outline: Seg[] = [];
    const cracks: Seg[] = [];
    let id = '';
    for (const t of tris) {
      const k = triKey(t[0], t[1], t[2]);
      if (!id || k < id) id = k;
      for (let e = 0; e < 3; e++) {
        const u = t[e];
        const w = t[(e + 1) % 3];
        const other = thirds(u, w).find((o) => o !== t[(e + 2) % 3]);
        if (other !== undefined && inBlock.has(triKey(u, w, other))) {
          // A way with the block on both sides (a dead end): a crack the cuts stop at.
          if (u < w && ways.has(edgeKey(u, w))) cracks.push({ ax: pos(u)[0], ay: pos(u)[1], bx: pos(w)[0], by: pos(w)[1] });
          continue;
        }
        const [ax, ay] = pos(u);
        const [bx, by] = pos(w);
        outline.push({ ax, ay, bx, by });
      }
    }
    if (!outline.length) return;
    const seed = hash3(0xf1e1d, Number(id.split('_')[0]) % 2147483647, Number(id.split('_')[1]) % 2147483647);
    let rs = seed;
    const rand = () => ((rs = hash3(rs, 0x9e37, 0x79b9)) / 4294967296);
    // Centre, style, slope.
    let mx = 0;
    let my = 0;
    for (const s of outline) {
      mx += s.ax + s.bx;
      my += s.ay + s.by;
    }
    mx /= 2 * outline.length;
    my /= 2 * outline.length;
    const st = styleAt(mx, my, p.R[node(mx, my)]);
    // Mean gradient over the block, from the nodes at its triangles' centres.
    let gx = 0;
    let gy = 0;
    for (const t of tris) {
      const [x, y] = [0, 1].map((c) => (pos(t[0])[c] + pos(t[1])[c] + pos(t[2])[c]) / 3);
      gx += p.zE[node(x + 16, y)] - p.zE[node(x - 16, y)];
      gy += p.zE[node(x, y + 16)] - p.zE[node(x, y - 16)];
    }
    gx /= 32 * tris.length;
    gy /= 32 * tris.length;
    // Strip direction: along the contours on a slope, else away from the longest way on the outline.
    let da = 0;
    let best = -1;
    for (const s of outline) {
      const l = Math.hypot(s.bx - s.ax, s.by - s.ay);
      if (l > best) {
        best = l;
        da = Math.atan2(s.by - s.ay, s.bx - s.ax) + Math.PI / 2;
      }
    }
    origin = `block ${id} cracks ${cracks.length}`;
    cutOutline([outline], cracks, rand, st, Math.hypot(gx, gy) > CONTOUR_SLOPE && st !== STRIPS ? Math.atan2(gx, -gy) : da);
  }

  /**
   * Cuts land inside every one of `outlines` (the first spans it) into fields of
   * style `st`, strips running along direction `da` (± a lean), each cut stopping
   * at `cracks` (ways inside the land).
   */
  function cutOutline(outlines: Seg[][], cracks: Seg[], rand: () => number, st: Style, da: number) {
    const outline = outlines[0];
    da += (rand() * 2 - 1) * st.lean * 0.3;
    const dx = Math.cos(da);
    const dy = Math.sin(da);
    // Across the strips: n = d turned a right angle.
    const nx = -dy;
    const ny = dx;
    let s0 = Infinity;
    let s1 = -Infinity;
    let n0 = Infinity;
    let n1 = -Infinity;
    for (const s of outline)
      for (const [x, y] of [
        [s.ax, s.ay],
        [s.bx, s.by],
      ]) {
        s0 = Math.min(s0, x * dx + y * dy);
        s1 = Math.max(s1, x * dx + y * dy);
        n0 = Math.min(n0, x * nx + y * ny);
        n1 = Math.max(n1, x * nx + y * ny);
      }
    /**
     * The cut along P + t·u, within [lo, hi] and the land, split at the cracks: its
     * parts beyond a crack shifted sideways by up to ± shift / 2 (fields either side of
     * a dead-end way don't line up across it).
     */
    const cutLine = (px: number, py: number, ux: number, uy: number, lo: number, hi: number, shift: number, hedge: () => boolean) => {
      for (const whole of insideAll(outlines, px, py, ux, uy))
        splitAt(cracks, px, py, ux, uy, [whole]).forEach(([t0, t1], m) => {
          let qx = px;
          let qy = py;
          let r0 = t0;
          let r1 = t1;
          if (m > 0) {
            const d = (rand() - 0.5) * shift;
            qx -= uy * d;
            qy += ux * d;
            // The shifted line's stretch of land overlapping this part.
            let ov = 0;
            for (const [c0, c1] of splitAt(cracks, qx, qy, ux, uy, insideAll(outlines, qx, qy, ux, uy))) {
              const o = Math.min(c1, t1) - Math.max(c0, t0);
              if (o > ov) {
                ov = o;
                r0 = c0;
                r1 = c1;
              }
            }
            if (ov <= 0) return;
          }
          const a0 = Math.max(r0, lo);
          const a1 = Math.min(r1, hi);
          if (a1 > a0) emit(qx + ux * a0, qy + uy * a0, qx + ux * a1, qy + uy * a1, hedge());
        });
    };
    // Furlongs: bands across d, their dividing cuts leaning a little (much in bocage).
    const bands: { px: number; py: number; mx: number; my: number }[] = [];
    for (let s = s0 + lerp(st.L[0], st.L[1], rand()); s < s1 - st.L[0] / 2; s += lerp(st.L[0], st.L[1], rand())) {
      const a = da + Math.PI / 2 + (rand() * 2 - 1) * st.lean;
      // Through the band line's point at the block's middle (across), turned by the lean.
      const c = (n0 + n1) / 2;
      const px = dx * s + nx * c;
      const py = dy * s + ny * c;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      bands.push({ px, py, mx: -uy, my: ux });
      cutLine(px, py, ux, uy, -Infinity, Infinity, st.L[0] / 2, () => rand() < st.hedge);
    }
    // Strips within each furlong: cuts along d, at field widths across it.
    for (let b = 0; b <= bands.length; b++) {
      const lo = b > 0 ? bands[b - 1] : null;
      const hi = b < bands.length ? bands[b] : null;
      for (let n = n0 + lerp(st.w[0], st.w[1], rand()); n < n1 - st.w[0] / 2; n += lerp(st.w[0], st.w[1], rand())) {
        const a = da + (rand() * 2 - 1) * st.lean;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        const px = nx * n + dx * ((s0 + s1) / 2);
        const py = ny * n + dy * ((s0 + s1) / 2);
        // Within the furlong: between its two band cuts (half-planes along their normals, which point along +d).
        let tl = -Infinity;
        let th = Infinity;
        for (const [bd, sign] of [
          [lo, 1],
          [hi, -1],
        ] as const) {
          if (!bd) continue;
          const m = (bd.mx * dx + bd.my * dy > 0 ? 1 : -1) * sign;
          const den = (ux * bd.mx + uy * bd.my) * m;
          const off = ((px - bd.px) * bd.mx + (py - bd.py) * bd.my) * m;
          if (Math.abs(den) < 1e-9) {
            if (off < 0) tl = Infinity;
            continue;
          }
          const t = -off / den;
          if (den > 0) tl = Math.max(tl, t);
          else th = Math.min(th, t);
        }
        if (tl >= th) continue;
        const hedge = rand() < st.hedge;
        cutLine(px, py, ux, uy, tl, th, st.w[0], () => hedge);
      }
    }
  }

  // --- Furlongs: the land of blocks too large to cut ---------------------------------
  // Cells of a jittered grid (Voronoi), split by the ways into pieces (the lattice
  // triangles meeting the cell, joined across edges without a way): each piece of a
  // large block is cut like a block, clipped to its cell, its strips square to its
  // longest way; the cells' edges are field edges too.
  if (largeTris.size) {
    const seedAt = (i: number, j: number): [number, number] => {
      const h = hash3(0xf0e1, i, j);
      return [(i + 0.5 + ((h & 0xffff) / 65536 - 0.5) * 2 * FURLONG_JITTER) * FURLONG, (j + 0.5 + ((h >>> 16) / 65536 - 0.5) * 2 * FURLONG_JITTER) * FURLONG];
    };
    for (let j = Math.floor((Y0 - 1.5 * FURLONG) / FURLONG); j <= Math.floor((Y1 + 1.5 * FURLONG) / FURLONG); j++)
      for (let i = Math.floor((X0 - 1.5 * FURLONG) / FURLONG); i <= Math.floor((X1 + 1.5 * FURLONG) / FURLONG); i++) {
        const [qx, qy] = seedAt(i, j);
        // The cell: a square round the seed cut by the bisectors with its neighbours; each edge labelled by the neighbour across it.
        let poly: { x: number; y: number; nb: number }[] = [
          { x: qx - 2 * FURLONG, y: qy - 2 * FURLONG, nb: -1 },
          { x: qx + 2 * FURLONG, y: qy - 2 * FURLONG, nb: -1 },
          { x: qx + 2 * FURLONG, y: qy + 2 * FURLONG, nb: -1 },
          { x: qx - 2 * FURLONG, y: qy + 2 * FURLONG, nb: -1 },
        ];
        const nbs: [number, number][] = [];
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if (di || dj) nbs.push([i + di, j + dj]);
        nbs.forEach(([ni, nj], idx) => {
          const [ox, oy] = seedAt(ni, nj);
          const mx = (qx + ox) / 2;
          const my = (qy + oy) / 2;
          const side = (x: number, y: number) => (x - mx) * (ox - qx) + (y - my) * (oy - qy); // ≤ 0: our side
          const next: typeof poly = [];
          for (let k = 0; k < poly.length; k++) {
            const A = poly[k];
            const B = poly[(k + 1) % poly.length];
            const sa = side(A.x, A.y);
            const sb = side(B.x, B.y);
            if (sa <= 0) next.push(A);
            // Leaving our side: the new vertex starts the edge along the bisector; entering it, A's edge goes on.
            if ((sa <= 0) !== (sb <= 0)) next.push({ x: A.x + (sa / (sa - sb)) * (B.x - A.x), y: A.y + (sa / (sa - sb)) * (B.y - A.y), nb: sa <= 0 ? idx : A.nb });
          }
          poly = next;
        });
        if (poly.length < 3) continue;
        const xs = poly.map((v) => v.x);
        const ys = poly.map((v) => v.y);
        if (Math.max(...xs) < X0 - END_EXT || Math.min(...xs) > X1 + END_EXT || Math.max(...ys) < Y0 - END_EXT || Math.min(...ys) > Y1 + END_EXT) continue;
        const cell: Seg[] = poly.map((v, k) => ({ ax: v.x, ay: v.y, bx: poly[(k + 1) % poly.length].x, by: poly[(k + 1) % poly.length].y }));
        const inCell = (x: number, y: number) => intervals(cell, x - 1e4, y, 1, 0).some(([a, b]) => a <= 1e4 && b >= 1e4);
        // The lattice triangles meeting the cell.
        const tris = new Map<string, number[]>();
        for (const v of verticesIn({ x0: Math.min(...xs) - 160, y0: Math.min(...ys) - 160, x1: Math.max(...xs) + 160, y1: Math.max(...ys) + 160 })) {
          const n = nbOf(v);
          for (let a = 0; a < n.length; a++)
            for (let b = a + 1; b < n.length; b++) {
              if (!nbOf(n[a]).includes(n[b])) continue;
              const t = [v, n[a], n[b]];
              const k = triKey(v, n[a], n[b]);
              if (tris.has(k)) continue;
              const [P, Q, S] = t.map(pos);
              const meets =
                inCell(P[0], P[1]) || inCell(Q[0], Q[1]) || inCell(S[0], S[1]) || poly.some((c) => inTriangle(c.x, c.y, P, Q, S)) ||
                cell.some((e) => [[P, Q], [Q, S], [S, P]].some(([U, V]) => segsCross(e.ax, e.ay, e.bx, e.by, U[0], U[1], V[0], V[1])));
              if (meets) tris.set(k, t);
            }
        }
        // Pieces: joined across edges without a way.
        const done = new Set<string>();
        let piece = 0;
        for (const [k0, t0] of tris) {
          if (done.has(k0)) continue;
          const comp: number[][] = [];
          const inComp = new Set<string>([k0]);
          const queue = [t0];
          done.add(k0);
          while (queue.length) {
            const t = queue.pop()!;
            comp.push(t);
            for (let e = 0; e < 3; e++) {
              const u = t[e];
              const w = t[(e + 1) % 3];
              if (ways.has(edgeKey(u, w))) continue;
              for (const o of thirds(u, w)) {
                const k = triKey(u, w, o);
                if (o === t[(e + 2) % 3] || inComp.has(k) || !tris.has(k)) continue;
                inComp.add(k);
                done.add(k);
                queue.push([u, w, o]);
              }
            }
          }
          piece++;
          // Only the large blocks' pieces (their triangles near the chunk were flooded above), and only those near the chunk.
          const near = comp.find((t) => t.some((v) => {
            const [x, y] = pos(v);
            return x >= X0 - 120 && x <= X1 + 120 && y >= Y0 - 120 && y <= Y1 + 120;
          }));
          if (!near || !largeTris.has(triKey(near[0], near[1], near[2]))) continue;
          fieldStats.furlongs = (fieldStats.furlongs ?? 0) + 1;
          // Its outline (ways, and the edges to the triangles beyond the cell), and its longest way.
          const outline: Seg[] = [];
          const cracks: Seg[] = [];
          let da = 0;
          let best = -1;
          for (const t of comp)
            for (let e = 0; e < 3; e++) {
              const u = t[e];
              const w = t[(e + 1) % 3];
              const other = thirds(u, w).find((o) => o !== t[(e + 2) % 3]);
              if (other !== undefined && inComp.has(triKey(u, w, other))) {
                if (u < w && ways.has(edgeKey(u, w))) cracks.push({ ax: pos(u)[0], ay: pos(u)[1], bx: pos(w)[0], by: pos(w)[1] });
                continue;
              }
              const [ax, ay] = pos(u);
              const [bx, by] = pos(w);
              outline.push({ ax, ay, bx, by });
              if (ways.has(edgeKey(u, w)) && Math.hypot(bx - ax, by - ay) > best) {
                best = Math.hypot(bx - ax, by - ay);
                da = Math.atan2(by - ay, bx - ax) + Math.PI / 2;
              }
            }
          let rs = hash3(0xf0e2 + piece, i, j);
          const rand = () => (rs = hash3(rs, 0x9e37, 0x79b9)) / 4294967296;
          // No way on its outline: square to the nearest way, else any way.
          if (best < 0) {
            da = rand() * Math.PI;
            let bd = FURLONG_WAY;
            for (const e of edges) {
              const d = segPointDist(e[0], e[1], e[2], e[3], qx, qy);
              if (d < bd) {
                bd = d;
                da = Math.atan2(e[3] - e[1], e[2] - e[0]) + Math.PI / 2;
              }
            }
          }
          const st = styleAt(qx, qy, p.R[node(qx, qy)]);
          const gx = (p.zE[node(qx + 48, qy)] - p.zE[node(qx - 48, qy)]) / 96;
          const gy = (p.zE[node(qx, qy + 48)] - p.zE[node(qx, qy - 48)]) / 96;
          origin = `furlong ${i},${j}/${piece}`;
          cutOutline([outline, cell], cracks, rand, st, Math.hypot(gx, gy) > CONTOUR_SLOPE && st !== STRIPS ? Math.atan2(gx, -gy) : da);
          // The cell's edges within the piece, each drawn by the cell with the lower index.
          poly.forEach((v, k) => {
            if (v.nb < 0) return;
            const [ni, nj] = nbs[v.nb];
            if (nj < j || (nj === j && ni < i)) return;
            const w = poly[(k + 1) % poly.length];
            const l = Math.hypot(w.x - v.x, w.y - v.y);
            const ux = (w.x - v.x) / l;
            const uy = (w.y - v.y) / l;
            const hedge = hash3(0xf0e3, i * 7 + ni, j * 7 + nj) / 4294967296 < st.hedge;
            origin = `cell edge ${i},${j}`;
            for (const [t0, t1] of splitAt(cracks, v.x, v.y, ux, uy, intervals(outline, v.x, v.y, ux, uy))) {
              const a0 = Math.max(0, t0);
              const a1 = Math.min(l, t1);
              if (a1 > a0) emit(v.x + ux * a0, v.y + uy * a0, v.x + ux * a1, v.y + uy * a1, hedge);
            }
          });
        }
      }
  }

  // --- Way-side hedges (lanes in bocage) ----------------------------------------------
  for (const r of roads) {
    if (r.cls === ROAD_P) continue;
    const n = r.xy.length / 2;
    if (n < 2) continue;
    const m = 2 * Math.floor(n / 2);
    const st = styleAt(r.xy[m], r.xy[m + 1], p.R[node(r.xy[m], r.xy[m + 1])]);
    const S = r.xy;
    const total: number[] = [0];
    for (let i = 1; i < n; i++) total.push(total[i - 1] + Math.hypot(S[2 * i] - S[2 * i - 2], S[2 * i + 1] - S[2 * i - 1]));
    if (total[n - 1] < 2 * LANE_END + MIN_PIECE) continue;
    for (const side of [1, -1]) {
      if (hash3(0x1a4e + side, hashString(r.key), 7) / 4294967296 >= st.lane * (r.cls === ROAD_T ? 1 : 0.8)) continue;
      const off = WAY_CLEAR[r.cls] + HEDGE_OFF;
      // Offset vertices (normal from the neighbouring vertices), trimmed at the ends.
      for (let i = 1; i < n; i++) {
        if (total[i] < LANE_END || total[i - 1] > total[n - 1] - LANE_END) continue;
        const pt = (k: number): [number, number] => {
          const a = Math.max(0, k - 1);
          const b = Math.min(n - 1, k + 1);
          const tx = S[2 * b] - S[2 * a];
          const ty = S[2 * b + 1] - S[2 * a + 1];
          const l = Math.hypot(tx, ty) || 1;
          return [S[2 * k] - (ty / l) * off * side, S[2 * k + 1] + (tx / l) * off * side];
        };
        const [x0, y0] = pt(i - 1);
        const [x1, y1] = pt(i);
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        if (mx < X0 || mx > X1 || my < Y0 || my > Y1) continue;
        // Every 2 m: clear of other ways (at junctions, and where one ends close by) and on farmland.
        const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
        let a = -1;
        for (let q = 0; q <= k; q++) {
          const good = !onWay(x0 + ((x1 - x0) * q) / k, y0 + ((y1 - y0) * q) / k, -0.5) && farmland(x0 + ((x1 - x0) * q) / k, y0 + ((y1 - y0) * q) / k);
          if (good && a < 0) a = q;
          if ((!good || q === k) && a >= 0) {
            const b = good ? q : q - 1;
            if (b > a) {
              out.hedges.push(x0 + ((x1 - x0) * a) / k, y0 + ((y1 - y0) * a) / k, x0 + ((x1 - x0) * b) / k, y0 + ((y1 - y0) * b) / k);
              if (fieldOrigins.on) fieldOrigins.tags.push(`H lane ${r.key}`);
            }
            a = -1;
          }
        }
      }
    }
  }
  return out;
}

function inTriangle(x: number, y: number, P: [number, number], Q: [number, number], S: [number, number]): boolean {
  const d1 = (Q[0] - P[0]) * (y - P[1]) - (Q[1] - P[1]) * (x - P[0]);
  const d2 = (S[0] - Q[0]) * (y - Q[1]) - (S[1] - Q[1]) * (x - Q[0]);
  const d3 = (P[0] - S[0]) * (y - S[1]) - (P[1] - S[1]) * (x - S[0]);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
