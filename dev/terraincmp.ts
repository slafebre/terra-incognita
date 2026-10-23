// Dev tool: how the coarse surface (what the road network and settlements see)
// compares with the fine eroded surface (what the map shows), on seeded areas.
//   npx vite-node dev/terraincmp.ts [areas per region] [R,R,...]
// Samples every 64 m in each area: fine zE (hydro solve of the node's chunk), coarse
// z, coarse drainage area, and the uplift surface zPre. Reports overall agreement
// (heights and 256 m / 512 m slopes) and the height difference by coarse drainage
// class (hillslope … river), which shows where the two disagree.
import { ChunkManager } from '../src/chunks/manager';
import { CoarseField, CORE, CORE_PAD, NODE, NODES } from '../src/gen/hydro';
import { expand, SeedView } from '../src/gen/seeds';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

declare const process: { argv: string[]; env: Record<string, string | undefined> };

const AREAS = Number(process.argv[2] ?? 2);
const REGIONS = (process.argv[3] ?? '0.2,0.45,0.65').split(',').map(Number);
const SIZE = 3000;
const SEED = Number(process.env.SEED ?? 11);
let filledN = 0;

async function area(R: number, n: number) {
  setRegionOverride(R);
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
  const m = new ChunkManager(pool, () => {}, SEED * 1000 + n);
  const x = 20000 * n + Math.round(R * 1e6);
  const y = 7000;
  const view = { x0: x, y0: y, x1: x + SIZE, y1: y + SIZE };
  for (let i = 0; i < 40000 && !m.covered(view); i++) {
    m.update(view, view, [x + SIZE / 2, y + SIZE / 2]);
    await new Promise((r) => setTimeout(r, 0));
  }
  const r = { x0: x - 600, y0: y - 600, x1: x + SIZE + 600, y1: y + SIZE + 600 };
  const sv = new SeedView(m.seeds.payloadFor(r, expand(r, 40000)));
  const field = new CoarseField(new Terrain(sv), sv);
  const samples: { zf: number; zc: number; zp: number; zi: number; A: number; x: number; y: number }[] = [];
  for (let sy = y; sy < y + SIZE; sy += 64)
    for (let sx = x; sx < x + SIZE; sx += 64) {
      const gx = Math.round(sx / NODE);
      const gy = Math.round(sy / NODE);
      const c = m.chunks.get(`${Math.floor(gx / NODES)},${Math.floor(gy / NODES)}`);
      if (!c?.hydro || !c.pre) continue;
      const k = (gy - (c.cy * NODES - CORE_PAD)) * CORE + (gx - (c.cx * NODES - CORE_PAD));
      const pk = (gy - c.cy * NODES) * NODES + (gx - c.cx * NODES);
      samples.push({ zf: c.hydro.zE[k], zc: field.z(sx, sy), zp: c.pre.zPre[pk], zi: NaN, A: field.area(sx, sy), x: sx, y: sy });
      if (c.hydro.zE[k] - c.pre.zPre[pk] > 1) filledN++;
    }
  const index = new Map(samples.map((s) => [`${s.x},${s.y}`, s]));
  return { samples, field, at: (sx: number, sy: number) => index.get(`${sx},${sy}`) };
}

const mean2 = (a: number[]) => (a.reduce((s, v) => s + Math.abs(v), 0) / a.length).toFixed(3);
const corr = (a: number[], b: number[]) => {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
};

type Sample = { zf: number; zc: number; zp: number; zi: number; A: number; x: number; y: number };
for (const R of REGIONS) {
  const all: Sample[] = [];
  // Signed slopes over 256 m / 512 m baselines (x and y): fine, coarse, and the ideal
  // 256 m surface (fine sampled every 256 m, bilinear between) as an upper bound.
  const slopes: Record<number, [number[], number[], number[]]> = { 256: [[], [], []], 512: [[], [], []] };
  for (let n = 0; n < AREAS; n++) {
    const { samples, at } = await area(R, n);
    const local: Sample[] = [];
    const x0 = samples[0].x;
    const y0 = samples[0].y;
    for (const s of samples as Sample[]) {
      const u = (s.x - x0) / 256;
      const v = (s.y - y0) / 256;
      const i = Math.floor(u);
      const j = Math.floor(v);
      const g = (a: number, b: number) => at(x0 + a * 256, y0 + b * 256)?.zf;
      const z00 = g(i, j), z10 = g(i + 1, j), z01 = g(i, j + 1), z11 = g(i + 1, j + 1);
      if (z00 === undefined || z10 === undefined || z01 === undefined || z11 === undefined) continue;
      const fu = u - i, fv = v - j;
      s.zi = (z00 * (1 - fu) + z10 * fu) * (1 - fv) + (z01 * (1 - fu) + z11 * fu) * fv;
      local.push(s);
    }
    all.push(...local);
    const by = new Map(local.map((s) => [`${s.x},${s.y}`, s]));
    for (const s of local)
      for (const base of [256, 512])
        for (const [dx, dy] of [[base, 0], [0, base]]) {
          const o = by.get(`${s.x + dx},${s.y + dy}`);
          if (!o) continue;
          slopes[base][0].push((o.zf - s.zf) / base);
          slopes[base][1].push((o.zc - s.zc) / base);
          slopes[base][2].push((o.zi - s.zi) / base);
        }
  }
  const mean = (f: (s: (typeof all)[0]) => number, xs = all) => xs.reduce((a, s) => a + f(s), 0) / (xs.length || 1);
  console.log(`R=${R}: filled (fine surface > 1 m above its starting surface) ${((100 * filledN) / all.length).toFixed(1)}% of samples`);
  filledN = 0;
  console.log(
    `R=${R}: ${all.length} samples; heights fine ${mean((s) => s.zf).toFixed(0)}, coarse ${mean((s) => s.zc).toFixed(0)}, pre ${mean((s) => s.zp).toFixed(0)} m; ` +
      `correlation fine~coarse ${corr(all.map((s) => s.zf), all.map((s) => s.zc)).toFixed(2)}, fine~pre ${corr(all.map((s) => s.zf), all.map((s) => s.zp)).toFixed(2)}; ` +
      `slope correlation 256 m ${corr(slopes[256][0], slopes[256][1]).toFixed(2)} (ideal ${corr(slopes[256][0], slopes[256][2]).toFixed(2)}), ` +
      `512 m ${corr(slopes[512][0], slopes[512][1]).toFixed(2)} (ideal ${corr(slopes[512][0], slopes[512][2]).toFixed(2)}); ` +
      `mean |slope| 512 m fine ${mean2(slopes[512][0])}, coarse ${mean2(slopes[512][1])}`,
  );
  for (const [lo, hi, name] of [
    [0, 0.3, 'hillslope'],
    [0.3, 3, 'stream'],
    [3, 30, 'river'],
    [30, Infinity, 'big river'],
  ] as const) {
    const xs = all.filter((s) => s.A >= lo && s.A < hi);
    if (!xs.length) continue;
    console.log(
      `   ${name.padEnd(10)} (coarse A ${lo}–${hi} km², ${xs.length}): fine − coarse ${mean((s) => s.zf - s.zc, xs).toFixed(0)} m, pre − fine ${mean((s) => s.zp - s.zf, xs).toFixed(0)} m, pre − coarse ${mean((s) => s.zp - s.zc, xs).toFixed(0)} m`,
    );
  }
}
