import { APRON, CELL, CHUNK, DEM_W } from '../lib/constants';
import { clamp, gnoise, smoothstep } from '../lib/noise';
import type { Lattice, SeedView } from './seeds';
import { erodeSmax } from './terrain';

/**
 * Land cover as continuous fields on the DEM vertex grid: a class is present
 * where its field is > 0. Every field is a pure function of the (blended,
 * hence chunk-consistent) eroded surface, the region and seeded noise, so class
 * boundaries match exactly across chunk borders.
 *
 * Settlement-driven land use (orchards, gardens, clearings) comes later; this is
 * the natural / agricultural potential of the terrain.
 */

export const COVER = {
  glacier: 0,
  rock: 1,
  scree: 2,
  forest: 3,
  vineyard: 4,
  wetland: 5,
  heath: 6,
  /** Not a class: share of conifers in forest, 0..1 mapped to 0..127. */
  conifer: 7,
} as const;
export const COVER_FIELDS = 8;
/** Field values are stored as Int8 with this many units per field unit. */
export const COVER_SCALE = 40;

/** Per-vertex inputs (DEM_W² each), splined from node data by the DEM stage. */
export interface CoverInputs {
  /** Final DEM (lakes flat). */
  dem: Float32Array;
  /** Water depth (> 0 under lakes). */
  water: Float32Array;
  /** Region. */
  R: Float32Array;
  /** Smoothed slope (m/m) and gradient components of the eroded surface. */
  slope: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
  /** Topographic position: node elevation minus its 5×5 neighbourhood mean (m). */
  tpi: Float32Array;
}

const SALTS = {
  forest: 0x2f0e57,
  forest2: 0x7a11ce,
  conifer: 0x5c0f13,
  vine: 0x71e7a2,
  wet: 0x3e7a3d,
  heath: 0x4ea7b0,
  rock: 0x60c4a1,
  ice: 0x1ce0c0,
};

/** Fraction of land that's forest by region (lowland … alpine), as a field bias. */
const FOREST_BIAS = [-0.02, -0.2, -0.2, -0.05, -0.3];

function table(t: number[], r: number): number {
  const f = clamp(r, 0, 1) * (t.length - 1);
  const i = Math.min(t.length - 2, Math.floor(f));
  return t[i] + (t[i + 1] - t[i]) * (f - i);
}

