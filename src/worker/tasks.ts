import { generateDem } from '../gen/dem';
import { CoarseField, generatePre, solveHydro } from '../gen/hydro';
import { latticeCell, routeCurves } from '../gen/lattice';
import { Motorways } from '../gen/motorway';
import { FARM, Settlements } from '../gen/settle';
import { Terrain } from '../gen/terrain';
import { planFarm } from '../gen/farm';
import { planTown } from '../gen/town';
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
        transfer: results.flatMap((r) => [r.zPre.buffer, r.R.buffer, r.off.buffer]),
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
    case 'net': {
      const view = new SeedView(t.seeds);
      const terrain = new Terrain(view);
      const field = new CoarseField(terrain, view);
      const set = new Settlements(field, terrain, view);
      const motorways = new Motorways(field, terrain, set, view).netCellPieces(t.gx, t.gy);
      const result = { ...latticeCell(t.gx, t.gy, field, set, terrain), motorways };
      return { result: { kind: 'net', result, ms: ms() }, transfer: motorways.map((m) => m.xy.buffer) };
    }
    case 'roads': {
      const result = routeCurves(t.segments, t.patch);
      return { result: { kind: 'roads', result, ms: ms() }, transfer: result.map((r) => r.xy.buffer) };
    }
    case 'plan': {
      const result = t.input.site.rank === FARM ? planFarm(t.input) : planTown(t.input);
      return {
        result: { kind: 'plan', result, ms: ms() },
        transfer: [
          ...result.streets.map((s) => s.xy.buffer),
          ...result.frontage.map((f) => f.xy.buffer),
          ...result.roads.map((r) => r.xy.buffer),
          result.buildings.buffer,
          result.industrial.buffer,
        ],
      };
    }
    case 'dem': {
      const result = generateDem(t.cx, t.cy, new SeedView(t.seeds), t.patch, t.sites);
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

