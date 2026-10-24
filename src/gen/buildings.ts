import { lerp } from '../lib/noise';

/**
 * Buildings along a settlement's streets — part of its plan (town.ts), so a pure
 * function of the same inputs, drawn alike by every chunk.
 *
 * Both sides of every built-up front (its streets, and the stretches of road
 * through built-up land) are walked from end to end, main roads first, and a
 * footprint — a rectangle square to the street — is tried at each step. Two
 * densities:
 *  - dense (the old core): terraced rows flush with the street, wall to wall,
 *    now and then a gap for an alley or a yard;
 *  - loose (everywhere else): detached houses set back from the street with
 *    gardens between them, now and then a barn.
 * A footprint is kept only if it stays clear of every road and street (by its
 * half width and a margin), of other buildings, of water and of steep ground;
 * one that clashes with a street behind it is tried shallower first.
 *
 * Output: four corners per building, [x0, y0, … x3, y3] each, in world metres.
 */

/** A drawn way, kept clear by `clear` metres either side of its centre line. */
export interface Way {
  xy: Float32Array;
  clear: number;
}

export interface BuildingInput {
  /** Polylines built up on both sides, in the order they are to be built (`main`: a main road). */
  fronts: { xy: Float32Array; main: boolean }[];
  ways: Way[];
  /** Is (x, y) in the dense zone (on a main road, or a street)? */
  dense: (x: number, y: number, main: boolean) => boolean;
  /** Can a building corner stand at (x, y)? (Dry, not too steep, inside the plan.) */
  ok: (x: number, y: number) => boolean;
  rand: () => number;
  /** Gaps between loose buildings are scaled by this (hamlets: sparser). */
  gapScale?: number;
}

/** Footprint sizes (m): along the street × back from it, and the gap to the next. */
const DENSE = { w: [6, 11], d: [9, 14], setback: 0.4, alley: 0.15, alleyW: [3, 6] };
const LOOSE = { w: [8, 13], d: [7, 11], setback: [3, 8], gap: [5, 16], barn: 0.12, barnW: [14, 22], barnD: [9, 12] };
/** Where a house won't fit, a small one close to the street (w, d, setback; m). */
const SMALL = { w: [6, 8], d: [6, 8], setback: [1.5, 3] };
/** Steps (m) after a footprint that didn't fit. */
const RETRY_STEP = [2, 4];
/** Buildings may share walls: overlaps this small don't count (m). */
const TOUCH = 0.3;
/** A footprint clashing at full depth is tried again at this fraction of it, if still this deep (m). */
const SHALLOW = 0.62;
const MIN_DEPTH = 5;
/** …and one that won't fit at full width at this fraction of it, if still this wide (m). */
const NARROW = 0.55;
const MIN_WIDTH = 4;

const CELL = 16;

/** Debugging: why footprints were refused, summed over calls. */
export const buildingStats: Record<string, number> = {};
const note = (k: string) => (buildingStats[k] = (buildingStats[k] ?? 0) + 1);

