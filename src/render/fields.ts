import { CHUNK } from '../lib/constants';
import type { Fields } from '../gen/fields';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/**
 * Field parcels: unhedged edges as faint thin lines; hedges as rows of small green
 * dots (IGN), each dot where the distance along its line's direction is a multiple
 * of the spacing, so dots on a line crossing a chunk border line up.
 */
export function drawFields(ctx: Ctx, f: Fields, cx: number, cy: number, pxPerM: number, dpr: number): void {
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  const edges = new Path2D();
  for (let i = 0; i < f.edges.length; i += 4) {
    edges.moveTo((f.edges[i] - ox) * pxPerM, (f.edges[i + 1] - oy) * pxPerM);
    edges.lineTo((f.edges[i + 2] - ox) * pxPerM, (f.edges[i + 3] - oy) * pxPerM);
  }
  ctx.lineCap = 'butt';
  ctx.strokeStyle = STYLE.fields.edge;
  ctx.lineWidth = STYLE.fields.edgeWidth * dpr;
  ctx.stroke(edges);

  const dots = new Path2D();
  const sp = (STYLE.fields.hedgeSpacing * dpr) / pxPerM; // m
  const r = STYLE.fields.hedgeDot * dpr;
  for (let i = 0; i < f.hedges.length; i += 4) {
    const [ax, ay, bx, by] = [f.hedges[i], f.hedges[i + 1], f.hedges[i + 2], f.hedges[i + 3]];
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 1e-6) continue;
    const ux = (bx - ax) / l;
    const uy = (by - ay) / l;
    const p0 = ax * ux + ay * uy;
    for (let k = Math.ceil(p0 / sp); k * sp <= p0 + l; k++) {
      const x = (ax + ux * (k * sp - p0) - ox) * pxPerM;
      const y = (ay + uy * (k * sp - p0) - oy) * pxPerM;
      dots.moveTo(x + r, y);
      dots.arc(x, y, r, 0, 2 * Math.PI);
    }
  }
  ctx.fillStyle = STYLE.fields.hedge;
  ctx.fill(dots);
}
