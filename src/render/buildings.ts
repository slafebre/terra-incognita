import { CHUNK } from '../lib/constants';
import { hash3 } from '../lib/hash';
import { nearestVertex, vertexPos } from '../gen/lattice';
import type { SegmentPath } from '../gen/roads';
import { FARM, type Site } from '../gen/settle';
import type { TownPlan } from '../gen/town';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Building footprints of the plans, filled: large ones lighter, edged in the small ones' colour (as wide as a road's casing, inside the footprint). */
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

/** A farmstead: house (along × across, m) and a barn joined to it in an L. */
const HOUSE = [12, 8];
const BARN = [18, 10];
/** The farmstead stands this far (m) beyond the end of its road. */
const FARM_OFF = 10;

/**
 * Farms: a farmstead where the farm's road ends — a house and a barn in an L, set
 * past the road's end (or beside the road, where it runs on). Decided from the
 * road edges at the farm's lattice vertex alone, so every chunk draws it alike.
 */
export function drawFarms(ctx: Ctx, sites: Site[], roads: SegmentPath[], cx: number, cy: number, pxPerM: number): void {
  const p = new Path2D();
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  for (const s of sites) {
    if (s.rank !== FARM) continue;
    const [vx, vy] = vertexPos(nearestVertex(s.x, s.y));
    // The (snapped) end of the road at the vertex, and the directions roads leave it in.
    let ex = vx;
    let ey = vy;
    let best = 35;
    for (const r of roads)
      for (const k of [0, r.xy.length - 2]) {
        const d = Math.hypot(r.xy[k] - vx, r.xy[k + 1] - vy);
        if (d < best) {
          best = d;
          ex = r.xy[k];
          ey = r.xy[k + 1];
        }
      }
    const dirs: [number, number][] = [];
    for (const r of [...roads].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      const n = r.xy.length;
      if (n < 4) continue;
      if (r.xy[0] === ex && r.xy[1] === ey) dirs.push([r.xy[2] - ex, r.xy[3] - ey]);
      else if (r.xy[n - 2] === ex && r.xy[n - 1] === ey) dirs.push([r.xy[n - 4] - ex, r.xy[n - 3] - ey]);
    }
    const h = hash3(0xfa4e, Math.round(vx), Math.round(vy));
    let ux: number;
    let uy: number;
    if (dirs.length === 1) {
      // Past the end of its road.
      const l = Math.hypot(dirs[0][0], dirs[0][1]) || 1;
      ux = -dirs[0][0] / l;
      uy = -dirs[0][1] / l;
    } else if (dirs.length) {
      // Beside a road that runs on.
      const l = Math.hypot(dirs[0][0], dirs[0][1]) || 1;
      const sd = h & 1 ? 1 : -1;
      ux = (-dirs[0][1] / l) * sd;
      uy = (dirs[0][0] / l) * sd;
    } else {
      const a = (h / 4294967296) * 2 * Math.PI;
      ux = Math.cos(a);
      uy = Math.sin(a);
    }
    const sd = h & 2 ? 1 : -1;
    const vxp = -uy * sd;
    const vyp = ux * sd;
    // House square across the road's line, barn off one end of it, reaching back.
    const hx = ex + ux * (FARM_OFF + HOUSE[1] / 2);
    const hy = ey + uy * (FARM_OFF + HOUSE[1] / 2);
    const bx = hx + vxp * (HOUSE[0] / 2 + BARN[1] / 2) + ux * (BARN[0] / 2 - HOUSE[1] / 2);
    const by = hy + vyp * (HOUSE[0] / 2 + BARN[1] / 2) + uy * (BARN[0] / 2 - HOUSE[1] / 2);
    for (const [mx, my, ax, ay, al, bl] of [
      [hx, hy, vxp, vyp, HOUSE[0], HOUSE[1]],
      [bx, by, ux, uy, BARN[0], BARN[1]],
    ]) {
      const [px, py] = [-ay, ax];
      const c = [
        [mx - (ax * al) / 2 - (px * bl) / 2, my - (ay * al) / 2 - (py * bl) / 2],
        [mx + (ax * al) / 2 - (px * bl) / 2, my + (ay * al) / 2 - (py * bl) / 2],
        [mx + (ax * al) / 2 + (px * bl) / 2, my + (ay * al) / 2 + (py * bl) / 2],
        [mx - (ax * al) / 2 + (px * bl) / 2, my - (ay * al) / 2 + (py * bl) / 2],
      ];
      p.moveTo((c[0][0] - ox) * pxPerM, (c[0][1] - oy) * pxPerM);
      for (let k = 1; k < 4; k++) p.lineTo((c[k][0] - ox) * pxPerM, (c[k][1] - oy) * pxPerM);
      p.closePath();
    }
  }
  ctx.fillStyle = STYLE.building;
  ctx.fill(p);
}