export function placeBuildings({ fronts, ways, dense, ok, rand, gapScale = 1 }: BuildingInput): Float32Array {
  // Way pieces in a grid, for clearance tests.
  const wayGrid = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  const pieces: { ax: number; ay: number; bx: number; by: number; clear: number }[] = [];
  for (const w of ways) {
    for (let k = 2; k < w.xy.length; k += 2) {
      const p = { ax: w.xy[k - 2], ay: w.xy[k - 1], bx: w.xy[k], by: w.xy[k + 1], clear: w.clear };
      const id = pieces.push(p) - 1;
      const r = w.clear;
      for (let j = Math.floor((Math.min(p.ay, p.by) - r) / CELL); j <= Math.floor((Math.max(p.ay, p.by) + r) / CELL); j++)
        for (let i = Math.floor((Math.min(p.ax, p.bx) - r) / CELL); i <= Math.floor((Math.max(p.ax, p.bx) + r) / CELL); i++) {
          const g = key(i, j);
          let a = wayGrid.get(g);
          if (!a) wayGrid.set(g, (a = []));
          a.push(id);
        }
    }
  }
  /** The clearance of the way whose centre line passes through (x, y), or the widest within 1 m. */
  const clearAt = (x: number, y: number) => {
    let c = 0;
    for (const id of wayGrid.get(key(Math.floor(x / CELL), Math.floor(y / CELL))) ?? []) {
      const p = pieces[id];
      if (segPointDist(p.ax, p.ay, p.bx, p.by, x, y) < 1) c = Math.max(c, p.clear);
    }
    return c;
  };
  /** Does quad q come closer to any way than its clearance? */
  const clashesWay = (q: number[]) => {
    const [x0, y0, x1, y1] = bbox(q);
    const seen = new Set<number>();
    for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++)
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
        for (const id of wayGrid.get(key(i, j)) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const p = pieces[id];
          if (segQuadDist(p.ax, p.ay, p.bx, p.by, q) < p.clear) return true;
        }
    return false;
  };

  // Buildings placed so far, in a grid by bounding box.
  const out: number[] = [];
  const bGrid = new Map<number, number[]>();
  const clashesBuilding = (q: number[]) => {
    const [x0, y0, x1, y1] = bbox(q);
    const seen = new Set<number>();
    for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++)
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
        for (const b of bGrid.get(key(i, j)) ?? []) {
          if (seen.has(b)) continue;
          seen.add(b);
          if (quadsOverlap(q, out.slice(8 * b, 8 * b + 8), TOUCH)) return true;
        }
    return false;
  };
  const add = (q: number[]) => {
    const b = out.length / 8;
    out.push(...q);
    const [x0, y0, x1, y1] = bbox(q);
    for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++)
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
        const g = key(i, j);
        let a = bGrid.get(g);
        if (!a) bGrid.set(g, (a = []));
        a.push(b);
      }
  };

  for (const { xy, main } of fronts) {
    const n = xy.length / 2;
    if (n < 2) continue;
    const S = [0];
    for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(xy[2 * i] - xy[2 * i - 2], xy[2 * i + 1] - xy[2 * i - 1]));
    const L = S[n - 1];
    const at = (s: number): [number, number] => {
      s = Math.max(0, Math.min(L, s));
      let k = 0;
      while (k < n - 2 && S[k + 1] < s) k++;
      const t = (s - S[k]) / (S[k + 1] - S[k] || 1);
      return [xy[2 * k] + t * (xy[2 * k + 2] - xy[2 * k]), xy[2 * k + 1] + t * (xy[2 * k + 3] - xy[2 * k + 1])];
    };
    for (const side of [1, -1]) {
      let s = rand() * 4;
      while (s < L - 4) {
        const [px, py] = at(s);
        const isDense = dense(px, py, main);
        let w: number;
        let d: number;
        let setback: number;
        let gap: number;
        if (isDense) {
          w = lerp(DENSE.w[0], DENSE.w[1], rand());
          d = lerp(DENSE.d[0], DENSE.d[1], rand());
          setback = DENSE.setback;
          gap = rand() < DENSE.alley ? lerp(DENSE.alleyW[0], DENSE.alleyW[1], rand()) : 0;
        } else if (rand() < LOOSE.barn) {
          w = lerp(LOOSE.barnW[0], LOOSE.barnW[1], rand());
          d = lerp(LOOSE.barnD[0], LOOSE.barnD[1], rand());
          setback = lerp(LOOSE.setback[0], LOOSE.setback[1], rand());
          gap = lerp(LOOSE.gap[0], LOOSE.gap[1], rand()) * gapScale;
        } else {
          w = lerp(LOOSE.w[0], LOOSE.w[1], rand());
          d = lerp(LOOSE.d[0], LOOSE.d[1], rand());
          setback = lerp(LOOSE.setback[0], LOOSE.setback[1], rand());
          gap = lerp(LOOSE.gap[0], LOOSE.gap[1], rand()) * gapScale;
        }
        if (s + MIN_WIDTH > L) break;
        // A row that won't take a full plot here takes a narrower one (bends, corners);
        // where a house won't fit, a small one close to the street may (no stretch of
        // street left bare for want of room behind it).
        const tries: [number, number, number][] = isDense
          ? [
              [w, d, setback],
              [w * NARROW, d, setback],
            ]
          : [
              [w, d, setback],
              [lerp(SMALL.w[0], SMALL.w[1], rand()), lerp(SMALL.d[0], SMALL.d[1], rand()), lerp(SMALL.setback[0], SMALL.setback[1], rand())],
            ];
        let placed = 0;
        for (const [width, dd, sb] of tries) {
          if (width < MIN_WIDTH || s + width > L) continue;
          // Square to the street at the middle of the plot.
          const [ax, ay] = at(s);
          const [bx, by] = at(s + width);
          const [mx, my] = at(s + width / 2);
          let tx = bx - ax;
          let ty = by - ay;
          const tl = Math.hypot(tx, ty) || 1;
          tx /= tl;
          ty /= tl;
          const nx = -ty * side;
          const ny = tx * side;
          const off = clearAt(mx, my) + sb;
          for (const depth of [dd, dd * SHALLOW]) {
            if (depth < MIN_DEPTH) break;
            // As stored (Float32): tests then agree with what's drawn.
            const q = rect(mx, my, tx, ty, nx, ny, width, off, depth).map(Math.fround);
            let fits = true;
            for (let c = 0; c < 8 && fits; c += 2) fits = ok(q[c], q[c + 1]);
            if (!fits || !ok((q[0] + q[4]) / 2, (q[1] + q[5]) / 2)) {
              note(`${isDense ? 'dense' : 'loose'}: ground`);
              break;
            }
            if (clashesWay(q)) {
              note(`${isDense ? 'dense' : 'loose'}: way`);
              continue;
            }
            if (clashesBuilding(q)) {
              note(`${isDense ? 'dense' : 'loose'}: building`);
              continue;
            }
            note(`${isDense ? 'dense' : 'loose'}: PLACED`);
            add(q);
            placed = width;
            break;
          }
          if (placed) break;
        }
        s += placed ? placed + gap : RETRY_STEP[isDense ? 0 : 1];
      }
    }
  }
  return Float32Array.from(out);
}

