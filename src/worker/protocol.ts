import type { DemPatch, DemResult } from '../gen/dem';
import type { HydroResult, HydroWindow, PreResult } from '../gen/hydro';
import type { NetCell, RoadPatch, SegmentPath, SegmentTask } from '../gen/roads';
import type { SeedPayload } from '../gen/seeds';
import type { Site } from '../gen/settle';

export type TaskRequest =
  | { kind: 'pre'; chunks: [number, number][]; seeds: SeedPayload }
  | { kind: 'hydro'; cx: number; cy: number; win: HydroWindow; seeds: SeedPayload }
  | { kind: 'net'; gx: number; gy: number; seeds: SeedPayload }
  | { kind: 'roads'; cx: number; cy: number; segments: SegmentTask[]; patch: RoadPatch }
  | { kind: 'dem'; cx: number; cy: number; patch: DemPatch; sites: Site[]; seeds: SeedPayload }
  | {
      kind: 'render';
      cx: number;
      cy: number;
      dem: Float32Array;
      water: Float32Array;
      cover: Int8Array;
      roads: SegmentPath[];
      sites: Site[];
      streams: Float32Array;
      pxSize: number;
      dpr: number;
    };

export type TaskResult =
  | { kind: 'pre'; results: PreResult[]; ms: number }
  | { kind: 'hydro'; result: HydroResult; ms: number }
  | { kind: 'net'; result: NetCell; ms: number }
  | { kind: 'roads'; result: SegmentPath[]; ms: number }
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
