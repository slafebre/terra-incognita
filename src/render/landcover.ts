import { APRON, CELL, CHUNK, DEM_W } from '../lib/constants';
import { hash3 } from '../lib/hash';
import { COVER, COVER_SCALE } from '../gen/landcover';
import { STYLE } from './style';

const N = DEM_W * DEM_W;

/** Field value (field units, > 0 = present) at chunk-local metres (x, y), bilinear. */
export function coverAt(cover: Int8Array, field: number, x: number, y: number): number {
  const u = APRON + x / CELL;
  const v = APRON + y / CELL;
  const i = Math.max(0, Math.min(DEM_W - 2, Math.floor(u)));
  const j = Math.max(0, Math.min(DEM_W - 2, Math.floor(v)));
  const fx = u - i;
  const fy = v - j;
  const b = field * N + j * DEM_W + i;
  const top = cover[b] + (cover[b + 1] - cover[b]) * fx;
  const bot = cover[b + DEM_W] + (cover[b + DEM_W + 1] - cover[b + DEM_W]) * fx;
  return (top + (bot - top) * fy) / COVER_SCALE;
}

/** Fill classes in priority order (first present wins). */
export const FILLS: { field: number; rgb: readonly [number, number, number] }[] = [
  { field: COVER.glacier, rgb: STYLE.cover.glacier },
  { field: COVER.rock, rgb: STYLE.cover.rock },
  { field: COVER.scree, rgb: STYLE.cover.scree },
  { field: COVER.forest, rgb: STYLE.cover.forest },
  { field: COVER.vineyard, rgb: STYLE.cover.vineyard },
];

/**
 * Anti-aliased coverage (0..1) of field `f` in the vertex cell at row offset `r0`,
 * column `i`, fractional position (fx, fy); `pxPerVertex` converts field slope to px.
 */
export function cellCoverage(cover: Int8Array, field: number, r0: number, i: number, fx: number, fy: number, pxPerVertex: number): number {
  const b = field * N + r0 + i;
  const a = cover[b];
  const c = cover[b + 1];
  const d = cover[b + DEM_W];
  const e = cover[b + DEM_W + 1];
  if (a <= -40 && c <= -40 && d <= -40 && e <= -40) return 0; // clearly absent
  if (a >= 40 && c >= 40 && d >= 40 && e >= 40) return 1;
  const top = a + (c - a) * fx;
  const bot = d + (e - d) * fx;
  const v = top + (bot - top) * fy;
  const gx = (c - a + e - d) / 2;
  const gy = (d - a + e - c) / 2;
  const perPx = Math.sqrt(gx * gx + gy * gy) / pxPerVertex + 1e-6;
  const t = 0.5 + v / perPx;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

type Ctx = OffscreenCanvasRenderingContext2D;

/**
 * Calls `f` for each jittered symbol site of spacing `S` (m) near the chunk.
 * Sites sit on a world-aligned grid hashed by world cell, so neighbouring chunks
 * place (and classify) shared symbols identically. `margin` must stay within the apron.
 */
function sites(cx: number, cy: number, S: number, salt: number, margin: number, f: (x: number, y: number, h: number) => void): void {
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  const i0 = Math.floor((ox - margin) / S);
  const i1 = Math.floor((ox + CHUNK + margin) / S);
  const j0 = Math.floor((oy - margin) / S);
  const j1 = Math.floor((oy + CHUNK + margin) / S);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const h = hash3(salt, i, j);
      const x = (i + ((h & 0xffff) / 65536) * 0.8 + 0.1) * S - ox;
      const y = (j + ((h >>> 16) / 65536) * 0.8 + 0.1) * S - oy;
      if (x < -margin || y < -margin || x > CHUNK + margin || y > CHUNK + margin) continue;
      f(x, y, hash3(salt ^ 0x5bd1e995, i, j) / 4294967296);
    }
}

/** DEM gradient (m/m) at chunk-local metres, from central differences. */
function gradAt(dem: Float32Array, x: number, y: number): [number, number] {
  const i = Math.max(1, Math.min(DEM_W - 2, Math.round(APRON + x / CELL)));
  const j = Math.max(1, Math.min(DEM_W - 2, Math.round(APRON + y / CELL)));
  const k = j * DEM_W + i;
  return [(dem[k + 1] - dem[k - 1]) / (2 * CELL), (dem[k + DEM_W] - dem[k - DEM_W]) / (2 * CELL)];
}

export interface SymbolInput {
  cx: number;
  cy: number;
  dem: Float32Array;
  water: Float32Array;
  cover: Int8Array;
  pxPerM: number;
  dpr: number;
}

