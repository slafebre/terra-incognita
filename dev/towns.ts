// Dev tool: street plans of villages and towns, as SVG.
//   npx vite-node dev/towns.ts [per region] [R,R,...]
// Finds villages (TOWNS=1: towns, HAMLETS=1: hamlets) with a world seed (SEED=n), runs the whole
// pipeline in-process around each and writes its plan over the fine terrain:
// contours, water, roads, streets and built-up frontage. INPUTS=<file> caches the
// pipeline's output (the plans' inputs), so plans can be tuned without rerunning it. OUT=<prefix> names the
// files (default towns), one per settlement, plus <prefix>-sheet.svg of all (COLS per row).
import { ChunkManager } from '../src/chunks/manager';
import { CoarseField, NODE } from '../src/gen/hydro';
import { SeedStore, SeedView } from '../src/gen/seeds';
import { HAMLET, Settlements, TOWN, VILLAGE, type Site } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import { NET_REACH } from '../src/gen/roads';
import { buildingStats } from '../src/gen/buildings';
import { LANE, PLAN_EXTENT, planStats, planTown, type TownPlan, type PlanInput } from '../src/gen/town';
import { marchingSquares } from '../src/lib/contours';
import { rng } from '../src/lib/hash';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

declare const process: { argv: string[]; env: Record<string, string | undefined> };
const FS = 'node:fs';
const { writeFileSync, readFileSync, existsSync } = (await import(/* @vite-ignore */ FS)) as {
  writeFileSync(file: string, data: string): void;
  readFileSync(file: string, enc: 'utf8'): string;
  existsSync(file: string): boolean;
};

const PER = Number(process.argv[2] ?? 2);
const REGIONS = (process.argv[3] ?? '0.15,0.45,0.7').split(',').map(Number);
const SEED = Number(process.env.SEED ?? 1);
const RANK = process.env.TOWNS ? TOWN : process.env.HAMLETS ? HAMLET : VILLAGE;
const OUT = process.env.OUT ?? 'towns';

/** Sites of `rank` found from the seeds alone (the pipeline will agree: same world seed). */
function findSites(R: number, n: number): Site[] {
  const store = new SeedStore(SEED);
  const pick = rng(SEED * 31 + Math.round(R * 1000));
  const x = Math.round((pick() - 0.5) * 2e6);
  const y = Math.round((pick() - 0.5) * 2e6);
  const S = RANK === TOWN ? 30000 : RANK === VILLAGE ? 12000 : 5000;
  const r = { x0: x, y0: y, x1: x + S, y1: y + S };
  const view = new SeedView(store.payloadFor({ x0: x, y0: y, x1: x + 16, y1: y + 16 }, { x0: x - NET_REACH, y0: y - NET_REACH, x1: x + S + NET_REACH, y1: y + S + NET_REACH }));
  const t = new Terrain(view);
  const set = new Settlements(new CoarseField(t, view), t, view);
  return set.sitesIn(RANK, r.x0, r.y0, r.x1, r.y1).slice(0, n);
}

async function pipeline(site: Site): Promise<PlanInput | undefined> {
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
          const r: TaskResult =
            task.kind === 'render' ? { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 } : runTask(task).result;
          this.busy--;
          resolve(r);
          queueMicrotask(() => m.schedule());
        }, 0),
      );
    },
  };
  const m = new ChunkManager(pool, () => {}, SEED);
  // The view: the site's extent, less the margin the pipeline adds around it.
  const e = Math.max(64, PLAN_EXTENT[site.rank] - 500);
  const view = { x0: site.x - e, y0: site.y - e, x1: site.x + e, y1: site.y + e };
  let input: PlanInput | undefined;
  for (let i = 0; i < 40000 && !(input = m.planInput(site)); i++) {
    m.update(view, view, [site.x, site.y]);
    await new Promise((r) => setTimeout(r, 0));
  }
  return input;
}

const ROAD = ['#d23a2a', '#f0b800', '#fff', '#5a4a40', '#5a4a40'];
const ROAD_W = [9, 7, 5, 1.6, 1.4];

