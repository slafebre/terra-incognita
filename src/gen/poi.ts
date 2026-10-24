import { CHUNK } from '../lib/constants';
import { hash3 } from '../lib/hash';
import { lerp, smoothstep } from '../lib/noise';
import { segPointDist, segQuadDist } from './buildings';
import { streamThreshold } from './dem';
import { DX, DY, NODE } from './hydro';
import { ROAD_C, type RoadPatch, type SegmentPath } from './roads';
import type { TownPlan } from './town';

/**
 * Points of interest: small symbols the land and the network suggest.
 *  - hilltops: a chapel (where a way leads up) or a cross on summits that rise
 *    clearly above their surroundings, summit crosses on prominent mountain tops,
 *    triangulation points on the major summits;
 *  - wayside crosses (calvaries) at some junctions out in the country;
 *  - springs at some stream heads in hill and mountain country.
 * (Water towers and reservoirs belong to villages and towns: their plans place them.)
 *
 * Drawn per chunk, decided per point: a point is kept or not from the fine nodes
 * within POI_READ of it, the ways drawn near it and the plans' buildings, which every
 * chunk drawing near it sees alike (fine nodes come from their own chunk's solve). So
 * symbols straddling a chunk border are drawn whole by both chunks.
 */

export const CHAPEL = 0;
export const CROSS = 1;
export const TRIG = 2;
export const SPRING = 3;
export const TOWER = 4;
export const RESERVOIR = 5;
export type PoiKind = typeof CHAPEL | typeof CROSS | typeof TRIG | typeof SPRING | typeof TOWER | typeof RESERVOIR;

export interface Poi {
  kind: PoiKind;
  x: number;
  y: number;
}

/** Fine nodes with what springs and summits read: receivers and region too. */
export interface PoiPatch extends RoadPatch {
  rec: Int8Array;
  R: Float32Array;
}

/** A chunk decides the points within POI_MARGIN m of it (symbols reach that far across its border). */
export const POI_MARGIN = 16;
/** What a point's decision reads, around it (m): the fine nodes for summits. */
export const POI_READ = 680;
/** Nodes the patch reaches beyond the chunk. */
export const POI_PAD = Math.ceil((POI_READ + POI_MARGIN) / NODE) + 2;

/** A hilltop: the highest node within HILL_R m, standing HILL_RISE m above the mean of the ground HILL_R m round it. */
const HILL_R = 240;
const HILL_RISE = 15;
/** A major summit: the highest within MAJOR_R m, MAJOR_RISE m above the ground MAJOR_RING m round it. */
const MAJOR_R = 640;
const MAJOR_RING = 480;
const MAJOR_RISE = 40;
/** Chances per hilltop (lowland and hills → mountains): a chapel (only where a way passes within REACHED m), a cross. */
const CHAPEL_CHANCE = [0.2, 0.1];
const CROSS_CHANCE = [0.22, 0.2];
/** …a summit cross on a major mountain summit (from R = MOUNTAIN). */
const SUMMIT_CROSS = 0.55;
const MOUNTAIN = 0.52;
/** Chapels stand only below this region (above it: crosses). */
const CHAPEL_MAX_R = 0.8;
const REACHED = 120;
/** Chance of a triangulation point on a major summit with no other symbol. */
const TRIG_CHANCE = 0.6;
/** Wayside crosses: chance per rural junction of 3 or more ways (one a road, not a track or path); set this far (m) beyond the ways' clearance, in the widest gap between them. */
const JUNCTION_CROSS = 0.2;
const JUNCTION_OFF = 5;
/** …at most this far from the junction (m). */
const JUNCTION_REACH = 30;
/** Clearance from a way's centre line (m), per class (N, D, C, track, path). */
const WAY_CLEAR = [6, 5, 4, 2.5, 1.5];
/** Springs: chance per stream head, from R = 0.25 (hills) to 0.8 (alpine); none below SPRING_MIN_R. */
const SPRING_CHANCE = [0.25, 0.5];
const SPRING_MIN_R = 0.25;
/** No symbol this close to a building (hilltops, crosses: built-up land), or to a street (m). */
const BUILT_CLEAR = 20;
const STREET_CLEAR = 12;

export interface PoiInput {
  cx: number;
  cy: number;
  patch: PoiPatch;
  /** The ways drawn in and around the chunk (the plans' redrawn roads included). */
  roads: SegmentPath[];
  /** Plans drawing into the chunk. */
  plans: TownPlan[];
}

