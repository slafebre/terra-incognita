import { APRON, CELL, CHUNK, DEM_W } from '../lib/constants';
import { clamp, gnoise, lerp, ND, smoothstep } from '../lib/noise';
import { COARSE_SPACINGS, type Lattice, type SeedView } from './seeds';

/**
 * Terrain: elevation as a pure function of the retained seeds.
 *
 * - Region field R in [0, 1] (0 lowland, ~0.35 bocage/hills, ~0.6 low mountains,
 *   >0.82 alpine) varies on a 8–20 km scale.
 * - Shape: derivative-damped fBm (smooth slopes, detail on flats) blended into a
 *   ridged multifractal (sharp crests, broad valleys) as R grows.
 * - Coarse octaves are domain-warped so ridges and valleys meander.
 */

const SHAPE_OCTAVES = [4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8];
const WARP_COARSE_FROM = 1024;
const frac = (x: number) => x - Math.floor(x);

const SALT_REGION_A = 0x5a17c3d1;
const SALT_REGION_B = 0x13e0b4a9;
const SALT_WARP = [0x7b2f1e03, 0x2c9d4a61, 0x61f0a2b7, 0x4ad3e91c];
const SALT_SHAPE = 0x3b1d77c5;

/** Region parameters sampled at R = 0, 0.25, 0.5, 0.75, 1. */
const BASE = [60, 160, 320, 600, 1000];
const AMP = [22, 110, 340, 850, 2100];
const GAIN = [0.38, 0.45, 0.48, 0.48, 0.47];
/** Independent regional base-level field (m), so lowlands tilt instead of forming bowls. */
const BASE_LEVEL_AMP = 220;
const SALT_BASE_A = 0x0f1e2d3c;
const SALT_BASE_B = 0x4b5a6978;