/** Rectangle `w` along (tx, ty) centred on (mx, my), from `off` to `off + d` along (nx, ny). */
function rect(mx: number, my: number, tx: number, ty: number, nx: number, ny: number, w: number, off: number, d: number): number[] {
  const hx = (tx * w) / 2;
  const hy = (ty * w) / 2;
  const ox = mx + nx * off;
  const oy = my + ny * off;
  const fx = nx * d;
  const fy = ny * d;
  return [ox - hx, oy - hy, ox + hx, oy + hy, ox + hx + fx, oy + hy + fy, ox - hx + fx, oy - hy + fy];
}

function bbox(q: number[]): [number, number, number, number] {
  return [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];
}

export function segPointDist(ax: number, ay: number, bx: number, by: number, x: number, y: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
  return Math.hypot(ax + t * dx - x, ay + t * dy - y);
}

function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function inQuad(q: number[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = q[2 * i];
    const ay = q[2 * i + 1];
    const bx = q[(2 * i + 2) % 8];
    const by = q[(2 * i + 3) % 8];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign && Math.sign(c) !== sign) return false;
      sign = Math.sign(c);
    }
  }
  return true;
}

/** Distance from segment a–b to convex quad q (0 if they meet). */
export function segQuadDist(ax: number, ay: number, bx: number, by: number, q: number[]): number {
  if (inQuad(q, ax, ay) || inQuad(q, bx, by)) return 0;
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const cx = q[2 * i];
    const cy = q[2 * i + 1];
    const dx = q[(2 * i + 2) % 8];
    const dy = q[(2 * i + 3) % 8];
    if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
    d = Math.min(d, segPointDist(ax, ay, bx, by, cx, cy), segPointDist(cx, cy, dx, dy, ax, ay), segPointDist(cx, cy, dx, dy, bx, by));
  }
  return d;
}

/** Do convex quads a and b overlap by more than `tol` (separating axis test)? */
export function quadsOverlap(a: ArrayLike<number>, b: ArrayLike<number>, tol: number): boolean {
  for (const q of [a, b])
    for (let i = 0; i < 4; i++) {
      const ex = q[(2 * i + 2) % 8] - q[2 * i];
      const ey = q[(2 * i + 3) % 8] - q[2 * i + 1];
      const l = Math.hypot(ex, ey) || 1;
      const ax = -ey / l;
      const ay = ex / l;
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (let k = 0; k < 4; k++) {
        const pa = a[2 * k] * ax + a[2 * k + 1] * ay;
        const pb = b[2 * k] * ax + b[2 * k + 1] * ay;
        amin = Math.min(amin, pa);
        amax = Math.max(amax, pa);
        bmin = Math.min(bmin, pb);
        bmax = Math.max(bmax, pb);
      }
      if (amax - bmin <= tol || bmax - amin <= tol) return false;
    }
  return true;
}
