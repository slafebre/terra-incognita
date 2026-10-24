import { CHUNK } from '../lib/constants';
import { CHAPEL, CROSS, RESERVOIR, SPRING, TOWER, TRIG, type Poi } from '../gen/poi';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/**
 * Points of interest as IGN-style symbols (sizes in CSS px, at the point):
 *  - chapel: a small cross over an open circle;
 *  - cross (wayside or summit): a Latin cross;
 *  - triangulation point: a triangle with a dot;
 *  - spring: a blue ring with a dot;
 *  - water tower: a ring round a dot; reservoir: a small blue square.
 */
export function drawPois(ctx: Ctx, pois: Poi[], cx: number, cy: number, pxPerM: number, dpr: number): void {
  const ink = new Path2D();
  const inkFill = new Path2D();
  const water = new Path2D();
  const waterFill = new Path2D();
  const u = dpr;
  for (const poi of pois) {
    const x = (poi.x - cx * CHUNK) * pxPerM;
    const y = (poi.y - cy * CHUNK) * pxPerM;
    switch (poi.kind) {
      case CHAPEL: {
        const r = 1.5 * u;
        ink.moveTo(x + r, y);
        ink.arc(x, y, r, 0, 2 * Math.PI);
        ink.moveTo(x, y - r);
        ink.lineTo(x, y - r - 3.4 * u);
        ink.moveTo(x - 1.3 * u, y - r - 2.2 * u);
        ink.lineTo(x + 1.3 * u, y - r - 2.2 * u);
        break;
      }
      case CROSS:
        ink.moveTo(x, y + 2.6 * u);
        ink.lineTo(x, y - 3.4 * u);
        ink.moveTo(x - 1.6 * u, y - 1.5 * u);
        ink.lineTo(x + 1.6 * u, y - 1.5 * u);
        break;
      case TRIG:
        ink.moveTo(x, y - 3.2 * u);
        ink.lineTo(x + 2.8 * u, y + 1.6 * u);
        ink.lineTo(x - 2.8 * u, y + 1.6 * u);
        ink.closePath();
        inkFill.moveTo(x + 0.6 * u, y);
        inkFill.arc(x, y, 0.6 * u, 0, 2 * Math.PI);
        break;
      case SPRING:
        water.moveTo(x + 1.9 * u, y);
        water.arc(x, y, 1.9 * u, 0, 2 * Math.PI);
        waterFill.moveTo(x + 0.7 * u, y);
        waterFill.arc(x, y, 0.7 * u, 0, 2 * Math.PI);
        break;
      case TOWER:
        ink.moveTo(x + 2.4 * u, y);
        ink.arc(x, y, 2.4 * u, 0, 2 * Math.PI);
        inkFill.moveTo(x + 1.1 * u, y);
        inkFill.arc(x, y, 1.1 * u, 0, 2 * Math.PI);
        break;
      case RESERVOIR:
        waterFill.rect(x - 1.7 * u, y - 1.7 * u, 3.4 * u, 3.4 * u);
        break;
    }
  }
  ctx.lineWidth = 0.8 * dpr;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = STYLE.church;
  ctx.stroke(ink);
  ctx.fillStyle = STYLE.church;
  ctx.fill(inkFill);
  ctx.strokeStyle = STYLE.waterLine;
  ctx.stroke(water);
  ctx.fillStyle = STYLE.waterLine;
  ctx.fill(waterFill);
}
