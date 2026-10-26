/// <reference lib="webworker" />
import { adoptCoarseTile } from '../gen/hydro';
import { setRegionOverride } from '../gen/terrain';
import type { WorkerConfig, WorkerRequest, WorkerResponse, WorkerTiles } from './protocol';
import { runTask } from './tasks';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<WorkerRequest | WorkerConfig | WorkerTiles>) => {
  if ('config' in e.data) {
    setRegionOverride(e.data.config.regionOverride);
    return;
  }
  if ('tiles' in e.data) {
    for (const { key, tile } of e.data.tiles) adoptCoarseTile(key, tile);
    return;
  }
  let msg: WorkerResponse;
  let transfer: Transferable[] = [];
  try {
    const r = runTask(e.data.task);
    msg = { id: e.data.id, ok: true, result: r.result };
    transfer = r.transfer;
  } catch (err) {
    msg = { id: e.data.id, ok: false, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) };
  }
  self.postMessage(msg, transfer);
};
