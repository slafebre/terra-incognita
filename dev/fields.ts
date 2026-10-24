// Dev tool: field parcels and hedges, as SVG and per-km² figures.
//   npx vite-node dev/fields.ts [km] [R,R,...]
// Runs the whole pipeline in-process over a km × km area per region (world seed SEED=n, as
// the app's ?seed=n), lays out each chunk's fields as its render would, and writes
// <OUT>-R<r>.svg (OUT=fields): woods, water, ways, buildings, field edges (grey) and hedges
// (green). Reports field-edge and hedge length per km², and blocks cut, blocks too large
// (whose land gets furlongs) and furlong cells.
import { ChunkManager } from '../src/chunks/manager';
import { fieldStats, layFields } from '../src/gen/fields';
import { COVER, COVER_FIELDS } from '../src/gen/landcover';
import { setRegionOverride } from '../src/gen/terrain';
import { APRON, CELL, CHUNK, DEM_W } from '../src/lib/constants';
import { farmlandTests, shadeAndSlope } from '../src/render/chunkRender';
import { clearUnderBuiltUp } from '../src/render/roads';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

declare const process: { argv: string[]; env: Record<string, string | undefined> };
const FS = 'node:fs';
const { writeFileSync } = (await import(/* @vite-ignore */ FS)) as { writeFileSync(file: string, data: string): void };

const KM = Number(process.argv[2] ?? 2);
const REGIONS = (process.argv[3] ?? '0.12,0.4').split(',').map(Number);
const SEED = Number(process.env.SEED ?? 1);
const OUT = process.env.OUT ?? 'fields';
const ROAD = ['#d23a2a', '#f0b800', '#fff', '#5a4a40', '#5a4a40'];
const ROAD_W = [9, 7, 5, 1.6, 1.4];