export function placePois({ cx, cy, patch: p, roads, plans }: PoiInput): Poi[] {
  const out: Poi[] = [];
  const { w, h } = p;
  const x0 = cx * CHUNK - POI_MARGIN;
  const y0 = cy * CHUNK - POI_MARGIN;
  const x1 = (cx + 1) * CHUNK + POI_MARGIN;
  const y1 = (cy + 1) * CHUNK + POI_MARGIN;
  const inside = (x: number, y: number, m = 0) => x >= x0 - m && x < x1 + m && y >= y0 - m && y < y1 + m;
  const at = (i: number, j: number) => j * w + i;
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
  /** A fixed random number for a node or place, by kind. */
  const chance = (salt: number, a: number, b: number) => hash3(0x9017 + salt, a, b) / 4294967296;

  // Buildings and streets near the chunk.
  const quads: number[][] = [];
  const streets: Float32Array[] = [];
  for (const pl of plans) {
    for (let i = 0; i < pl.buildings.length; i += 8) {
      const q = Array.from(pl.buildings.subarray(i, i + 8));
      if (q[0] > x0 - 80 && q[0] < x1 + 80 && q[1] > y0 - 80 && q[1] < y1 + 80) quads.push(q);
    }
    for (const s of pl.streets) streets.push(s.xy);
  }
  const nearBuilding = (x: number, y: number, r: number) =>
    quads.some((q) => Math.abs(q[0] - x) < r + 80 && Math.abs(q[1] - y) < r + 80 && segQuadDist(x, y, x, y, q) < r);
  const nearLine = (lines: Float32Array[], x: number, y: number, r: number) =>
    lines.some((xy) => {
      for (let k = 2; k < xy.length; k += 2) if (segPointDist(xy[k - 2], xy[k - 1], xy[k], xy[k + 1], x, y) < r) return true;
      return false;
    });
  const built = (x: number, y: number) => nearBuilding(x, y, BUILT_CLEAR) || nearLine(streets, x, y, STREET_CLEAR);
  const ways = roads.map((r) => r.xy);

  // --- Hilltops and summits ---------------------------------------------------------
  const i0 = Math.ceil(x0 / NODE) - p.gx;
  const i1 = Math.floor((x1 - 1e-6) / NODE) - p.gx;
  const j0 = Math.ceil(y0 / NODE) - p.gy;
  const j1 = Math.floor((y1 - 1e-6) / NODE) - p.gy;
  /** Is node (i, j) higher than every node within r m (ties broken by position)? */
  const highest = (i: number, j: number, r: number) => {
    const n = Math.ceil(r / NODE);
    const z = p.zE[at(i, j)];
    const hk = hash3(0x5a11, p.gx + i, p.gy + j);
    for (let dj = -n; dj <= n; dj++)
      for (let di = -n; di <= n; di++) {
        if ((di === 0 && dj === 0) || di * di + dj * dj > n * n) continue;
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) return false;
        const zz = p.zE[at(ii, jj)];
        if (zz > z || (zz === z && hash3(0x5a11, p.gx + ii, p.gy + jj) > hk)) return false;
      }
    return true;
  };
  /** Height above the mean of the ground r m round (x, y). */
  const rise = (x: number, y: number, r: number) => {
    let s = 0;
    for (let q = 0; q < 16; q++) s += zAt(x + r * Math.cos((q * Math.PI) / 8), y + r * Math.sin((q * Math.PI) / 8));
    return zAt(x, y) - s / 16;
  };
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = at(i, j);
      const z = p.zE[k];
      // Quick test against the 8 neighbours first.
      let top = true;
      for (let d = 0; d < 8 && top; d++) if (p.zE[at(i + DX[d], j + DY[d])] > z) top = false;
      if (!top || !Number.isNaN(p.lake[k]) || !highest(i, j, HILL_R)) continue;
      const x = (p.gx + i) * NODE;
      const y = (p.gy + j) * NODE;
      if (rise(x, y, HILL_R) < HILL_RISE || built(x, y)) continue;
      const R = p.R[k];
      const mount = smoothstep(0.25, MOUNTAIN, R);
      const major = rise(x, y, MAJOR_RING) >= MAJOR_RISE && highest(i, j, MAJOR_R);
      const reached = nearLine(ways, x, y, REACHED);
      const u = chance(1, p.gx + i, p.gy + j);
      const chapel = R < CHAPEL_MAX_R && reached ? lerp(CHAPEL_CHANCE[0], CHAPEL_CHANCE[1], mount) : 0;
      const cross = R >= MOUNTAIN && major ? SUMMIT_CROSS : lerp(CROSS_CHANCE[0], CROSS_CHANCE[1], mount);
      if (u < chapel) out.push({ kind: CHAPEL, x, y });
      else if (u < chapel + cross) out.push({ kind: CROSS, x, y });
      else if (major && chance(2, p.gx + i, p.gy + j) < TRIG_CHANCE) out.push({ kind: TRIG, x, y });
    }

  // --- Springs: stream heads, as the DEM draws streams ----------------------------
  const target = (k: number) => {
    const r = p.rec[k];
    if (r < 0) return -1;
    const i = (k % w) + DX[r];
    const j = Math.floor(k / w) + DY[r];
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };
  const stream = (k: number) => p.A[k] >= streamThreshold(p.R[k]);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = at(i, j);
      const R = p.R[k];
      if (R < SPRING_MIN_R || !stream(k) || !Number.isNaN(p.lake[k])) continue;
      // A head: no stream flows into it.
      let fed = false;
      for (let d = 0; d < 8 && !fed; d++) {
        const q = at(i + DX[d], j + DY[d]);
        if (target(q) === k && stream(q)) fed = true;
      }
      if (fed) continue;
      if (chance(3, p.gx + i, p.gy + j) >= lerp(SPRING_CHANCE[0], SPRING_CHANCE[1], smoothstep(SPRING_MIN_R, 0.8, R))) continue;
      const x = (p.gx + i) * NODE;
      const y = (p.gy + j) * NODE;
      if (!built(x, y)) out.push({ kind: SPRING, x, y });
    }

  // --- Wayside crosses at junctions --------------------------------------------------
  // Ways meet at shared, bit-identical end points.
  const ends = new Map<string, { x: number; y: number; dirs: number[]; cls: number[] }>();
  for (const r of roads) {
    const n = r.xy.length / 2;
    if (n < 2) continue;
    for (const fromStart of [true, false]) {
      const ex = r.xy[fromStart ? 0 : 2 * n - 2];
      const ey = r.xy[fromStart ? 1 : 2 * n - 1];
      // (Junctions a little beyond the chunk may set their cross inside it.)
      if (!inside(ex, ey, JUNCTION_REACH)) continue;
      // The way's direction over its first 15 m from the junction.
      let k = 1;
      while (k < n - 1 && Math.hypot(r.xy[2 * (fromStart ? k : n - 1 - k)] - ex, r.xy[2 * (fromStart ? k : n - 1 - k) + 1] - ey) < 15) k++;
      const q = fromStart ? k : n - 1 - k;
      const key = `${ex},${ey}`;
      let e = ends.get(key);
      if (!e) ends.set(key, (e = { x: ex, y: ey, dirs: [], cls: [] }));
      e.dirs.push(Math.atan2(r.xy[2 * q + 1] - ey, r.xy[2 * q] - ex));
      e.cls.push(r.cls);
    }
  }
  for (const e of ends.values()) {
    if (e.dirs.length < 3 || Math.min(...e.cls) > ROAD_C) continue;
    if (chance(4, Math.round(e.x), Math.round(e.y)) >= JUNCTION_CROSS) continue;
    // In the widest gap between the ways.
    const a = [...e.dirs].sort((m, n) => m - n);
    let best = -1;
    let mid = 0;
    for (let q = 0; q < a.length; q++) {
      const next = q + 1 < a.length ? a[q + 1] : a[0] + 2 * Math.PI;
      if (next - a[q] > best) {
        best = next - a[q];
        mid = (a[q] + next) / 2;
      }
    }
    const off = Math.min(JUNCTION_REACH, Math.max(...e.cls.map((c) => WAY_CLEAR[c])) / Math.sin(Math.min(best / 2, Math.PI / 2)) + JUNCTION_OFF);
    const x = e.x + off * Math.cos(mid);
    const y = e.y + off * Math.sin(mid);
    if (!inside(x, y)) continue;
    const k = at(Math.round(x / NODE) - p.gx, Math.round(y / NODE) - p.gy);
    if (!Number.isNaN(p.lake[k]) || built(x, y)) continue;
    out.push({ kind: CROSS, x, y });
  }
  return out;
}
