import type { DemPatch, DemResult } from '../gen/dem';
import type { HydroResult, HydroWindow, PreResult } from '../gen/hydro';
import type { SeedPayload } from '../gen/seeds';

export type TaskRequest =
  | { kind: 'pre'; chunks: [number, number][]; seeds: SeedPayload }
  | { kind: 'hydro'; cx: number; cy: number; win: HydroWindow; seeds: SeedPayload }
  | { kind: 'dem'; cx: number; cy: number; patch: DemPatch; seeds: SeedPayload }
  | {
      kind: 'render';
      dem: Float32Array;
      water: Float32Array;
      streams: Float32Array;
      pxSize: number;
      dpr: number;
    };

export type TaskResult =
  | { kind: 'pre'; results: PreResult[]; ms: number }
  | { kind: 'hydro'; result: HydroResult; ms: number }
  | { kind: 'dem'; result: DemResult; ms: number }
  | { kind: 'render'; bitmap: ImageBitmap; ms: number };

export type TaskKind = TaskRequest['kind'];

export interface WorkerRequest {
  id: number;
  task: TaskRequest;
}

/** Sent once to each worker before any task. */
export interface WorkerConfig {
  config: { regionOverride: number };
}

export type WorkerResponse = { id: number; ok: true; result: TaskResult } | { id: number; ok: false; error: string };
