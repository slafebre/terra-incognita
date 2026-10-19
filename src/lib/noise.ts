import type { Lattice } from '../gen/seeds';
import { hash1 } from './hash';

const GX = new Float64Array(256);
const GY = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const a = ((i + 0.5) / 256) * Math.PI * 2;
  GX[i] = Math.cos(a);
  GY[i] = Math.sin(a);
}

/** Scales 2D Perlin output (about ±0.707) to about ±1. */
const NORM = Math.SQRT2;

/** Derivatives of the last `gnoise` call, in value units per metre. */
export const ND = new Float64Array(2);

/**
 * 2D gradient noise on lattice `L`, evaluated at world position (x, y) in metres.
 * `salt` makes independent noise fields from the same lattice seeds.
 * Returns roughly [-1, 1] and writes the analytic gradient to `ND`.
 */
export function gnoise(L: Lattice, salt: number, x: number, y: number): number {
  const S = L.S;
  const fx = x / S;
  const fy = y / S;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;

  // Consecutive samples usually share a cell: reuse its corner gradients.
  const cache = L.cell;
  if (cache[0] !== ix || cache[1] !== iy || cache[2] !== salt) {
    cache[0] = ix;
    cache[1] = iy;
    cache[2] = salt;
    cache[3] = hash1(L.seed(ix, iy) ^ salt) & 255;
    cache[4] = hash1(L.seed(ix + 1, iy) ^ salt) & 255;
    cache[5] = hash1(L.seed(ix, iy + 1) ^ salt) & 255;
    cache[6] = hash1(L.seed(ix + 1, iy + 1) ^ salt) & 255;
  }
  const a = cache[3];
  const b = cache[4];
  const c = cache[5];
  const d = cache[6];

  const ax = GX[a], ay = GY[a];
  const bx = GX[b], by = GY[b];
  const cx = GX[c], cy = GY[c];
  const dx = GX[d], dy = GY[d];

  const va = ax * tx + ay * ty;
  const vb = bx * (tx - 1) + by * ty;
  const vc = cx * tx + cy * (ty - 1);
  const vd = dx * (tx - 1) + dy * (ty - 1);

  const u = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
  const v = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
  const du = 30 * tx * tx * (tx * (tx - 2) + 1);
  const dv = 30 * ty * ty * (ty * (ty - 2) + 1);

  const k1 = vb - va;
  const k2 = vc - va;
  const k3 = va - vb - vc + vd;

  const gx = ax + u * (bx - ax) + v * (cx - ax) + u * v * (ax - bx - cx + dx) + du * (k1 + v * k3);
  const gy = ay + u * (by - ay) + v * (cy - ay) + u * v * (ay - by - cy + dy) + dv * (k2 + u * k3);

  ND[0] = (gx * NORM) / S;
  ND[1] = (gy * NORM) / S;
  return (va + u * k1 + v * k2 + u * v * k3) * NORM;
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
