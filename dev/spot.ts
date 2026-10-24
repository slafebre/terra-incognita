// Dev tool: builds the pipeline around one place, seeded as the app's ?seed=n, and
// lists the ways drawn near it.
//   SEED=7 npx vite-node dev/spot.ts x y [R] [radius]
import { ChunkManager } from '../src/chunks/manager';
import { setRegionOverride } from '../src/gen/terrain';
import type { SegmentPath } from '../src/gen/roads';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

declare const process: { argv: string[]; env: Record<string, string | undefined> };
const [X, Y] = [Number(process.argv[2]), Number(process.argv[3])];
if (process.argv[4] !== undefined) setRegionOverride(Number(process.argv[4]));
const RAD = Number(process.argv[5] ?? 300);
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
const m = new ChunkManager(pool, () => {}, Number(process.env.SEED ?? 7) >>> 0);
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
