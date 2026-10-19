import { hash3 } from '../lib/hash';
import { lerp, smoothstep } from '../lib/noise';
import type { CoarseField } from './hydro';
import type { Lattice, SeedView } from './seeds';
import type { Terrain } from './terrain';

/**
 * Settlement sites — a pure function of the coarse seeds.
 *
 * Each rank (town, village, hamlet) has candidates on a jittered lattice. A
 * candidate becomes a site if its suitability passes a threshold and its score
 * (suitability × seeded random) beats every other candidate of the same rank
 * within the rank's spacing radius, and it isn't too close to a higher-ranked
 * site. Every rule is local, so any worker evaluating any chunk agrees.
 *
 * Suitability comes from the coarse eroded surface: flat ground, valley floors
 * near rivers, not too high up.
 */

export const TOWN = 0;
export const VILLAGE = 1;
export const HAMLET = 2;
export type Rank = typeof TOWN | typeof VILLAGE | typeof HAMLET;

export interface Site {
  /** Stable id: rank and lattice cell. */
  id: string;
  rank: Rank;
  x: number;
  y: number;
  /** Coarse elevation (m). */
  z: number;
  R: number;
}

/** Candidate lattice spacing (m) per rank. */
const LATTICE = [3000, 900, 350];
/** Minimum suitability per rank. */
const MIN_SUIT = [0.3, 0.15, 0.06];
/** Keep-out distance from higher-ranked sites (m). */
const EXCLUDE = [0, 1700, 550];
const SALT = [0x70776e, 0x76696c, 0x68616d];

/** Spacing radius (m) for rank at region R: sparser in the mountains. */
export function spacing(rank: Rank, R: number): number {
  if (rank === TOWN) return 6500;
  if (rank === VILLAGE) return lerp(1900, 3400, smoothstep(0.15, 0.95, R));
  return lerp(650, 1100, smoothstep(0.3, 0.95, R));
}

/** Built-up radius (m) used for placeholders and clearing land around a site. */
export const SITE_RADIUS = [320, 130, 45];

interface Candidate {
  x: number;
  y: number;
  z: number;
  R: number;
  suit: number;
  score: number;
}

export class Settlements {
  private readonly cand = new Map<string, Candidate | null>();
  private readonly site = new Map<string, boolean>();
  private readonly lat: Lattice;

  constructor(
    private readonly field: CoarseField,
    private readonly terrain: Terrain,
    view: SeedView,
  ) {
    // Coarse-lattice seeds: settlement placement follows the long-lived coarse terrain.
    this.lat = view.lattice(1024);
  }

  /** Suitability for settling at (x, y), 0..1. */
  suitability(x: number, y: number, rank: Rank): { suit: number; z: number; R: number } {
    const f = this.field;
    // Nearest coarse tile only: keeps the reach of a far-away town decision small.
    const z = f.zNearest(x, y);
    const d = 128;
    const gx = (f.zNearest(x + d, y) - f.zNearest(x - d, y)) / (2 * d);
    const gy = (f.zNearest(x, y + d) - f.zNearest(x, y - d)) / (2 * d);
    const slope = Math.hypot(gx, gy);
    const A = f.area(x, y);
    const R = this.terrain.region(x, y);
    // Flat enough *for the region*: at 256 m, mountain valley floors still read steep.
    const tol = lerp(0.08, 0.3, smoothstep(0.2, 0.9, R));
    const flat = Math.exp(-((slope / tol) ** 2));
    // Towns want real rivers; villages and hamlets are happy with streams.
    const river = rank === TOWN ? smoothstep(3, 80, A) : rank === VILLAGE ? smoothstep(0.3, 10, A) : smoothstep(0.1, 2, A);
    // Too high to live (alpine villages stay in the valleys).
    const alt = 1 - smoothstep(1450, 1850, z);
    // Topographic position: broad hilltops look flat at 256 m too; prefer valleys.
    const D = 512;
    const tpi = z - (f.zNearest(x + D, y) + f.zNearest(x - D, y) + f.zNearest(x, y + D) + f.zNearest(x, y - D)) / 4;
    const low = 1 - 0.75 * smoothstep(2, 30, tpi);
    return { suit: flat * (0.35 + 0.65 * river) * alt * low, z, R };
  }

