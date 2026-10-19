// Dev probe: drives the chunk pipeline in-process (no workers) and prints progress.
import { ChunkManager } from '../src/chunks/manager';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

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
        const t0 = Date.now();
        const r: TaskResult =
          task.kind === 'render'
            ? { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 }
            : runTask(task).result;
        console.log(task.kind, 'cx' in task ? `${task.cx},${task.cy}` : '', Date.now() - t0, 'ms');
        this.busy--;
        resolve(r);
        queueMicrotask(() => m.schedule());
      }, 0),
    );
  },
};
const m = new ChunkManager(pool, () => {});
const view = { x0: 100_000, y0: 50_000, x1: 101_500, y1: 51_200 };
for (let i = 0; i < 3000 && !m.covered(view); i++) {
  m.update(view, view, [100_750, 50_600]);
  await new Promise((r) => setTimeout(r, 0));
}
console.log('covered', m.covered(view), m.stats.errors);
