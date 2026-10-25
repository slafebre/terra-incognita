// Dev tool: builds the pipeline around one place, seeded as the app's ?seed=n, and
// lists the ways drawn near it. With SNAP=<file> (a snapshot from the app's info panel)
// it replays that land instead; x y default to the snapshot's view.
//   SEED=7 npx vite-node dev/spot.ts x y [R or -] [radius]
//   SNAP=dev/snaps/topo_x_y.json npx vite-node dev/spot.ts [x y] [R] [radius]
// SVG=<file> also draws the land within the radius: 5 m contours, streams, lakes and
// every way (roads by class; tracks solid, footpaths dashed, fine-routed ones in red), motorways and their ramps.
import { ChunkManager } from '../src/chunks/manager';
import { APRON, CELL, CHUNK, DEM_W } from '../src/lib/constants';
import { marchingSquares } from '../src/lib/contours';
import { setRegionOverride } from '../src/gen/terrain';
import type { SegmentPath } from '../src/gen/roads';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';
import { applySnap, snap } from './snap';

declare const process: { argv: string[]; env: Record<string, string | undefined> };
const [X, Y] = process.argv[2] === undefined && snap ? snap.at : [Number(process.argv[2]), Number(process.argv[3])];
if (process.argv[4] !== undefined && process.argv[4] !== '-') setRegionOverride(Number(process.argv[4]));
const RAD = Number(process.argv[5] ?? 300);
const FS = 'node:fs';
const pool = {
  size: 4,
  busy: 0,
  get idle() {
    return this.size - this.busy;
  },
  run(task: TaskRequest): Promise<TaskResult> {
    this.busy++;
    return new Promise((resolve) =>
      setTimeout(() => {
        const r: TaskResult = task.kind === 'render' ? { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 } : runTask(task).result;
        this.busy--;
        resolve(r);
        queueMicrotask(() => m.schedule());
      }, 0),
    );
  },
};
const m = new ChunkManager(pool, () => {}, snap ? (snap.seed ?? undefined) : Number(process.env.SEED ?? 7) >>> 0);
applySnap(m.seeds);
const view = { x0: X - 700, y0: Y - 700, x1: X + 700, y1: Y + 700 };
for (let i = 0; i < 40000 && !m.covered(view); i++) {
  m.update(view, view, [X, Y]);
  await new Promise((r) => setTimeout(r, 0));
}
const byKey = new Map<string, SegmentPath>();
for (const c of m.chunks.values()) for (const s of c.roads ?? []) byKey.set(s.key, s);
for (const s of byKey.values()) {
  let near = false;
  let len = 0;
  for (let i = 0; i < s.xy.length; i += 2) {
    if (Math.hypot(s.xy[i] - X, s.xy[i + 1] - Y) < RAD) near = true;
    if (i) len += Math.hypot(s.xy[i] - s.xy[i - 2], s.xy[i + 1] - s.xy[i - 1]);
  }
  if (!near) continue;
  const n = s.xy.length / 2;
  console.log(`cls ${s.cls}${s.micro ? ' micro' : ''} ${n} pts ${len.toFixed(0)} m  ${s.xy[0].toFixed(0)},${s.xy[1].toFixed(0)} → ${s.xy[2 * n - 2].toFixed(0)},${s.xy[2 * n - 1].toFixed(0)}  ${s.key.slice(0, 60)}`);
}

