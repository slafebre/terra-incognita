import { COARSE_REACH, LAKE_REACH } from './hydro';
import { LAKE_TILE } from './lakes';
import { COARSE_KEEP_EXTRA } from './seeds';
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
export const NET_REACH = Math.max(SITE_REACH, LAKE_TEST_REACH + LAKE_TILE + LAKE_REACH) + COARSE_REACH;
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
 * How far (m) a fine-routed run may stray left and right of the line from its first
 * to its last vertex (sides by the sign of the cross product): its share of the gap
 * to the nearest ways there, assuming they may be fine-routed too.
 */
export type Room = [number, number];

/**
 * Where a fine-routed run may go near one of its end vertices, flattened as
 * [vx, vy, direction, half-angle counter-clockwise, half-angle clockwise] (radians):
 * within the wedge between the bisectors to the ways next to it at that vertex.
 * Wedges at a vertex don't overlap, so runs meeting there can't run into each other.
 */
export const WEDGE = 5;

/**
 * A neighbouring run (not meeting at an end): which sides of the run it lies on
 * (bits 1 left, 2 right), its distance (m), the share of that gap the run may take
 * if the neighbour is fine-routed too, and the neighbour's vertices and class, so
 * the drawing chunk can tell whether it is (it may take more room if not).
 */
export interface Rival {
  sides: number;
  d: number;
  share: number;
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
}

export interface NetCell {
  sites: Site[];
  edges: RoadEdge[];
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
