/// <reference lib="webworker" />
import { setRegionOverride } from '../gen/terrain';
import type { WorkerConfig, WorkerRequest, WorkerResponse } from './protocol';
import { runTask } from './tasks';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<WorkerRequest | WorkerConfig>) => {
  if ('config' in e.data) {
    setRegionOverride(e.data.config.regionOverride);
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
