import { COARSE_REACH, LAKE_REACH } from './hydro';
import { LAKE_TILE } from './lakes';
import { COARSE_KEEP_EXTRA } from './seeds';
import type { MotorwayPiece } from './motorway';
import type { Site } from './settle';

/**
 * Road network: shared classes, constants and types. The network itself is built
 * on a lattice (lattice.ts): net cells decide which lattice edges carry which kind
 * of way, and chunks draw the edges as curves fitted to the fine terrain.
 */

/** Net cell size (m): the unit in which the network is decided and owned. */
export const NET_CELL = 8192;
/**
 * How far around a net cell the coarse terrain is consulted (m): the main-road
 * corridors that reach the cell's stages and the sites deciding them (SITE_REACH);
 * coarse lakes are tested within LAKE_TEST_REACH (main-road corridors, and the
 * villages deciding the cell's D roads; towns ignore lakes), and each test reads
 * the surface up to LAKE_TILE + LAKE_REACH further (lakes.ts); plus the coarse
 * surface's own reach. Coarse seeds are kept accordingly (COARSE_KEEP_EXTRA).
 */
const SITE_REACH = 35500;
const LAKE_TEST_REACH = 30000;
/**
 * Motorways (motorway.ts) keep the network off them along every corridor (vertices
 * ~26 km out, the pieces passing near them a few km further), and a piece reads the
 * line's noise up to MW_DEPEND (40 km) beyond its cell: only noise seeds, as the coarse
 * terrain it routes on lies within ~55 km.
 */
const MOTORWAY_REACH = 76000;
export const NET_REACH = Math.max(Math.max(SITE_REACH, LAKE_TEST_REACH + LAKE_TILE + LAKE_REACH) + COARSE_REACH, MOTORWAY_REACH);
if (NET_REACH + 4000 > COARSE_KEEP_EXTRA) throw new Error('coarse seeds are not kept as far as net cells read them');

export const ROAD_N = 0;
export const ROAD_D = 1;
export const ROAD_C = 2;
/** Tracks (unpaved farm and forest ways) and footpaths. */
export const ROAD_T = 3;
export const ROAD_P = 4;
export type RoadClass = typeof ROAD_N | typeof ROAD_D | typeof ROAD_C | typeof ROAD_T | typeof ROAD_P;

/** Maximum sustained gradient per class. */
export const MAX_GRADE = [0.07, 0.1, 0.15, 0.22, 0.45];
/** Longest main-road link per class (m): towns ↔ towns (N), villages ↔ villages or towns (D). */
export const MAX_LEN = [9000, 4500];

/** One used lattice edge. */
/**
 * Where a fine-routed run may go near one of its end vertices, flattened as
 * [vx, vy, direction, half-angle counter-clockwise, half-angle clockwise] (radians):
 * within the wedge between the bisectors to the ways next to it at that vertex.
 * Wedges at a vertex don't overlap, so runs meeting there can't run into each other.
 */
export const WEDGE = 5;

/**
 * A neighbouring run (not meeting at an end, within ROOM_REACH): its vertices and
 * class, so the drawing chunk can tell whether it is fine-routed too, and the
 * run's weight against it: where both may wind, a point is the run's only if its
 * distance to the run's line is under `weight` × its distance to the neighbour's.
 * A pair's weights multiply to under 1, so the two can't meet.
 */
export interface Rival {
  weight: number;
  cls: RoadClass;
  pts: number[];
}

export interface RoadEdge {
  id: string;
  cls: RoadClass;
  a: Site;
  b: Site;
  /** Its two vertices [ax, ay, bx, by] (world metres). */
  route: number[];
  /** Roundabouts at its vertices, as `SegmentTask.rings`. */
  rings?: number[];
}

export interface NetCell {
  sites: Site[];
  edges: RoadEdge[];
  /** Motorway pieces of the motorway cells inside it (experimental, motorway.ts). */
  motorways: MotorwayPiece[];
}

/** Relative neighbourhood graph test: no other site is closer to both a and b. */
export function rngEdge(a: Site, b: Site, others: Site[]): boolean {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  for (const c of others) {
    if (c === a || c === b) continue;
    if (Math.max(Math.hypot(a.x - c.x, a.y - c.y), Math.hypot(b.x - c.x, b.y - c.y)) < d) return false;
  }
  return true;
}

