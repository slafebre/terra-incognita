// Dev tool: regression check for changes that should not change the land (or should
// change it only a little). Runs the pipeline in-process around a few places, seeded
// as the app's ?seed=n (so results don't depend on task order), captures every task's
// output by what it was for (chunk, net cell, plan) and either writes them or compares
// them with a file written earlier, field by field. Also prints per-stage timings.
//   OUT=<file> npx vite-node dev/golden.ts        write a baseline
//   GOLD=<file> npx vite-node dev/golden.ts       compare with one
// PLACES=n uses the first n places (default all), SEED=n the world seed (default 7).
import { ChunkManager } from '../src/chunks/manager';
import { setRegionOverride } from '../src/gen/terrain';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

declare const process: { argv: string[]; env: Record<string, string | undefined>; exitCode?: number };
type Buffer = Uint8Array;
// (Through variables: the project has no node types.)
const [FS, V8, ZLIB] = ['node:fs', 'node:v8', 'node:zlib'];
const fs = await import(FS);
const { deserialize, serialize } = (await import(V8)) as { serialize: (o: unknown) => Buffer; deserialize: (b: Buffer) => unknown };
const { gunzipSync, gzipSync } = (await import(ZLIB)) as { gzipSync: (b: Buffer) => Buffer; gunzipSync: (b: Buffer) => Buffer };

/** Places: centre (world m) and forced region (NaN: the region field). */
const PLACES: [number, number, number][] = [
  [100_750, 50_600, NaN],
  [-41_300, 12_900, 0.1],
  [23_400, -77_100, 0.42],
  [61_800, 88_300, 0.65],
  [-90_200, -30_700, 0.9],
];
const HALF = 700;
const SEED = Number(process.env.SEED ?? 7) >>> 0;
const places = PLACES.slice(0, Number(process.env.PLACES ?? PLACES.length));

type Out = Record<string, unknown>;
const outputs = new Map<string, Buffer>();
const ms: Record<string, { ms: number; n: number }> = {};

const keyOf = (t: TaskRequest, p: number): string[] => {
  switch (t.kind) {
    case 'pre':
      return t.chunks.map(([cx, cy]) => `${p}:pre:${cx},${cy}`);
    case 'net':
      // (Net cells carried their motorway pieces before the motorway stage: kept apart, to compare.)
      return [`${p}:net:${t.gx},${t.gy}`, `${p}:mw:${t.gx},${t.gy}`];
    case 'mw':
      return [`${p}:mw:${t.gx},${t.gy}`];
    case 'plan':
      return [`${p}:plan:${t.input.site.id}`];
    case 'render':
    case 'tile':
      return [];
    default:
      return [`${p}:${t.kind}:${t.cx},${t.cy}`];
  }
};
/** What a result holds, as plain data (render bitmaps can't be made in node). */
const payload = (r: TaskResult): Out[] => {
  switch (r.kind) {
    case 'pre':
      return r.results.map((x) => ({ ...x }));
    case 'hydro':
      return [{ ...r.result.core, stats: r.result.stats }];
    case 'dem':
      return [{ ...r.result }];
    case 'net': {
      const old = (r.result as { motorways?: unknown }).motorways;
      return [{ sites: r.result.sites, edges: r.result.edges }, ...(old ? [{ pieces: old }] : [])];
    }
    case 'mw':
      return [{ pieces: r.result }];
    case 'roads':
      return [{ roads: r.result }];
    case 'plan':
      return [{ ...r.result }];
    default:
      return [];
  }
};

let place = 0;
const pool = {
  size: 1,
  busy: 0,
  get idle() {
    return this.size - this.busy;
  },
  run(task: TaskRequest): Promise<TaskResult> {
    this.busy++;
    return new Promise((resolve) =>
      setTimeout(() => {
        let r: TaskResult;
        if (task.kind === 'render') r = { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 };
        else {
          r = runTask(task).result;
          const s = (ms[task.kind] ??= { ms: 0, n: 0 });
          s.ms += r.ms;
          s.n++;
          const keys = keyOf(task, place);
          // Serialized at once: the manager may keep and change what it gets.
          payload(r).forEach((o, i) => outputs.set(keys[i], serialize(o)));
        }
        this.busy--;
        resolve(r);
        queueMicrotask(() => mgr?.schedule());
      }, 0),
    );
  },
};

let mgr: ChunkManager | undefined;
const t0 = performance.now();
for (const [x, y, R] of places) {
  setRegionOverride(R);
  mgr = new ChunkManager(pool, () => {}, SEED);
  const view = { x0: x - HALF, y0: y - HALF, x1: x + HALF, y1: y + HALF };
  for (let i = 0; i < 40000 && !mgr.covered(view); i++) {
    mgr.update(view, view, [x, y]);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!mgr.covered(view)) throw new Error(`place ${place} not covered`);
  place++;
}
const total = performance.now() - t0;
console.log(`places ${places.length}, ${outputs.size} outputs, ${(total / 1000).toFixed(1)} s`);
for (const [k, s] of Object.entries(ms)) console.log(`  ${k.padEnd(6)} ${(s.ms / 1000).toFixed(2).padStart(7)} s  ${s.n} × ${(s.ms / s.n).toFixed(1)} ms`);