function svg({ input, plan: p }: { input: PlanInput; plan: TownPlan }): string {
  const { patch } = input;
  const x0 = patch.gx * NODE;
  const y0 = patch.gy * NODE;
  const W = (patch.w - 1) * NODE;
  const H = (patch.h - 1) * NODE;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${W} ${H}" width="${Math.round(W / 2)}" height="${Math.round(H / 2)}">`;
  s += `<rect x="${x0}" y="${y0}" width="${W}" height="${H}" fill="#fcfaf3"/>`;
  const poly = (xy: ArrayLike<number>) => {
    let d = '';
    for (let i = 0; i < xy.length; i += 2) d += `${i ? 'L' : 'M'}${xy[i].toFixed(1)} ${xy[i + 1].toFixed(1)}`;
    return d;
  };
  // Buildings.
  {
    let d = '';
    const b = p.buildings;
    for (let i = 0; i < b.length; i += 8) d += `M${b[i].toFixed(1)} ${b[i + 1].toFixed(1)}L${b[i + 2].toFixed(1)} ${b[i + 3].toFixed(1)}L${b[i + 4].toFixed(1)} ${b[i + 5].toFixed(1)}L${b[i + 6].toFixed(1)} ${b[i + 7].toFixed(1)}Z`;
    s += `<path d="${d}" fill="rgb(138,38,34)"/>`;
  }
  // Lakes and streams.
  for (let j = 0; j < patch.h; j++)
    for (let i = 0; i < patch.w; i++) {
      const k = j * patch.w + i;
      const x = (patch.gx + i) * NODE;
      const y = (patch.gy + j) * NODE;
      if (!Number.isNaN(patch.lake[k])) s += `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" fill="#bee1f7"/>`;
      else if (patch.A[k] > 0.15) s += `<circle cx="${x}" cy="${y}" r="${Math.min(8, 1.5 + Math.sqrt(patch.A[k]))}" fill="#1c82d2"/>`;
    }
  // Contours, 5 m.
  const segs = marchingSquares(patch.zE, patch.w, 0, 0, patch.w - 1, patch.h - 1, 5);
  for (const [lev, xy] of segs.byLevel) {
    let d = '';
    for (let i = 0; i < xy.length; i += 4)
      d += `M${(x0 + xy[i] * NODE).toFixed(1)} ${(y0 + xy[i + 1] * NODE).toFixed(1)}L${(x0 + xy[i + 2] * NODE).toFixed(1)} ${(y0 + xy[i + 3] * NODE).toFixed(1)}`;
    s += `<path d="${d}" fill="none" stroke="rgba(190,120,60,${lev % 25 ? 0.35 : 0.6})" stroke-width="${lev % 25 ? 1.2 : 2.4}"/>`;
  }
  // Roads (the plan's replacing the network's): casings, then fills.
  const redrawn = new Set(p.replaced);
  const all = [...input.roads.filter((r) => !redrawn.has(r.key)), ...p.roads];
  const roads = all.filter((r) => r.cls <= 2).sort((a, b) => b.cls - a.cls);
  for (const r of all.filter((r) => r.cls > 2))
    s += `<path d="${poly(r.xy)}" fill="none" stroke="${ROAD[r.cls]}" stroke-width="${ROAD_W[r.cls]}" ${r.cls === 4 ? 'stroke-dasharray="8 6"' : ''}/>`;
  for (const st of p.streets) s += `<path d="${poly(st.xy)}" fill="none" stroke="#463a34" stroke-width="${st.cls === LANE ? 5 : 7}" stroke-linecap="round" stroke-linejoin="round"/>`;
  for (const r of roads) s += `<path d="${poly(r.xy)}" fill="none" stroke="#463a34" stroke-width="${ROAD_W[r.cls] + 3}" stroke-linecap="round" stroke-linejoin="round"/>`;
  for (const st of p.streets) s += `<path d="${poly(st.xy)}" fill="none" stroke="#fff" stroke-width="${st.cls === LANE ? 2.5 : 4}" stroke-linecap="round" stroke-linejoin="round"/>`;
  for (const r of roads) s += `<path d="${poly(r.xy)}" fill="none" stroke="${ROAD[r.cls]}" stroke-width="${ROAD_W[r.cls]}" stroke-linecap="round" stroke-linejoin="round"/>`;
  // Centre and the site point.
  s += `<circle cx="${p.x}" cy="${p.y}" r="7" fill="#2d2826"/>`;
  s += `<circle cx="${input.site.x}" cy="${input.site.y}" r="10" fill="none" stroke="#c0f" stroke-width="2"/>`;
  s += `<circle cx="${input.site.x}" cy="${input.site.y}" r="${PLAN_EXTENT[p.rank]}" fill="none" stroke="#c0f" stroke-width="2" stroke-dasharray="10 10"/>`;
  return s + '</svg>';
}