/** Symbol layers drawn over fills and contours, under water. */
export function drawCoverSymbols(ctx: Ctx, s: SymbolInput): void {
  const { cx, cy, dem, cover, pxPerM, dpr } = s;
  const at = (field: number, x: number, y: number) => coverAt(cover, field, x, y);
  const margin = (APRON - 1) * CELL; // keep every classified point inside the apron
  const dry = (x: number, y: number) => coverAt2(s.water, x, y) < -0.3;
  const X = (x: number) => x * pxPerM;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Rock: short hachures along the fall line, density rising with steepness.
  {
    const p = new Path2D();
    sites(cx, cy, 8, 0x7f4a7c15, margin, (x, y, h) => {
      if (at(COVER.rock, x, y) <= 0 || at(COVER.glacier, x, y) > 0) return;
      const [gx, gy] = gradAt(dem, x, y);
      const g = Math.hypot(gx, gy);
      if (g < 0.3) return;
      const len = Math.min(margin * 0.9, 4 + 5 * h);
      p.moveTo(X(x), X(y));
      p.lineTo(X(x - (gx / g) * len), X(y - (gy / g) * len));
    });
    ctx.strokeStyle = STYLE.cover.rockLine;
    ctx.lineWidth = 0.55 * dpr;
    ctx.stroke(p);
  }

  // Scree: stipple of small stones.
  {
    const p = new Path2D();
    sites(cx, cy, 6, 0x1b873593, margin, (x, y, h) => {
      if (at(COVER.scree, x, y) <= 0 || at(COVER.rock, x, y) > 0 || at(COVER.glacier, x, y) > 0) return;
      const r = (0.35 + 0.5 * h) * dpr;
      p.moveTo(X(x) + r, X(y));
      p.arc(X(x), X(y), r, 0, Math.PI * 2);
    });
    ctx.fillStyle = STYLE.cover.screeDot;
    ctx.fill(p);
  }

  // Vineyards: rows of dots.
  {
    const p = new Path2D();
    sites(cx, cy, 7, 0x2c1b3c6d, margin, (x, y) => {
      if (at(COVER.vineyard, x, y) <= 0 || at(COVER.forest, x, y) > 0 || !dry(x, y)) return;
      const r = 0.6 * dpr;
      p.moveTo(X(x) + r, X(y));
      p.arc(X(x), X(y), r, 0, Math.PI * 2);
    });
    ctx.fillStyle = STYLE.cover.vineDot;
    ctx.fill(p);
  }

  // Forest: sparse broadleaf (lollipop circles) and conifer (small fir) symbols.
  {
    const broad = new Path2D();
    const fir = new Path2D();
    sites(cx, cy, 40, 0x68e31da4, margin, (x, y, h) => {
      if (at(COVER.forest, x, y) <= 0.1 || at(COVER.rock, x, y) > 0 || !dry(x, y)) return;
      const conifer = (cover[COVER.conifer * N + Math.round(APRON + y / CELL) * DEM_W + Math.round(APRON + x / CELL)] / 127) > h;
      const r = 1.6 * dpr;
      if (conifer) {
        fir.moveTo(X(x), X(y) - 2.2 * dpr);
        fir.lineTo(X(x) + 1.5 * dpr, X(y) + 1.2 * dpr);
        fir.lineTo(X(x) - 1.5 * dpr, X(y) + 1.2 * dpr);
        fir.closePath();
      } else {
        broad.moveTo(X(x) + r, X(y));
        broad.arc(X(x), X(y), r, 0, Math.PI * 2);
      }
    });
    ctx.strokeStyle = STYLE.cover.tree;
    ctx.lineWidth = 0.6 * dpr;
    ctx.stroke(broad);
    ctx.stroke(fir);
  }

  // Heath / dwarf pine: small open circles.
  {
    const p = new Path2D();
    sites(cx, cy, 11, 0x3a4e5f71, margin, (x, y) => {
      if (at(COVER.heath, x, y) <= 0 || at(COVER.forest, x, y) > 0 || at(COVER.rock, x, y) > 0) return;
      if (at(COVER.glacier, x, y) > 0 || at(COVER.scree, x, y) > 0 || !dry(x, y)) return;
      const r = 0.9 * dpr;
      p.moveTo(X(x) + r, X(y));
      p.arc(X(x), X(y), r, 0, Math.PI * 2);
    });
    ctx.strokeStyle = STYLE.cover.heath;
    ctx.lineWidth = 0.55 * dpr;
    ctx.stroke(p);
  }

  // Wetland: marsh tufts (a base line with three short blades).
  {
    const p = new Path2D();
    sites(cx, cy, 12, 0x4c957f2d, margin, (x, y) => {
      if (at(COVER.wetland, x, y) <= 0 || at(COVER.forest, x, y) > 0 || !dry(x, y)) return;
      const px = X(x);
      const py = X(y);
      const w = 2.2 * dpr;
      p.moveTo(px - w, py);
      p.lineTo(px + w, py);
      for (const dx of [-1.3, 0, 1.3]) {
        p.moveTo(px + dx * dpr, py);
        p.lineTo(px + dx * dpr * 1.3, py - (dx === 0 ? 2.2 : 1.6) * dpr);
      }
    });
    ctx.strokeStyle = STYLE.cover.marsh;
    ctx.lineWidth = 0.6 * dpr;
    ctx.stroke(p);
  }
}

/** Bilinear sample of a Float32 vertex field at chunk-local metres. */
function coverAt2(f: Float32Array, x: number, y: number): number {
  const u = APRON + x / CELL;
  const v = APRON + y / CELL;
  const i = Math.max(0, Math.min(DEM_W - 2, Math.floor(u)));
  const j = Math.max(0, Math.min(DEM_W - 2, Math.floor(v)));
  const fx = u - i;
  const fy = v - j;
  const k = j * DEM_W + i;
  const top = f[k] + (f[k + 1] - f[k]) * fx;
  const bot = f[k + DEM_W] + (f[k + DEM_W + 1] - f[k + DEM_W]) * fx;
  return top + (bot - top) * fy;
}