for (const R of REGIONS) {
  setRegionOverride(R);
  for (const k in fieldStats) delete fieldStats[k];
  const x0 = Math.round(R * 1e6) - (((Math.round(R * 1e6) % CHUNK) + CHUNK) % CHUNK);
  const y0 = -x0;
  const n = Math.round((KM * 1000) / CHUNK);
  const view = { x0, y0, x1: x0 + n * CHUNK, y1: y0 + n * CHUNK };
  const inView = (cx: number, cy: number) => cx * CHUNK >= view.x0 && cx * CHUNK < view.x1 && cy * CHUNK >= view.y0 && cy * CHUNK < view.y1;
  const done = new Set<string>();
  let svg = '';
  let edgeKm = 0;
  const fieldMs: number[] = [];
  let hedgeKm = 0;
  let m: ChunkManager;
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
          let r: TaskResult;
          if (task.kind === 'render') {
            const key = `${task.cx},${task.cy}`;
            if (inView(task.cx, task.cy) && !done.has(key) && task.poi) {
              done.add(key);
              svg += chunkSvg(task);
            }
            r = { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 };
          } else r = runTask(task).result;
          this.busy--;
          resolve(r);
          queueMicrotask(() => m.schedule());
        }, 0),
      );
    },
  };
  const chunkSvg = (t: Extract<TaskRequest, { kind: 'render' }>) => {
    const { cx, cy, dem, water, plans } = t;
    const cover = t.cover.slice();
    clearUnderBuiltUp(cover, plans, cx, cy);
    const { slope } = shadeAndSlope(dem);
    const redrawn = new Set(plans.flatMap((p) => p.replaced));
    const drawn = [...t.roads.filter((q) => !redrawn.has(q.key)), ...plans.flatMap((p) => p.roads)];
    const tf = performance.now();
    const f = layFields({ cx, cy, edges: t.edges, patch: t.poi!, roads: drawn, plans, ...farmlandTests(cx, cy, cover, water, slope) });
    fieldMs.push(performance.now() - tf);
    let s = '';
    // Woods and water, 8 m cells.
    const N = DEM_W * DEM_W;
    for (let j = APRON; j < APRON + CHUNK / CELL; j += 2)
      for (let i = APRON; i < APRON + CHUNK / CELL; i += 2) {
        const k = j * DEM_W + i;
        const x = cx * CHUNK + (i - APRON) * CELL;
        const y = cy * CHUNK + (j - APRON) * CELL;
        if (water[k] > 0) s += `<rect x="${x}" y="${y}" width="8" height="8" fill="#bee1f7"/>`;
        else if (cover[COVER.forest * N + k] > 0) s += `<rect x="${x}" y="${y}" width="8" height="8" fill="#cde5b0"/>`;
      }
    void COVER_FIELDS;
    const line = (xy: ArrayLike<number>) => {
      let d = '';
      for (let i = 0; i < xy.length; i += 2) d += `${i ? 'L' : 'M'}${xy[i].toFixed(1)} ${xy[i + 1].toFixed(1)}`;
      return d;
    };
    const inChunk = (q: { xy: ArrayLike<number> }) => {
      const m2 = 2 * Math.floor(q.xy.length / 4);
      return Math.floor(q.xy[m2] / CHUNK) === cx && Math.floor(q.xy[m2 + 1] / CHUNK) === cy;
    };
    let fe = '';
    for (let i = 0; i < f.edges.length; i += 4) {
      fe += `M${f.edges[i].toFixed(1)} ${f.edges[i + 1].toFixed(1)}L${f.edges[i + 2].toFixed(1)} ${f.edges[i + 3].toFixed(1)}`;
      edgeKm += Math.hypot(f.edges[i + 2] - f.edges[i], f.edges[i + 3] - f.edges[i + 1]) / 1000;
    }
    s += `<path d="${fe}" fill="none" stroke="#9a8a70" stroke-width="1.2"/>`;
    let he = '';
    for (let i = 0; i < f.hedges.length; i += 4) {
      he += `M${f.hedges[i].toFixed(1)} ${f.hedges[i + 1].toFixed(1)}L${f.hedges[i + 2].toFixed(1)} ${f.hedges[i + 3].toFixed(1)}`;
      hedgeKm += Math.hypot(f.hedges[i + 2] - f.hedges[i], f.hedges[i + 3] - f.hedges[i + 1]) / 1000;
    }
    s += `<path d="${he}" fill="none" stroke="#3c8a2e" stroke-width="3" stroke-dasharray="0.1 5" stroke-linecap="round"/>`;
    for (const q of drawn.filter(inChunk).sort((a, b) => b.cls - a.cls))
      s += `<path d="${line(q.xy)}" fill="none" stroke="${ROAD[q.cls]}" stroke-width="${ROAD_W[q.cls]}" ${q.cls === 4 ? 'stroke-dasharray="8 6"' : ''} ${q.cls <= 2 ? 'stroke-linecap="round"' : ''}/>`;
    // LATTICE=1: the lattice edges carrying ways, as the blocks see them.
    if (process.env.LATTICE)
      for (const e of t.edges)
        if (Math.floor((e[0] + e[2]) / 2 / CHUNK) === cx && Math.floor((e[1] + e[3]) / 2 / CHUNK) === cy)
          s += `<path d="M${e[0]} ${e[1]}L${e[2]} ${e[3]}" stroke="#e0f" stroke-width="1.5"/>`;
    for (const pl of plans.filter((p) => Math.floor(p.x / CHUNK) === cx && Math.floor(p.y / CHUNK) === cy)) {
      let d = '';
      const b = pl.buildings;
      for (let i = 0; i < b.length; i += 8) d += `M${b[i].toFixed(1)} ${b[i + 1].toFixed(1)}L${b[i + 2].toFixed(1)} ${b[i + 3].toFixed(1)}L${b[i + 4].toFixed(1)} ${b[i + 5].toFixed(1)}L${b[i + 6].toFixed(1)} ${b[i + 7].toFixed(1)}Z`;
      s += `<path d="${d}" fill="rgb(138,38,34)"/>`;
      for (const st of pl.streets) s += `<path d="${line(st.xy)}" fill="none" stroke="#5a4a40" stroke-width="4"/>`;
    }
    return s;
  };
  m = new ChunkManager(pool, () => {}, SEED);
  const t0 = performance.now();
  for (let i = 0; i < 200000 && done.size < n * n; i++) {
    m.update(view, view, [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2]);
    await new Promise((r) => setTimeout(r, 0));
  }
  const W = view.x1 - view.x0;
  const file = `${OUT}-R${R}.svg`;
  writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x0} ${view.y0} ${W} ${W}" width="${W / 2}" height="${W / 2}"><rect x="${view.x0}" y="${view.y0}" width="${W}" height="${W}" fill="#fcfaf3"/>${svg}</svg>`);
  const km2 = (W / 1000) ** 2;
  console.log(
    `R=${R}: ${km2.toFixed(1)} km² (${done.size} chunks, ${((performance.now() - t0) / 1000).toFixed(0)} s): field edges ${(edgeKm / km2).toFixed(1)} km/km², hedges ${(hedgeKm / km2).toFixed(1)} km/km²; ` +
      Object.entries(fieldStats).map(([k, v]) => `${k} ${v}`).join(', ') +
      `; layout ${(fieldMs.reduce((a, b) => a + b, 0) / fieldMs.length).toFixed(0)} ms per chunk (max ${Math.max(...fieldMs).toFixed(0)}) → ${file}`,
  );
}
