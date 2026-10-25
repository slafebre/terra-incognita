import type { DemPatch, DemResult } from '../gen/dem';
import type { HydroResult, HydroWindow, PreResult } from '../gen/hydro';
import type { PoiPatch } from '../gen/poi';
import type { NetCell, RoadPatch, SegmentPath, SegmentTask } from '../gen/roads';
import type { SeedPayload } from '../gen/seeds';
import type { Site } from '../gen/settle';
import type { PlanInput, TownPlan } from '../gen/town';

export type TaskRequest =
  | { kind: 'pre'; chunks: [number, number][]; seeds: SeedPayload }
  | { kind: 'hydro'; cx: number; cy: number; win: HydroWindow; seeds: SeedPayload }
  | { kind: 'net'; gx: number; gy: number; seeds: SeedPayload }
  | { kind: 'roads'; cx: number; cy: number; segments: SegmentTask[]; patch: RoadPatch; motorways: Float64Array[] }
  | { kind: 'plan'; input: PlanInput }
  | { kind: 'dem'; cx: number; cy: number; patch: DemPatch; sites: Site[]; seeds: SeedPayload }
  | {
      kind: 'render';
      cx: number;
      cy: number;
      dem: Float32Array;
      water: Float32Array;
      cover: Int8Array;
      roads: SegmentPath[];
      /** Centre lines of the motorways passing near the chunk (world metres). */
      motorways: Float64Array[];
      /** Their profiles: the road's height at each point (m). */
      motorwayZ: Float32Array[];
      plans: TownPlan[];
      /** Fine nodes round the chunk for its points of interest (none if a solve was missing). */
      poi?: PoiPatch;
      /** Lattice edges carrying ways near the chunk ([ax, ay, bx, by] each). */
      edges: number[][];
      streams: Float32Array;
      pxSize: number;
      dpr: number;
    };

export type TaskResult =
  | { kind: 'pre'; results: PreResult[]; ms: number }
  | { kind: 'hydro'; result: HydroResult; ms: number }
  | { kind: 'net'; result: NetCell; ms: number }
  | { kind: 'roads'; result: SegmentPath[]; ms: number }
  | { kind: 'plan'; result: TownPlan; ms: number }
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
