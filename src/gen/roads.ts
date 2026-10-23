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
 * corridors that reach the cell's stages, the sites deciding them, and coarse tile
 * reach. Coarse seeds are kept accordingly (COARSE_KEEP_EXTRA).
 */
export const NET_REACH = 56000;

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
}

export interface SegmentPath {
  key: string;
  cls: RoadClass;
  /** Chunk-independent world coordinates [x0, y0, …]. */
  xy: Float32Array;
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