const svgs: string[] = [];
type Saved = { site: Site; roads: { key: string; cls: number; xy: number[] }[]; patch: Omit<PlanInput['patch'], 'zE' | 'A' | 'lake'> & { zE: number[]; A: number[]; lake: (number | null)[] } };
let inputs: PlanInput[] = [];
if (process.env.INPUTS && existsSync(process.env.INPUTS)) {
  const saved = JSON.parse(readFileSync(process.env.INPUTS, 'utf8')) as Saved[];
  inputs = saved.map((v) => ({
    site: v.site,
    roads: v.roads.map((r) => ({ key: r.key, cls: r.cls as 0, xy: Float32Array.from(r.xy) })),
    patch: { ...v.patch, zE: Float32Array.from(v.patch.zE), A: Float32Array.from(v.patch.A), lake: Float32Array.from(v.patch.lake, (l) => l ?? NaN) },
  }));
} else {
  for (const R of REGIONS) {
    setRegionOverride(R);
    for (const site of findSites(R, PER)) {
      const t0 = performance.now();
      const input = await pipeline(site);
      console.log(`R=${R} ${site.id}: ${input ? '' : 'inputs never complete, '}pipeline ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      if (input) inputs.push(input);
    }
  }
  if (process.env.INPUTS) {
    const saved: Saved[] = inputs.map((v) => ({
      site: v.site,
      roads: v.roads.map((r) => ({ key: r.key, cls: r.cls, xy: [...r.xy] })),
      patch: { ...v.patch, zE: [...v.patch.zE], A: [...v.patch.A], lake: [...v.patch.lake].map((l) => (Number.isNaN(l) ? null : l)) },
    }));
    writeFileSync(process.env.INPUTS, JSON.stringify(saved));
  }
}
for (const input of inputs) {
  const { site } = input;
  const t0 = performance.now();
  const p = planTown(input);
  const ms = performance.now() - t0;
  let km = 0;
  for (const st of p.streets) for (let i = 2; i < st.xy.length; i += 2) km += Math.hypot(st.xy[i] - st.xy[i - 2], st.xy[i + 1] - st.xy[i - 1]) / 1000;
  // Large buildings (both sides over 15 m).
  let large = 0;
  for (let i = 0; i < p.buildings.length; i += 8) {
    const b = p.buildings;
    if (Math.hypot(b[i + 2] - b[i], b[i + 3] - b[i + 1]) > 15 && Math.hypot(b[i + 4] - b[i + 2], b[i + 5] - b[i + 3]) > 15) large++;
  }
  // Bare street: share of the fronts' sides (sampled every 5 m, 12 m off the centre line) with no building within 15 m.
  let bare = 0;
  let sides = 0;
  // …and along main roads (N, D, C) within 150 m of the centre.
  let mainBare = 0;
  let mainSides = 0;
  let mainLined = 0;
  {
    const redrawn = new Set(p.replaced);
    const mains = [...input.roads.filter((r) => !redrawn.has(r.key)), ...p.roads].filter((r) => r.cls <= 2).map((r) => r.xy);
    const onMain = (x: number, y: number) =>
      mains.some((m) => {
        for (let k = 0; k < m.length; k += 2) if (Math.abs(m[k] - x) < 0.5 && Math.abs(m[k + 1] - y) < 0.5) return true;
        return false;
      });
    const b = p.buildings;
    const quads: number[][] = [];
    for (let i = 0; i < b.length; i += 8) quads.push(Array.from(b.subarray(i, i + 8)));
    const inside = (q: number[], x: number, y: number) => {
      let sg = 0;
      for (let k = 0; k < 4; k++) {
        const c = (q[(2 * k + 2) % 8] - q[2 * k]) * (y - q[2 * k + 1]) - (q[(2 * k + 3) % 8] - q[2 * k + 1]) * (x - q[2 * k]);
        if (c !== 0) {
          if (sg && Math.sign(c) !== sg) return false;
          sg = Math.sign(c);
        }
      }
      return true;
    };
    const cs: [number, number][] = [];
    for (let i = 0; i < b.length; i += 8) cs.push([(b[i] + b[i + 4]) / 2, (b[i + 1] + b[i + 5]) / 2]);
    for (const fr of p.frontage) {
      const xy = fr.xy;
      const main = onMain(xy[0], xy[1]) && onMain(xy[xy.length - 2], xy[xy.length - 1]);
      for (let i = 2; i < xy.length; i += 2) {
        const dx = xy[i] - xy[i - 2];
        const dy = xy[i + 1] - xy[i - 1];
        const l = Math.hypot(dx, dy) || 1;
        for (let t = 0; t < l; t += 5)
          for (const sd of [1, -1]) {
            const x = xy[i - 2] + (dx * t) / l - (dy / l) * 12 * sd;
            const y = xy[i - 1] + (dy * t) / l + (dx / l) * 12 * sd;
            sides++;
            const isBare = !cs.some(([qx, qy]) => Math.abs(qx - x) < 15 && Math.abs(qy - y) < 15);
            if (isBare) bare++;
            if (main && Math.hypot(x - p.x, y - p.y) < 150) {
              mainSides++;
              if (isBare) mainBare++;
              // Lined: 7 m off the centre line (inside a terrace on any main road) falls in a footprint.
              const lx = xy[i - 2] + (dx * t) / l - (dy / l) * 7 * sd;
              const ly = xy[i - 1] + (dy * t) / l + (dx / l) * 7 * sd;
              if (quads.some((q) => inside(q, lx, ly))) mainLined++;
            }
          }
      }
    }
  }
  const f = `${OUT}-R${site.R.toFixed(2)}-${site.id.replace(/[:,]/g, '_')}.svg`;
  svgs.push(svg({ input, plan: p }));
  writeFileSync(f, svgs[svgs.length - 1]);
  console.log(
    `R=${site.R.toFixed(2)} ${site.id} at ${site.x.toFixed(0)},${site.y.toFixed(0)}: ${p.streets.length} streets, ${km.toFixed(2)} km, ` +
      `${p.buildings.length / 8} buildings (${large} large), ${((100 * bare) / Math.max(1, sides)).toFixed(0)} % bare (main roads near the centre: ${((100 * mainBare) / Math.max(1, mainSides)).toFixed(0)} % bare, ${((100 * mainLined) / Math.max(1, mainSides)).toFixed(0)} % lined), plan ${ms.toFixed(0)} ms → ${f}`,
  );
}
// One SVG of them all, nested in a grid (square, so thumbnailers show it whole).
{
  const cols = Number(process.env.COLS ?? Math.ceil(Math.sqrt(svgs.length)));
  const cell = 700;
  let sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${Math.max(cols, Math.ceil(svgs.length / cols)) * cell}" style="background:#999">`;
  svgs.forEach((t, i) => {
    sheet += t.replace('<svg ', `<svg x="${(i % cols) * cell + 3}" y="${Math.floor(i / cols) * cell + 3}" `).replace(/width="\d+" height="\d+"/, `width="${cell - 6}" height="${cell - 6}"`);
  });
  writeFileSync(`${OUT}-sheet.svg`, sheet + '</svg>');
}
console.log(Object.entries(planStats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
console.log(Object.entries(buildingStats).sort().map(([k, v]) => `${k} ${v}`).join(', '));
