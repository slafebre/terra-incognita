/** Chunk edge length in metres. Unit of generation, rendering and forgetting. */
export const CHUNK = 512;
/** DEM cell size in metres. */
export const CELL = 4;
/** DEM cells per chunk edge. */
export const CELLS = CHUNK / CELL;
/**
 * Extra DEM vertices on each side of a chunk (for gradients, seamless contours, and
 * classifying map symbols that straddle the chunk border).
 */
export const APRON = 4;
/** DEM vertices per row, including both chunk edges and the apron. */
export const DEM_W = CELLS + 1 + 2 * APRON;

/** 1:10,000 at 96 CSS dpi: metres of ground per CSS pixel at zoom 1. */
export const M_PER_CSS_PX = (0.0254 / 96) * 10000;

/** Retained ("remembered") distance beyond the viewport, in metres. */
export const RETAIN = 4000;
/** Forget distance (retain + hysteresis), in metres. */
export const FORGET = 4500;
/** Generation margin beyond the viewport, in metres. */
export const GEN_MARGIN = 512;

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const DPR_MAX = 2;

/** Fake Lambert-93-ish origin for kilometre grid labels. */
export const EASTING0 = 700_000;
export const NORTHING0 = 6_600_000;
