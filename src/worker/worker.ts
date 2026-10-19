/// <reference lib="webworker" />
import { SeedView } from '../gen/seeds';
import { generateDem } from '../gen/terrain';
import { renderChunk } from '../render/chunkRender';
import type { TaskResult, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

function run(req: WorkerRequest): { result: TaskResult; transfer: Transferable[] } {
  const t = req.task;
  const t0 = performance.now();
  switch (t.kind) {
    case 'terrain': {
      const r = generateDem(t.cx, t.cy, new SeedView(t.seeds));
      return {
        result: { kind: 'terrain', dem: r.dem, region: r.region, min: r.min, max: r.max, ms: performance.now() - t0 },
        transfer: [r.dem.buffer],
      };
    }
    case 'render': {
      const canvas = renderChunk({ dem: t.dem, pxSize: t.pxSize, dpr: t.dpr });
      const bitmap = canvas.transferToImageBitmap();
      return { result: { kind: 'render', bitmap, ms: performance.now() - t0 }, transfer: [bitmap] };
    }
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  let msg: WorkerResponse;
  let transfer: Transferable[] = [];
  try {
    const r = run(e.data);
    msg = { id: e.data.id, ok: true, result: r.result };
    transfer = r.transfer;
  } catch (err) {
    msg = { id: e.data.id, ok: false, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) };
  }
  self.postMessage(msg, transfer);
};
