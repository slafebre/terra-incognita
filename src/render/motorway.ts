import { NODE } from '../gen/hydro';
import type { RoadPatch } from '../gen/roads';
import { CHUNK } from '../lib/constants';
import { STYLE } from './style';

type Ctx = OffscreenCanvasRenderingContext2D;

/**
 * Motorways (experimental) against the ground: each point of a centre line is on the
 * surface (its earthworks, if any, drawn beside it), on a viaduct or in a tunnel, by how
 * far the map's ground lies below or above the road's profile (`MotorwayPiece.z`).
 */
export const MW_LEVEL = 0;
export const MW_VIADUCT = 1;
export const MW_TUNNEL = 2;

export interface MotorwayDraw {
  xy: Float64Array;
  /** Per point: MW_LEVEL, MW_VIADUCT or MW_TUNNEL. */
  cls: Uint8Array;
  /** Per point: the ground's height above the road (m; negative below), NaN where unknown. */
  d: Float32Array;
}

/** Ground this far below the road (m): a viaduct; this far above: a tunnel. Between, earthworks from EARTH_H. */
const VIADUCT_H = 10;
const TUNNEL_H = 25;
export const EARTH_H = 2.5;
/** The road's height: the ground averaged over this many points (25 m apart) either side. */
const PROFILE_HALF = 20;
/** Depths are a median over this many points either side (the fine nodes are 16 m apart, points 25 m). */
const MEDIAN = 2;
/** Viaducts and tunnels shorter than this many points are left as earthworks. */
const MIN_RUN = 3;

/**
 * Classes the points of each motorway by the ground under them: the fine nodes round the
 * chunk (each from its own chunk's solve, so every chunk reads them alike; reaching far
 * beyond it), or none (all on the surface) where they are missing. The road's height is
 * that ground averaged along it over ±PROFILE_HALF points, the pieces joined end to end
 * (a chunk is given those within ~700 m, so the average round its own points is whole):
 * so only valleys deep and narrow against it are bridged, hills cut or tunnelled. (A
 * profile from the coarse surface, which lies some 15 m off the map's ground in places,
 * bridged long stretches of flat land.)
 */
export function classifyMotorways(lines: Float64Array[], p?: RoadPatch): MotorwayDraw[] {
  const ground = (x: number, y: number) => {
    if (!p) return NaN;
    const u = x / NODE - p.gx;
    const v = y / NODE - p.gy;
    if (u < 0 || v < 0 || u > p.w - 1.001 || v > p.h - 1.001) return NaN;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const k = j * p.w + i;
    const fu = u - i;
    const fv = v - j;
    const z = p.zE;
    return (z[k] * (1 - fu) + z[k + 1] * fu) * (1 - fv) + (z[k + p.w] * (1 - fu) + z[k + p.w + 1] * fu) * fv;
  };
  // Chains of pieces meeting end to start (their joint shared), each in order.
  const key = (xy: Float64Array, k: number) => `${xy[k]},${xy[k + 1]}`;
  const byStart = new Map<string, number>();
  lines.forEach((xy, li) => byStart.set(key(xy, 0), li));
  const hasPrev = new Set<number>();
  lines.forEach((xy) => {
    const next = byStart.get(key(xy, xy.length - 2));
    if (next !== undefined) hasPrev.add(next);
  });
  const out: MotorwayDraw[] = lines.map((xy) => ({ xy, cls: new Uint8Array(xy.length / 2), d: new Float32Array(xy.length / 2).fill(NaN) }));
  const seen = new Set<number>();
  const chain = (first: number) => {
    const members: number[] = [];
    for (let li: number | undefined = first; li !== undefined && !seen.has(li); li = byStart.get(key(lines[li], lines[li].length - 2))) {
      seen.add(li);
      members.push(li);
    }
    // Its points in order (the joints once), and where each line's points lie in it.
    const pts: number[] = [];
    const at: number[] = [];
    for (const li of members) {
      const xy = lines[li];
      const skip = pts.length ? 1 : 0;
      at.push(pts.length / 2 - skip);
      for (let k = 2 * skip; k < xy.length; k++) pts.push(xy[k]);
    }
    const n = pts.length / 2;
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) g[i] = ground(pts[2 * i], pts[2 * i + 1]);
    const raw = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(g[i])) continue;
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - PROFILE_HALF); j <= Math.min(n - 1, i + PROFILE_HALF); j++)
        if (!Number.isNaN(g[j])) {
          s += g[j];
          c++;
        }
      if (c > PROFILE_HALF) raw[i] = g[i] - s / c;
    }
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w: number[] = [];
      for (let j = Math.max(0, i - MEDIAN); j <= Math.min(n - 1, i + MEDIAN); j++) if (!Number.isNaN(raw[j])) w.push(raw[j]);
      w.sort((a, b) => a - b);
      d[i] = w.length ? w[w.length >> 1] : NaN;
    }
    const cls = new Uint8Array(n);
    for (let i = 0; i < n; i++) cls[i] = d[i] < -VIADUCT_H ? MW_VIADUCT : d[i] > TUNNEL_H ? MW_TUNNEL : MW_LEVEL;
    for (let i = 0; i < n; i++) {
      if (cls[i] === MW_LEVEL) continue;
      let e = i;
      while (e + 1 < n && cls[e + 1] === cls[i]) e++;
      if (e - i + 1 < MIN_RUN) cls.fill(MW_LEVEL, i, e + 1);
      i = e;
    }
    members.forEach((li, m) => {
      const k = lines[li].length / 2;
      out[li].cls.set(cls.subarray(at[m], at[m] + k));
      out[li].d.set(d.subarray(at[m], at[m] + k));
    });
  };
  lines.forEach((_, li) => !hasPrev.has(li) && chain(li));
  lines.forEach((_, li) => !seen.has(li) && chain(li)); // closed loops, if any
  return out;
}

/**
 * The runs of a motorway whose segments `keep` holds: a segment counts by its points'
 * classes (both, with `both`; else either), so a surface run reaches a tunnel's portal.
 */
export function runsOf(m: MotorwayDraw, keep: (cls: number) => boolean, both = false): Float64Array[] {
  const out: Float64Array[] = [];
  const n = m.xy.length / 2;
  let cur: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = keep(m.cls[i]);
    const b = keep(m.cls[i + 1]);
    if (both ? a && b : a || b) {
      if (!cur.length) cur.push(m.xy[2 * i], m.xy[2 * i + 1]);
      cur.push(m.xy[2 * i + 2], m.xy[2 * i + 3]);
    } else if (cur.length) {
      out.push(Float64Array.from(cur));
      cur = [];
    }
  }
  if (cur.length) out.push(Float64Array.from(cur));
  return out;
}

/** The motorway's centre lines where it runs above ground (not in tunnels). */
export const surfaceLines = (ms: MotorwayDraw[]) => ms.flatMap((m) => runsOf(m, (c) => c !== MW_TUNNEL));

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

