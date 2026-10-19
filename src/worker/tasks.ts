import { generateDem } from '../gen/dem';
import { generatePre, solveHydro } from '../gen/hydro';
import { SeedView } from '../gen/seeds';
import { renderChunk } from '../render/chunkRender';
import type { TaskRequest, TaskResult } from './protocol';

/** Executes one task. Shared by the worker entry and in-process tests. */
export function runTask(t: TaskRequest): { result: TaskResult; transfer: Transferable[] } {
  const t0 = performance.now();
  const ms = () => performance.now() - t0;
  switch (t.kind) {
    case 'pre': {
      const view = new SeedView(t.seeds);
      const results = t.chunks.map(([cx, cy]) => generatePre(cx, cy, view));
      return {
        result: { kind: 'pre', results, ms: ms() },
        transfer: results.flatMap((r) => [r.zPre.buffer, r.R.buffer]),
      };
    }
    case 'hydro': {
      const result = solveHydro(t.win, t.cx, t.cy, new SeedView(t.seeds));
      const { core } = result;
      return {
        result: { kind: 'hydro', result, ms: ms() },
        transfer: [core.zE, core.A, core.rec, core.lake].map((a) => a.buffer),
      };
    }
    case 'dem': {
      const result = generateDem(t.cx, t.cy, new SeedView(t.seeds), t.patch);
      return {
        result: { kind: 'dem', result, ms: ms() },
        transfer: [result.dem.buffer, result.water.buffer, result.cover.buffer, result.streams.buffer],
      };
    }
    case 'render': {
      const canvas = renderChunk(t);
      const bitmap = canvas.transferToImageBitmap();
      return { result: { kind: 'render', bitmap, ms: ms() }, transfer: [bitmap] };
    }
  }
}

