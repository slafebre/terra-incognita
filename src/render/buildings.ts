import { CHUNK } from '../lib/constants';
import type { TownPlan } from '../gen/town';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Building footprints of the plans (farmsteads included), filled: large ones lighter, edged in the small ones' colour (as wide as a road's casing, inside the footprint). */
export function drawBuildings(ctx: Ctx, plans: TownPlan[], cx: number, cy: number, pxPerM: number, dpr: number): void {
  const small = new Path2D();
  const large = new Path2D();
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  // Only footprints near the chunk (with a margin for the largest).
  const lo = -40;
  const hi = CHUNK + 40;
  for (const pl of plans) {
    const b = pl.buildings;
    for (let i = 0; i < b.length; i += 8) {
      const x = b[i] - ox;
      const y = b[i + 1] - oy;
      if (x < lo || y < lo || x > hi || y > hi) continue;
      const p = quadArea(b, i) >= STYLE.buildingLargeFrom ? large : small;
      p.moveTo(x * pxPerM, y * pxPerM);
      for (let k = 2; k < 8; k += 2) p.lineTo((b[i + k] - ox) * pxPerM, (b[i + k + 1] - oy) * pxPerM);
      p.closePath();
    }
  }
  ctx.fillStyle = STYLE.building;
  ctx.fill(small);
  ctx.fillStyle = STYLE.buildingLarge;
  ctx.fill(large);
  // Inside the footprint only: a stroke twice as wide, clipped to it.
  ctx.save();
  ctx.clip(large);
  ctx.strokeStyle = STYLE.building;
  ctx.lineWidth = 2 * STYLE.roads.casingWidth * dpr;
  ctx.lineJoin = 'miter';
  ctx.stroke(large);
  ctx.restore();
}

/** Area of the quad at b[i…i+7] (m²). */
export function quadArea(b: ArrayLike<number>, i: number): number {
  return Math.abs((b[i + 4] - b[i]) * (b[i + 7] - b[i + 3]) - (b[i + 6] - b[i + 2]) * (b[i + 5] - b[i + 1])) / 2;
}

/** Squares: open, paved places, filled like the streets round them (drawn before the ways, which edge them). */
export function drawSquares(ctx: Ctx, plans: TownPlan[], cx: number, cy: number, pxPerM: number): void {
  const p = new Path2D();
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  for (const pl of plans)
    for (const q of pl.squares) {
      p.moveTo((q[0] - ox) * pxPerM, (q[1] - oy) * pxPerM);
      for (let k = 2; k < q.length; k += 2) p.lineTo((q[k] - ox) * pxPerM, (q[k + 1] - oy) * pxPerM);
      p.closePath();
    }
  ctx.fillStyle = STYLE.square;
  ctx.fill(p);
}
