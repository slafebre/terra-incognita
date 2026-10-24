import { CHUNK } from '../lib/constants';
import type { TownPlan } from '../gen/town';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Building footprints of the plans: filled, with a thin darker edge. */
export function drawBuildings(ctx: Ctx, plans: TownPlan[], cx: number, cy: number, pxPerM: number, dpr: number): void {
  const p = new Path2D();
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
      p.moveTo(x * pxPerM, y * pxPerM);
      for (let k = 2; k < 8; k += 2) p.lineTo((b[i + k] - ox) * pxPerM, (b[i + k + 1] - oy) * pxPerM);
      p.closePath();
    }
  }
  ctx.fillStyle = STYLE.building;
  ctx.fill(p);
  ctx.strokeStyle = STYLE.buildingEdge;
  ctx.lineWidth = STYLE.buildingEdgeWidth * dpr;
  ctx.lineJoin = 'miter';
  ctx.stroke(p);
}