export function computeCover(cx: number, cy: number, view: SeedView, inp: CoverInputs): Int8Array {
  const out = new Int8Array(COVER_FIELDS * DEM_W * DEM_W);
  const L = (S: number): Lattice => view.lattice(S);
  const l512 = L(512);
  const l256 = L(256);
  const l128 = L(128);
  const l64 = L(64);
  const l32 = L(32);
  const fbm = (salt: number, x: number, y: number) =>
    0.5 * gnoise(l512, salt, x, y) +
    0.3 * gnoise(l256, salt + 1, x, y) +
    0.15 * gnoise(l128, salt + 2, x, y) +
    0.08 * gnoise(l64, salt + 3, x, y) +
    0.04 * gnoise(l32, salt + 4, x, y);

  const N = DEM_W * DEM_W;
  const put = (field: number, o: number, v: number) => {
    out[field * N + o] = Math.round(clamp(v * COVER_SCALE, -127, 127));
  };

  // Noise fields vary slowly (finest octave 32 m): evaluate them every other vertex
  // (8 m, world-aligned since APRON is even) and interpolate in between.
  const NOISE = [SALTS.ice, SALTS.rock, SALTS.forest2, SALTS.rock + 9, SALTS.forest, SALTS.conifer, SALTS.vine, SALTS.wet, SALTS.heath];
  const NW = (DEM_W + 1) >> 1;
  const grid = new Float32Array(NOISE.length * NW * NW);
  for (let gj = 0; gj < NW; gj++)
    for (let gi = 0; gi < NW; gi++) {
      const x = cx * CHUNK + (2 * gi - APRON) * CELL;
      const y = cy * CHUNK + (2 * gj - APRON) * CELL;
      NOISE.forEach((salt, n) => (grid[(n * NW + gj) * NW + gi] = fbm(salt, x, y)));
    }
  const noiseAt = (n: number, i: number, j: number) => {
    const gi = Math.min(NW - 2, i >> 1);
    const gj = Math.min(NW - 2, j >> 1);
    const fx = (i - 2 * gi) / 2;
    const fy = (j - 2 * gj) / 2;
    const b = (n * NW + gj) * NW + gi;
    const top = grid[b] + (grid[b + 1] - grid[b]) * fx;
    const bot = grid[b + NW] + (grid[b + NW + 1] - grid[b + NW]) * fx;
    return top + (bot - top) * fy;
  };

  for (let j = 0; j < DEM_W; j++)
    for (let i = 0; i < DEM_W; i++) {
      const o = j * DEM_W + i;
      const z = inp.dem[o];
      const s = inp.slope[o];
      const R = inp.R[o];
      const tpi = inp.tpi[o];
      const g = Math.hypot(inp.gx[o], inp.gy[o]) || 1;
      // +1 on slopes facing north (terrain descends northwards, i.e. rises southwards).
      const northness = s > 0.02 ? inp.gy[o] / g : 0;
      const wet = inp.water[o] > -0.3;

      // Glacier: above the equilibrium line (lower on shady slopes), not on cliffs.
      const ela = 2850 - 150 * northness + 60 * noiseAt(0, i, j);
      const glacier = wet ? -1 : (z - ela) / 40 - Math.max(0, s - 0.85) * 6;

      // Rock: very steep ground; the threshold drops with altitude (frost, thin soil).
      const sRock = 1.0 - 0.25 * smoothstep(2100, 2900, z);
      const rock = wet ? -1 : (s - sRock) / 0.12 + 0.6 * noiseAt(1, i, j);

      // Treeline: higher on sunny slopes.
      const treeline = 1950 - 130 * northness + 50 * noiseAt(2, i, j);

      // Scree: steep-ish high ground, mostly concave foot-slopes below rock.
      const scree = wet
        ? -1
        : Math.min((s - 0.5) / 0.08, (0.95 - s) / 0.1, (z - treeline) / 60, (-tpi - 1.5) / 2) +
          0.6 * noiseAt(3, i, j) -
          0.2;

      // Forest: steep slopes and upper slopes favoured (hard to farm), valley floors
      // and gentle land cleared, regional cover, noise for natural blocks.
      let forest =
        table(FOREST_BIAS, R) +
        1.1 * noiseAt(4, i, j) +
        // Steepness relative to what's typical for the region: forest keeps the
        // locally steepest ground (in the mountains every slope is "steep").
        0.6 * (smoothstep(0.5, 1.0, s / erodeSmax(R)) - 0.5) +
        0.012 * clamp(tpi, -20, 20);
      forest = Math.min(forest, (treeline - z) / 80);
      if (wet) forest = -1;

      // Conifer share: higher up and in the mountains.
      const conifer = clamp(
        0.15 + 0.6 * smoothstep(400, 1300, z) + 0.25 * smoothstep(0.4, 0.8, R) + 0.35 * noiseAt(5, i, j),
        0,
        1,
      );

      // Vineyards: sunny, moderate slopes at low altitude in hill country.
      const south = -northness;
      const vineyard = wet
        ? -1
        : Math.min(
            (south - 0.45) / 0.2,
            (s - 0.08) / 0.04,
            (0.45 - s) / 0.08,
            (750 - z) / 60,
            (z - 100) / 30,
            1 - Math.abs(R - 0.42) / 0.22,
          ) +
          1.2 * noiseAt(6, i, j) -
          0.6;

      // Wetland: flat valley bottoms and hollows.
      const wetland = wet
        ? -1
        : Math.min((0.025 - s) / 0.01, -tpi / 1.5) + 0.8 * noiseAt(7, i, j) - 0.3 - 0.4 * smoothstep(0.3, 0.7, R);

      // Heath / dwarf pine: a band above the treeline.
      const heath = Math.min((z - treeline + 40) / 60, (treeline + 300 - z) / 80) + 0.7 * noiseAt(8, i, j) - 0.2;

      put(COVER.glacier, o, glacier);
      put(COVER.rock, o, rock);
      put(COVER.scree, o, scree);
      put(COVER.forest, o, forest);
      put(COVER.vineyard, o, vineyard);
      put(COVER.wetland, o, wetland);
      put(COVER.heath, o, heath);
      out[COVER.conifer * N + o] = Math.round(conifer * 127);
    }
  return out;
}
