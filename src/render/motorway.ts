import { type MotorwayDraw, MW_LEVEL, MW_TUNNEL, MW_VIADUCT, runsOf } from '../gen/motorway';
import { CHUNK } from '../lib/constants';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Ground this far above or below the road (m) before an earthwork is drawn beside it. */
const EARTH_H = 2.5;

/**
 * Earthworks and tunnels, under the roads: beside the surface stretches standing off the
 * ground, ticks every TICK_M m on both sides, as long as the bank is high (at least
 * EARTH_H): an embankment's broad at the road and pointing away, a cutting's pointing at
 * it; tunnels as their two edges dashed, a bar across at each portal.
 */
export function drawEarthworks(ctx: Ctx, ms: MotorwayDraw[], W: number, cx: number, cy: number, pxPerM: number, dpr: number): void {
  const s = STYLE.roads.motorway;
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  const px = (x: number) => (x - ox) * pxPerM;
  const py = (y: number) => (y - oy) * pxPerM;
  const half = W / 2 + STYLE.roads.casingWidth * dpr;
  const bank = new Path2D();
  for (const m of ms) {
    const n = m.xy.length / 2;
    let carry = 0;
    for (let i = 0; i + 1 < n; i++) {
      const [ax, ay, bx, by] = [m.xy[2 * i], m.xy[2 * i + 1], m.xy[2 * i + 2], m.xy[2 * i + 3]];
      const L = Math.hypot(bx - ax, by - ay);
      if (m.cls[i] !== MW_LEVEL || m.cls[i + 1] !== MW_LEVEL || !(Math.abs(m.d[i]) >= EARTH_H) || !(Math.abs(m.d[i + 1]) >= EARTH_H)) {
        carry = 0;
        continue;
      }
      // Off the chunk (and a tick's length): another chunk draws these.
      if (Math.max(ax, bx) < ox - 40 || Math.min(ax, bx) > ox + CHUNK + 40 || Math.max(ay, by) < oy - 40 || Math.min(ay, by) > oy + CHUNK + 40) continue;
      const ux = (bx - ax) / L;
      const uy = (by - ay) / L;
      let t = carry;
      for (; t < L; t += s.tickM) {
        const f = t / L;
        const d = m.d[i] + (m.d[i + 1] - m.d[i]) * f;
        const len = Math.min(s.tickMaxM, s.tickBaseM + s.tickPerM * Math.abs(d)) * pxPerM;
        const x = px(ax + ux * t);
        const y = py(ay + uy * t);
        const w = s.tickWidth * dpr;
        for (const side of [-1, 1]) {
          const nx = -uy * side;
          const ny = ux * side;
          // Embankment (ground below): broad at the road; cutting: broad at the top of the slope.
          const [near, far] = d < 0 ? [half, half + len] : [half + len, half];
          bank.moveTo(x + nx * near - ux * w, y + ny * near - uy * w);
          bank.lineTo(x + nx * near + ux * w, y + ny * near + uy * w);
          bank.lineTo(x + nx * far, y + ny * far);
          bank.closePath();
        }
      }
      carry = t - L; // where the next tick falls in the next segment
    }
  }
  ctx.fillStyle = s.bank;
  ctx.fill(bank);
  // Tunnels: dashed edges, portals.
  const edges = new Path2D();
  const portals = new Path2D();
  for (const m of ms)
    for (const run of runsOf(m, (c) => c === MW_TUNNEL, true)) {
      const k = run.length / 2;
      for (const side of [-1, 1]) {
        for (let i = 0; i < k; i++) {
          const j0 = Math.max(0, i - 1);
          const j1 = Math.min(k - 1, i + 1);
          const dx = run[2 * j1] - run[2 * j0];
          const dy = run[2 * j1 + 1] - run[2 * j0 + 1];
          const l = Math.hypot(dx, dy) || 1;
          const x = px(run[2 * i]) - (dy / l) * side * half;
          const y = py(run[2 * i + 1]) + (dx / l) * side * half;
          if (i) edges.lineTo(x, y);
          else edges.moveTo(x, y);
        }
      }
      for (const [i, j] of [
        [0, 1],
        [k - 1, k - 2],
      ]) {
        const dx = run[2 * j] - run[2 * i];
        const dy = run[2 * j + 1] - run[2 * i + 1];
        const l = Math.hypot(dx, dy) || 1;
        const x = px(run[2 * i]);
        const y = py(run[2 * i + 1]);
        const r = half + s.portalM * pxPerM;
        portals.moveTo(x - (dy / l) * r, y + (dx / l) * r);
        portals.lineTo(x + (dy / l) * r, y - (dx / l) * r);
      }
    }
  ctx.strokeStyle = STYLE.roads.casing;
  ctx.lineCap = 'butt';
  ctx.lineWidth = s.tunnelWidth * dpr;
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.stroke(edges);
  ctx.setLineDash([]);
  ctx.lineWidth = s.portalWidth * dpr;
  ctx.stroke(portals);
}

/** The viaduct runs of the motorways, one point past either end (as bridges over water). */
export function viaductLines(ms: MotorwayDraw[]): Float64Array[] {
  const out: Float64Array[] = [];
  for (const m of ms) {
    const n = m.xy.length / 2;
    for (let i = 0; i < n; i++) {
      if (m.cls[i] !== MW_VIADUCT) continue;
      let e = i;
      while (e + 1 < n && m.cls[e + 1] === MW_VIADUCT) e++;
      out.push(m.xy.slice(2 * Math.max(0, i - 1), 2 * Math.min(n - 1, e + 1) + 2));
      i = e;
    }
  }
  return out;
}