/** C1 Catmull-Rom interpolation through evenly spaced samples (piecewise-linear would crease the terrain). */
function table(t: number[], r: number): number {
  const n = t.length - 1;
  const f = clamp(r, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const u = f - i;
  const p0 = t[Math.max(0, i - 1)];
  const p1 = t[i];
  const p2 = t[i + 1];
  const p3 = t[Math.min(n, i + 2)];
  return (
    p1 +
    0.5 * u * (p2 - p0 + u * (2 * p0 - 5 * p1 + 4 * p2 - p3 + u * (3 * (p1 - p2) + p3 - p0)))
  );
}

/** Regional valley-floor level (m): where big rivers end up after erosion. */
export function baseField(R: number, baseLevel: number): number {
  return table(BASE, R) + baseLevel;
}

/** Erosion parameters by region: channel steepness k (in S = k·A^-0.5, A in km²) and max hillslope. */
const ERODE_K = [0.012, 0.035, 0.08, 0.12, 0.15];
const ERODE_SMAX = [0.18, 0.36, 0.55, 0.65, 0.75];
export const erodeK = (R: number) => table(ERODE_K, R);
export const erodeSmax = (R: number) => table(ERODE_SMAX, R);
/**
 * Tectonic uplift added to the surface before erosion (m). With enough uplift the
 * landscape approaches the steady state of its drainage network: ridges form
 * where valley sides meet instead of flat remnants of the noise surface.
 */
const UPLIFT = [0, 120, 450, 900, 1600];
export const upliftOf = (R: number) => table(UPLIFT, R);
/**
 * How far below the local (uplifted) surface a window-edge outlet may sit (m):
 * lowland rivers stay near grade; mountain valleys may be cut through the uplift.
 */
const MAX_INCISION = [6, 40, 120, 250, 400];
export const maxIncisionOf = (R: number) => table(UPLIFT, R) + table(MAX_INCISION, R);

export type RegionKind = 'lowland' | 'hills' | 'lowmountain' | 'alpine';

export function regionKind(r: number): RegionKind {
  if (r < 0.25) return 'lowland';
  if (r < 0.52) return 'hills';
  if (r < 0.8) return 'lowmountain';
  return 'alpine';
}

/** Debug: force the region field to a constant (NaN = off). */
let regionOverride = NaN;
export function setRegionOverride(r: number): void {
  regionOverride = r;
}
/** Part of cache keys for anything derived from the region field. */
export const regionOverrideKey = (): string => String(regionOverride);

export class Terrain {
  private readonly l16k: Lattice;
  private readonly l8k: Lattice;
  private readonly l4k: Lattice;
  private readonly l2k: Lattice;
  private readonly shape: Lattice[];

  constructor(view: SeedView) {
    this.l16k = view.lattice(16384);
    this.l8k = view.lattice(8192);
    this.l4k = view.lattice(4096);
    this.l2k = view.lattice(2048);
    // Unwarped octaves get their own lattice offsets (golden-ratio fractions of S), so
    // no octave's lattice lines coincide with the chunk grid or with each other.
    // Octaves on coarse lattices (stored seeds) are known far from the view, so the
    // coarse field can resolve them.
    this.shape = SHAPE_OCTAVES.map((S, k) =>
      S >= WARP_COARSE_FROM
        ? view.lattice(S)
        : view.shifted(S, frac(0.6180339887 * (k + 1)) * S, frac(0.7548776662 * (k + 1)) * S, (COARSE_SPACINGS as readonly number[]).includes(S)),
    );
  }

  region(x: number, y: number): number {
    if (!Number.isNaN(regionOverride)) return regionOverride;
    const r = 0.65 * gnoise(this.l16k, SALT_REGION_A, x, y) + 0.35 * gnoise(this.l8k, SALT_REGION_B, x, y);
    // Logistic rather than clamp: a hard clamp creases the terrain along the R = 0/1 isolines.
    return 1 / (1 + Math.exp(-6.4 * r));
  }

  /** Slowly varying fields at (x, y): [region, base level offset, warped x, warped y]. */
  fields(x: number, y: number, out: Float64Array, o = 0): void {
    out[o] = this.region(x, y);
    out[o + 1] = BASE_LEVEL_AMP * (0.7 * gnoise(this.l16k, SALT_BASE_A, x, y) + 0.3 * gnoise(this.l8k, SALT_BASE_B, x, y));
    out[o + 2] = x + 380 * gnoise(this.l4k, SALT_WARP[0], x, y) + 160 * gnoise(this.l2k, SALT_WARP[1], x, y);
    out[o + 3] = y + 380 * gnoise(this.l4k, SALT_WARP[2], x, y) + 160 * gnoise(this.l2k, SALT_WARP[3], x, y);
  }

  private readonly tmp = new Float64Array(4);

  elevation(x: number, y: number, minS = 0): number {
    this.fields(x, y, this.tmp);
    return this.elevationWith(x, y, this.tmp[0], this.tmp[1], this.tmp[2], this.tmp[3], minS);
  }

  /**
   * Elevation given precomputed slow fields (see `fields`). Octaves with spacing
   * below `minS` are skipped; normalisation is unchanged, so a truncated sample
   * equals the full one minus fine detail.
   */
  elevationWith(x: number, y: number, R: number, baseLevel: number, wx: number, wy: number, minS = 0): number {
    const base = table(BASE, R) + baseLevel;
    const amp = table(AMP, R);
    const gain = table(GAIN, R);
    const mount = smoothstep(0.5, 0.92, R);

    let a = 1;
    let norm = 0;
    let fbm = 0;
    let rid = 0;
    let w = 1;
    let dx = 0;
    let dy = 0;
    for (let k = 0; k < SHAPE_OCTAVES.length; k++) {
      const L = this.shape[k];
      if (L.S < minS) break;
      const warped = L.S >= WARP_COARSE_FROM;
      const n = gnoise(L, SALT_SHAPE + k * 0x9e3779b9, warped ? wx : x, warped ? wy : y);
      dx += a * ND[0];
      dy += a * ND[1];
      const slope = amp * Math.sqrt(dx * dx + dy * dy) * 0.5;
      fbm += (a * n) / (1 + 1.5 * slope * slope);
      const damp = 1 / (1 + 1.5 * slope * slope);
      let r = 1 - Math.abs(n);
      r *= r;
      r *= w;
      w = clamp(r * 2, 0, 1);
      rid += a * r * (k < 3 ? 1 : damp);
      norm += a;
      // Octaves below 64 m read as hummocks at 1:10k; keep them subtle.
      a *= L.S <= 128 ? gain * 0.75 : gain;
    }
    // Normalise as if every octave had been evaluated.
    for (let k = 0; k < SHAPE_OCTAVES.length; k++) {
      if (this.shape[k].S >= minS) continue;
      norm += a;
      a *= this.shape[k].S <= 128 ? gain * 0.75 : gain;
    }
    const f = 0.5 + fbm / norm;
    const rg = (rid / norm) * 1.5;
    const h = base + amp * lerp(f, rg, mount);
    // Soft floor: inland map, keep everything comfortably above sea level.
    const u = (h - 20) / 25;
    return u > 20 ? h : 20 + 25 * Math.log1p(Math.exp(u));
  }
}

/** Spacing (in DEM vertices) of the grid on which slow fields are evaluated and interpolated. */
const FIELD_STEP = 4;

export interface TerrainGrid {
  dem: Float32Array;
  /** Region value at the chunk centre. */
  region: number;
  min: number;
  max: number;
}

/** Un-eroded terrain for chunk (cx, cy): DEM_W × DEM_W vertices at CELL spacing, with apron. */
export function terrainGrid(cx: number, cy: number, view: SeedView): TerrainGrid {
  const t = new Terrain(view);
  const dem = new Float32Array(DEM_W * DEM_W);
  const x0 = cx * CHUNK;
  const y0 = cy * CHUNK;

  // Slow fields on a world-aligned grid (nodes at multiples of FIELD_STEP * CELL), so
  // neighbouring chunks interpolate identical node values and stay seamless.
  const k0 = Math.floor(-APRON / FIELD_STEP);
  const k1 = Math.floor((DEM_W - 1 - APRON) / FIELD_STEP) + 1;
  const fw = k1 - k0 + 1;
  const f = new Float64Array(fw * fw * 4);
  for (let kj = 0; kj < fw; kj++)
    for (let ki = 0; ki < fw; ki++)
      t.fields(x0 + (k0 + ki) * FIELD_STEP * CELL, y0 + (k0 + kj) * FIELD_STEP * CELL, f, (kj * fw + ki) * 4);

  const lerpField = (c: number, ki: number, kj: number, u: number, v: number) => {
    const a = (kj * fw + ki) * 4 + c;
    const b = a + 4;
    const d = a + fw * 4;
    const e = d + 4;
    return (f[a] * (1 - u) + f[b] * u) * (1 - v) + (f[d] * (1 - u) + f[e] * u) * v;
  };

  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < DEM_W; j++) {
    const gj = j - APRON;
    const kj = Math.floor(gj / FIELD_STEP) - k0;
    const v = (gj - (kj + k0) * FIELD_STEP) / FIELD_STEP;
    const y = y0 + gj * CELL;
    for (let i = 0; i < DEM_W; i++) {
      const gi = i - APRON;
      const ki = Math.floor(gi / FIELD_STEP) - k0;
      const u = (gi - (ki + k0) * FIELD_STEP) / FIELD_STEP;
      const h = t.elevationWith(
        x0 + gi * CELL,
        y,
        lerpField(0, ki, kj, u, v),
        lerpField(1, ki, kj, u, v),
        lerpField(2, ki, kj, u, v),
        lerpField(3, ki, kj, u, v),
      );
      dem[j * DEM_W + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { dem, region: t.region(x0 + CHUNK / 2, y0 + CHUNK / 2), min, max };
}