  private candidate(rank: Rank, i: number, j: number): Candidate | null {
    const key = `${rank}:${i},${j}`;
    if (this.cand.has(key)) return this.cand.get(key)!;
    const L = LATTICE[rank];
    // Seed from the coarse lattice point owning this cell (forgettable, long-lived).
    const owner = this.lat.seed(Math.floor((i * L) / 1024), Math.floor((j * L) / 1024));
    const h1 = hash3(owner ^ SALT[rank], i, j);
    const h2 = hash3(h1, j, i);
    let x = (i + 0.15 + 0.7 * ((h1 & 0xffff) / 65536)) * L;
    let y = (j + 0.15 + 0.7 * ((h1 >>> 16) / 65536)) * L;
    // Nudge to the best of a few nearby spots (valley floors are narrow).
    let best = this.suitability(x, y, rank);
    const step = Math.min(256, L / 4);
    for (const [dx, dy] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
    ]) {
      const s = this.suitability(x + dx, y + dy, rank);
      if (s.suit > best.suit) {
        best = s;
        x += dx;
        y += dy;
      }
    }
    const c: Candidate | null =
      best.suit >= MIN_SUIT[rank] ? { x, y, z: best.z, R: best.R, suit: best.suit, score: best.suit * (0.4 + 0.6 * (h2 / 4294967296)) } : null;
    this.cand.set(key, c);
    return c;
  }

  /** Is the candidate of `rank` in lattice cell (i, j) a site? */
  isSite(rank: Rank, i: number, j: number): boolean {
    const key = `${rank}:${i},${j}`;
    const memo = this.site.get(key);
    if (memo !== undefined) return memo;
    const c = this.candidate(rank, i, j);
    let ok = c !== null;
    if (c) {
      const L = LATTICE[rank];
      const r = spacing(rank, c.R);
      const n = Math.ceil(r / L) + 1;
      for (let dj = -n; dj <= n && ok; dj++)
        for (let di = -n; di <= n && ok; di++) {
          if (!di && !dj) continue;
          const o = this.candidate(rank, i + di, j + dj);
          if (!o || Math.hypot(o.x - c.x, o.y - c.y) > r) continue;
          if (o.score > c.score || (o.score === c.score && (j + dj) * 1e6 + (i + di) > j * 1e6 + i)) ok = false;
        }
      // Keep away from higher-ranked sites.
      for (let hr = 0; hr < rank && ok; hr++) {
        const H = LATTICE[hr];
        const ex = EXCLUDE[rank];
        const n2 = Math.ceil(ex / H) + 1;
        const ci = Math.floor(c.x / H);
        const cj = Math.floor(c.y / H);
        for (let dj = -n2; dj <= n2 && ok; dj++)
          for (let di = -n2; di <= n2 && ok; di++) {
            const o = this.candidate(hr as Rank, ci + di, cj + dj);
            if (o && Math.hypot(o.x - c.x, o.y - c.y) < ex && this.isSite(hr as Rank, ci + di, cj + dj)) ok = false;
          }
      }
    }
    this.site.set(key, ok);
    return ok;
  }

  /** All sites of `rank` with positions inside the rectangle. */
  sitesIn(rank: Rank, x0: number, y0: number, x1: number, y1: number): Site[] {
    const L = LATTICE[rank];
    const out: Site[] = [];
    for (let j = Math.floor(y0 / L) - 1; j <= Math.floor(y1 / L) + 1; j++)
      for (let i = Math.floor(x0 / L) - 1; i <= Math.floor(x1 / L) + 1; i++) {
        const c = this.candidate(rank, i, j);
        if (!c || c.x < x0 || c.x >= x1 || c.y < y0 || c.y >= y1) continue;
        if (this.isSite(rank, i, j)) out.push({ id: `${rank}:${i},${j}`, rank, x: c.x, y: c.y, z: c.z, R: c.R });
      }
    return out;
  }
}
