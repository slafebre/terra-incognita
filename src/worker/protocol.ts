import type { SeedPayload } from '../gen/seeds';

export type TaskRequest =
  | { kind: 'terrain'; cx: number; cy: number; seeds: SeedPayload }
  | { kind: 'render'; cx: number; cy: number; dem: Float32Array; pxSize: number; dpr: number };

export type TaskResult =
  | { kind: 'terrain'; dem: Float32Array; region: number; min: number; max: number; ms: number }
  | { kind: 'render'; bitmap: ImageBitmap; ms: number };

export interface WorkerRequest {
  id: number;
  task: TaskRequest;
}

export type WorkerResponse = { id: number; ok: true; result: TaskResult } | { id: number; ok: false; error: string };