/** One edge for a chunk to draw. */
export interface SegmentTask {
  /** Canonical key of the edge (order-independent). */
  key: string;
  /** Highest class of any way using it. */
  cls: RoadClass;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** The edges it continues into smoothly at either end (their far vertices), if any. */
  pa?: [number, number];
  pb?: [number, number];
  /** The ways near the edge (as for `piece`), for a detour around a lake. */
  obstacles: number[];
  /** Wedges at its two vertices (see `Wedge`). */
  wedges: number[];
  /** Neighbouring runs that may limit its room (see `Rival`). */
  rivals: Rival[];
  /**
   * Where the way beyond an end runs into a dead end without meeting another way
   * (within a few edges): its vertices [x, y, …], that end first. A way must not end
   * in a lake, so where all of it is under water the edge stops at the shore.
   */
  spurA?: number[];
  spurB?: number[];
  /**
   * Roundabouts at the ends of its edge or piece, [x, y, radius, class, …] (vertices
   * as the network placed them): the ways meeting there stop at the ring, where the
   * ground takes one.
   */
  rings?: number[];
  /** The roundabouts it draws (as `rings`): those where it is the first edge, by key. */
  ownRings?: number[];
  /**
   * The run of edges of one road this edge belongs to (vertices in canonical order),
   * if short enough: routed on the fine terrain as one when too steep or crossing a
   * lake, by the chunk owning its middle edge (`owner`).
   */
  piece?: {
    key: string;
    pts: number[];
    owner: boolean;
    /** Other ways near the piece, as segments [ax, ay, bx, by, …]. */
    obstacles: number[];
    /** Wedges at its two end vertices (see `Wedge`). */
    wedges: number[];
    rivals: Rival[];
    pa?: [number, number];
    pb?: [number, number];
    /** As the edge's, for the piece's ends. */
    spurA?: number[];
    spurB?: number[];
  };
}

export interface SegmentPath {
  key: string;
  cls: RoadClass;
  /** Chunk-independent world coordinates [x0, y0, …]. */
  xy: Float32Array;
  /** Routed on the fine terrain (a steep piece). */
  micro?: boolean;
  /** A roundabout's ring (closed: its first point repeated last). */
  ring?: boolean;
}

/** A closed ring of radius r round (cx, cy), points every 3 m or so, from due east. */
export function ringLine(cx: number, cy: number, r: number): Float32Array {
  const n = Math.max(16, Math.ceil((2 * Math.PI * r) / 3));
  const xy = new Float32Array(2 * n + 2);
  for (let q = 0; q <= n; q++) {
    const a = (2 * Math.PI * (q % n)) / n;
    xy[2 * q] = cx + r * Math.cos(a);
    xy[2 * q + 1] = cy + r * Math.sin(a);
  }
  return xy;
}

/** A ring's centre and radius [x, y, r] (from its closed polyline, as ringLine draws it). */
export function ringDisc(xy: ArrayLike<number>): [number, number, number] {
  const n = xy.length / 2 - 1;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += xy[2 * i] / n;
    y += xy[2 * i + 1] / n;
  }
  return [x, y, Math.hypot(xy[0] - x, xy[1] - y)];
}

/** The parts of polyline xy outside the circle (cx, cy, r), each cut exactly at the circle; parts under 1 m are dropped. */
export function outsideCircle(xy: ArrayLike<number>, cx: number, cy: number, r: number): number[][] {
  const parts: number[][] = [];
  const n = xy.length / 2;
  let cur: number[] | null = Math.hypot(xy[0] - cx, xy[1] - cy) >= r ? [xy[0], xy[1]] : null;
  for (let i = 1; i < n; i++) {
    const px = xy[2 * i - 2];
    const py = xy[2 * i - 1];
    const dx = xy[2 * i] - px;
    const dy = xy[2 * i + 1] - py;
    const fx = px - cx;
    const fy = py - cy;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const disc = b * b - 4 * a * (fx * fx + fy * fy - r * r);
    if (a > 0 && disc > 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t <= 0 || t >= 1) continue;
        // Each crossing enters or leaves the circle.
        if (cur) {
          cur.push(px + t * dx, py + t * dy);
          parts.push(cur);
          cur = null;
        } else cur = [px + t * dx, py + t * dy];
      }
    }
    if (cur) cur.push(xy[2 * i], xy[2 * i + 1]);
  }
  if (cur) parts.push(cur);
  return parts.filter((q) => {
    let len = 0;
    for (let i = 2; i < q.length; i += 2) len += Math.hypot(q[i] - q[i - 2], q[i + 1] - q[i - 1]);
    return len >= 1;
  });
}

/** Fine node data around a chunk (row-major w × h, origin at global node gx, gy). */
export interface RoadPatch {
  gx: number;
  gy: number;
  w: number;
  h: number;
  zE: Float32Array;
  A: Float32Array;
  lake: Float32Array;
}

/** Fine-patch margin around a chunk (nodes): an edge drawn by the chunk, its neighbours, and the fitting band. */
export const ROAD_PAD = 32;