if (process.env.OUT) {
  fs.writeFileSync(process.env.OUT, gzipSync(serialize({ seed: SEED, places, ms, outputs: Object.fromEntries(outputs) })));
  console.log(`wrote ${process.env.OUT}`);
}

if (process.env.GOLD) {
  const gold = deserialize(gunzipSync(fs.readFileSync(process.env.GOLD))) as { ms: typeof ms; outputs: Record<string, Buffer> };
  console.log('timings vs gold:');
  for (const [k, s] of Object.entries(ms)) {
    const g = gold.ms[k];
    if (g) console.log(`  ${k.padEnd(6)} ${(g.ms / g.n).toFixed(1).padStart(7)} → ${(s.ms / s.n).toFixed(1).padStart(7)} ms  (${(g.ms / g.n / (s.ms / s.n)).toFixed(2)}×)`);
  }
  compare(gold.outputs);
}

/** Per kind and field: how many outputs differ and by how much. */
function compare(gold: Record<string, Buffer>): void {
  const stats = new Map<string, { n: number; same: number; cells: number; diff: number; max: number; sum: number; note?: string }>();
  const stat = (k: string) => {
    let s = stats.get(k);
    if (!s) stats.set(k, (s = { n: 0, same: 0, cells: 0, diff: 0, max: 0, sum: 0 }));
    return s;
  };
  const missing: string[] = [];
  const extra = [...outputs.keys()].filter((k) => !(k in gold));
  for (const [key, buf] of Object.entries(gold)) {
    if (Number(key.split(':')[0]) >= places.length) continue;
    const mine = outputs.get(key);
    if (!mine) {
      missing.push(key);
      continue;
    }
    const kind = key.split(':')[1];
    const a = deserialize(buf) as Out;
    const b = deserialize(mine) as Out;
    for (const f of Object.keys(a)) {
      const s = stat(`${kind}.${f}`);
      s.n++;
      const x = a[f];
      const y = b[f];
      if (ArrayBuffer.isView(x) && ArrayBuffer.isView(y)) {
        const p = x as unknown as ArrayLike<number>;
        const q = y as unknown as ArrayLike<number>;
        let d = 0;
        if (p.length !== q.length) {
          s.note = `length ${p.length} vs ${q.length}`;
          s.cells += Math.max(p.length, q.length);
          s.diff += Math.max(p.length, q.length);
          continue;
        }
        for (let i = 0; i < p.length; i++) {
          const u = p[i];
          const v = q[i];
          if (u === v || (Number.isNaN(u) && Number.isNaN(v))) continue;
          d++;
          const e = Number.isNaN(u) || Number.isNaN(v) ? Infinity : Math.abs(u - v);
          if (e > s.max) s.max = e;
          if (Number.isFinite(e)) s.sum += e;
        }
        s.cells += p.length;
        s.diff += d;
        if (!d) s.same++;
      } else {
        const same = JSON.stringify(x) === JSON.stringify(y);
        if (same) s.same++;
        else if (Array.isArray(x) && Array.isArray(y)) {
          // Lists of things with keys or ids: how many differ.
          const id = (o: unknown) => JSON.stringify(o);
          const sa = new Set(x.map(id));
          const sb = new Set(y.map(id));
          let only = 0;
          for (const k of sa) if (!sb.has(k)) only++;
          for (const k of sb) if (!sa.has(k)) only++;
          s.cells += sa.size + sb.size;
          s.diff += only;
        } else s.diff++;
      }
    }
  }
  console.log('outputs vs gold (field: identical outputs / compared; differing elements; max |Δ|, mean |Δ| of differing):');
  let all = true;
  for (const [k, s] of [...stats].sort()) {
    if (s.same !== s.n) all = false;
    const part = s.cells ? ` ${s.diff}/${s.cells} el (${((100 * s.diff) / s.cells).toFixed(3)} %)` : '';
    const mag = s.max ? ` max ${s.max.toPrecision(3)} mean ${(s.sum / Math.max(1, s.diff)).toPrecision(3)}` : '';
    console.log(`  ${s.same === s.n ? '=' : '≠'} ${k.padEnd(18)} ${s.same}/${s.n}${s.same === s.n ? '' : part + mag}${s.note ? ' ' + s.note : ''}`);
  }
  if (missing.length || extra.length) {
    all = false;
    const byKind = (ks: string[]) => {
      const n: Record<string, number> = {};
      for (const k of ks) n[k.split(':')[1]] = (n[k.split(':')[1]] ?? 0) + 1;
      return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ');
    };
    console.log(`  missing ${missing.length} (${byKind(missing)}), extra ${extra.length} (${byKind(extra)})`);
    if (process.env.LIST) console.log(`  missing: ${missing.join(' ')}\n  extra: ${extra.join(' ')}`);
  }
  console.log(all ? 'IDENTICAL' : 'DIFFERENT');
  if (!all) process.exitCode = 1;
}