if (process.env.SVG) {
  const { writeFileSync } = (await import(/* @vite-ignore */ FS)) as { writeFileSync(file: string, data: string): void };
  const x0 = X - RAD, y0 = Y - RAD, W = 2 * RAD;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${W} ${W}" width="${Math.min(W, 900)}" height="${Math.min(W, 900)}" style="background:#fbfaf6">`;
  const f = (v: number) => v.toFixed(1);
  for (const c of m.chunks.values()) {
    const ox = c.cx * CHUNK, oy = c.cy * CHUNK;
    if (ox > X + RAD || oy > Y + RAD || ox + CHUNK < x0 || oy + CHUNK < y0) continue;
    if (c.dem) {
      const segs = marchingSquares(c.dem, DEM_W, APRON, APRON, APRON + CHUNK / CELL, APRON + CHUNK / CELL, 5);
      for (const [lv, s2] of segs.byLevel) {
        const idx = Math.round(lv) % 50 === 0;
        let d = '';
        for (let i = 0; i < s2.length; i += 4)
          d += `M${f(ox + (s2[i] - APRON) * CELL)} ${f(oy + (s2[i + 1] - APRON) * CELL)}L${f(ox + (s2[i + 2] - APRON) * CELL)} ${f(oy + (s2[i + 3] - APRON) * CELL)}`;
        svg += `<path d="${d}" stroke="#c9a27a" stroke-width="${idx ? 0.9 : 0.4}" fill="none"/>`;
      }
    }
    if (c.water) {
      let d = '';
      for (let j = 0; j < DEM_W - 1; j++)
        for (let i = 0; i < DEM_W - 1; i++)
          if (c.water[j * DEM_W + i] > 0) d += `M${ox + (i - APRON) * CELL} ${oy + (j - APRON) * CELL}h${CELL}v${CELL}h-${CELL}z`;
      if (d) svg += `<path d="${d}" fill="#bfe0f5"/>`;
    }
    if (c.streams) {
      const s2 = c.streams;
      for (let o = 0; o < s2.length; ) {
        const n = s2[o++];
        let d = '';
        for (let v = 0; v < n; v++, o += 3) d += `${v ? 'L' : 'M'}${f(ox + s2[o])} ${f(oy + s2[o + 1])}`;
        svg += `<path d="${d}" stroke="#3a8ad6" stroke-width="1.2" fill="none"/>`;
      }
    }
  }
  // Motorways (experimental): their true width, the central reservation as a thin line.
  const nets = (m as unknown as { nets: Map<string, { data?: { motorways?: { xy: ArrayLike<number> }[] } }> }).nets;
  for (const n of nets.values())
    for (const p of n.data?.motorways ?? []) {
      let d = '';
      for (let i = 0; i < p.xy.length; i += 2) d += `${i ? 'L' : 'M'}${f(p.xy[i])} ${f(p.xy[i + 1])}`;
      svg += `<path d="${d}" stroke="#d62c54" stroke-opacity="0.75" stroke-width="24" fill="none"/><path d="${d}" stroke="#463a34" stroke-width="0.7" fill="none"/>`;
    }
  const STROKE = ['#d2382f', '#e8b72b', '#888', '#222', '#222'];
  const WIDTH = [5, 4, 3, 1.2, 1.2];
  for (const s of [...byKey.values()].sort((a, b) => b.cls - a.cls)) {
    let d = '';
    for (let i = 0; i < s.xy.length; i += 2) d += `${i ? 'L' : 'M'}${f(s.xy[i])} ${f(s.xy[i + 1])}`;
    const col = s.ramp ? '#9c1c40' : s.cls >= 3 && s.micro ? '#c22' : STROKE[s.cls];
    svg += `<path d="${d}" stroke="${col}" stroke-width="${s.ramp ? 6 : WIDTH[s.cls]}" fill="none"${s.cls === 4 ? ' stroke-dasharray="5 3"' : ''}/>`;
  }
  writeFileSync(process.env.SVG, svg + '</svg>');
}

if (process.env.GRADES) {
  // Grade along each way, measured on the map's DEM every 8 m.
  const zAt = (x: number, y: number) => {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    const c = m.chunks.get(`${cx},${cy}`);
    if (!c?.dem) return NaN;
    const u = (x - cx * CHUNK) / CELL + APRON, v = (y - cy * CHUNK) / CELL + APRON;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, k = j * DEM_W + i, z = c.dem;
    return (z[k] * (1 - fu) + z[k + 1] * fu) * (1 - fv) + (z[k + DEM_W] * (1 - fu) + z[k + DEM_W + 1] * fu) * fv;
  };
  const LIM = [0.07, 0.1, 0.15, 0.22, 0.45];
  const tot = [0, 0, 0, 0, 0], over = [0, 0, 0, 0, 0], climb = [0, 0, 0, 0, 0];
  for (const s of byKey.values()) {
    const xy = s.xy;
    let L = 0;
    let zp = NaN;
    let acc = 0;
    let x0 = xy[0], y0 = xy[1];
    for (let i = 2; i < xy.length; i += 2) {
      const d = Math.hypot(xy[i] - x0, xy[i + 1] - y0);
      if (d < 8 && i < xy.length - 2) continue;
      const z0 = Number.isNaN(zp) ? zAt(x0, y0) : zp;
      const z1 = zAt(xy[i], xy[i + 1]);
      if (Math.hypot(xy[i] - X, xy[i + 1] - Y) < RAD && !Number.isNaN(z0 + z1)) {
        const g = Math.abs(z1 - z0) / d;
        tot[s.cls] += d;
        climb[s.cls] += Math.abs(z1 - z0);
        if (g > LIM[s.cls]) over[s.cls] += d;
        L += d;
        acc += Math.abs(z1 - z0);
      }
      zp = z1;
      x0 = xy[i];
      y0 = xy[i + 1];
    }
    if (process.env.GRADES === '2' && s.cls >= 3 && L > 0) console.log(`  cls ${s.cls}${s.micro ? ' micro' : ''} ${L.toFixed(0)} m  mean grade ${(acc / L).toFixed(2)}  ${s.key.slice(0, 40)}`);
  }
  for (let k = 0; k < 5; k++)
    if (tot[k]) console.log(`cls ${k}: ${(tot[k] / 1000).toFixed(2)} km, mean grade ${(climb[k] / tot[k]).toFixed(3)}, over limit ${((100 * over[k]) / tot[k]).toFixed(0)} %`);
}
