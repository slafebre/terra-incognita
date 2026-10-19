import { CHUNK, DPR_MAX, FORGET, GEN_MARGIN, M_PER_CSS_PX } from '../lib/constants';
import { DEM_PAD, DEM_PATCH, type DemPatch } from '../gen/dem';
import {
  blendWeight,
  CORE,
  CORE_PAD,
  NODES,
  WIN_CHUNKS,
  COARSE_REACH,
  type HydroCore,
  type HydroWindow,
  type PreResult,
} from '../gen/hydro';
import { expand, intersects, SeedStore, type Rect } from '../gen/seeds';
import type { TaskRunner } from '../worker/pool';
import type { TaskKind, TaskRequest, TaskResult } from '../worker/protocol';

export interface Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly key: string;
  busy: boolean;
  /** Set after a task throws, so a broken chunk isn't retried forever. */
  failed?: boolean;
  /** Uplift surface and region at node resolution. */
  pre?: PreResult;
  /** Core of the window solve centred on this chunk. */
  hydro?: HydroCore;
  dem?: Float32Array;
  water?: Float32Array;
  cover?: Int8Array;
  streams?: Float32Array;
  region?: number;
  bitmap?: ImageBitmap;
  bitmapBucket: number;
}

type Candidate = { chunk: Chunk; kind: TaskKind; priority: number };

const chunkRect = (cx: number, cy: number): Rect => ({
  x0: cx * CHUNK,
  y0: cy * CHUNK,
  x1: (cx + 1) * CHUNK,
  y1: (cy + 1) * CHUNK,
});

export const chunkKey = (cx: number, cy: number) => `${cx},${cy}`;

/** Calls `f` for every chunk coordinate overlapping `r`. */
export function forChunksIn(r: Rect, f: (cx: number, cy: number) => void): void {
  const cx0 = Math.floor(r.x0 / CHUNK);
  const cy0 = Math.floor(r.y0 / CHUNK);
  const cx1 = Math.ceil(r.x1 / CHUNK) - 1;
  const cy1 = Math.ceil(r.y1 / CHUNK) - 1;
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) f(cx, cy);
}

const PRE_BATCH = 8;
const COARSE_RADIUS_M = COARSE_REACH + (WIN_CHUNKS + 1) * CHUNK + 512;

/**
 * Owns chunk state and schedules the generation pipeline:
 *
 *   pre (per chunk) → hydro (window solve centred on the chunk)
 *   → dem (blend of the 3×3 surrounding solves; 4 m surface + water) → render
 *
 * Everything is a pure function of the seeds: hydro needs `pre` for every chunk
 * within WIN_CHUNKS, dem needs the hydro solves of the chunk and its 8 neighbours.
 */
export class ChunkManager {
  readonly chunks = new Map<string, Chunk>();
  readonly seeds = new SeedStore();
  renderBucket = 1;
  dpr = 1;
  readonly stats: Record<TaskKind, { ms: number; n: number }> & { errors: number } = {
    pre: { ms: 0, n: 0 },
    hydro: { ms: 0, n: 0 },
    dem: { ms: 0, n: 0 },
    render: { ms: 0, n: 0 },
    errors: 0,
  };

  private genRect: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private hydroRect: Rect = this.genRect;
  private preRect: Rect = this.genRect;
  private keepBitmapRect: Rect = this.genRect;
  private forgetRect: Rect = this.genRect;
  private focus: [number, number] = [0, 0];

  constructor(
    private readonly pool: TaskRunner,
    private readonly onChange: () => void,
  ) {}

  get pxSize(): number {
    return Math.ceil((CHUNK / M_PER_CSS_PX) * this.renderBucket * Math.min(this.dpr, DPR_MAX));
  }

  get(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  drawable(cx: number, cy: number): boolean {
    return !!this.get(cx, cy)?.bitmap;
  }

  /** True if every chunk overlapping `r` can be drawn. */
  covered(r: Rect): boolean {
    const e = 0.01;
    const inner = { x0: r.x0 + e, y0: r.y0 + e, x1: r.x1 - e, y1: r.y1 - e };
    let ok = true;
    forChunksIn(inner, (cx, cy) => {
      if (ok && !this.drawable(cx, cy)) ok = false;
    });
    return ok;
  }

  update(actual: Rect, desired: Rect, focus: [number, number]): void {
    const union = {
      x0: Math.min(actual.x0, desired.x0),
      y0: Math.min(actual.y0, desired.y0),
      x1: Math.max(actual.x1, desired.x1),
      y1: Math.max(actual.y1, desired.y1),
    };
    this.genRect = expand(union, GEN_MARGIN);
    this.hydroRect = expand(this.genRect, CHUNK);
    this.preRect = expand(this.hydroRect, WIN_CHUNKS * CHUNK);
    this.keepBitmapRect = expand(union, 2 * CHUNK);
    this.forgetRect = expand(actual, FORGET);
    this.focus = focus;
    this.forget();
    this.schedule();
  }

  // --- Forgetting ------------------------------------------------------------

  private forget(): void {
    // Chunks just outside the forget rectangle survive one more ring, so every
    // retained chunk keeps the neighbours whose solves its DEM blends.
    const tileKeep = expand(this.forgetRect, CHUNK);
    for (const [k, c] of this.chunks) {
      const r = chunkRect(c.cx, c.cy);
      if (!intersects(r, tileKeep)) {
        c.bitmap?.close();
        this.chunks.delete(k);
        // Neighbours' surfaces blended this chunk's solve: recompute them later.
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const n = this.get(c.cx + dx, c.cy + dy);
            if (n && n.dem && !n.busy) this.dropSurface(n);
          }
      } else if (c.bitmap && !c.busy && !intersects(r, this.keepBitmapRect)) {
        c.bitmap.close();
        c.bitmap = undefined;
      }
    }
    this.seeds.prune(this.forgetRect);
  }

  private dropSurface(c: Chunk): void {
    c.dem = c.water = c.cover = c.streams = undefined;
    c.bitmap?.close();
    c.bitmap = undefined;
  }

  // --- Scheduling ------------------------------------------------------------

  schedule(): void {
    while (this.pool.idle > 0) {
      const next = this.pick();
      if (!next.length) return;
      this.dispatch(next);
    }
  }

  private ensure(cx: number, cy: number): Chunk {
    const key = chunkKey(cx, cy);
    let c = this.chunks.get(key);
    if (!c) this.chunks.set(key, (c = { cx, cy, key, busy: false, bitmapBucket: 0 }));
    return c;
  }

  private hydroReady(c: Chunk): boolean {
    for (let dy = -WIN_CHUNKS; dy <= WIN_CHUNKS; dy++)
      for (let dx = -WIN_CHUNKS; dx <= WIN_CHUNKS; dx++) if (!this.get(c.cx + dx, c.cy + dy)?.pre) return false;
    return true;
  }

  private demReady(c: Chunk): boolean {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (!this.get(c.cx + dx, c.cy + dy)?.hydro) return false;
    return true;
  }

  /** Best next task (a pre task may batch several chunks). */
  private pick(): Candidate[] {
    const [fx, fy] = this.focus;
    const pres: Candidate[] = [];
    let best: Candidate | undefined;
    const consider = (cand: Candidate, ready: () => boolean) => {
      if (best && cand.priority >= best.priority) return;
      if (ready()) best = cand;
    };
    forChunksIn(this.preRect, (cx, cy) => {
      const c = this.ensure(cx, cy);
      if (c.busy || c.failed) return;
      const r = chunkRect(cx, cy);
      const d = Math.hypot((cx + 0.5) * CHUNK - fx, (cy + 0.5) * CHUNK - fy);
      if (!c.pre) {
        pres.push({ chunk: c, kind: 'pre', priority: d });
        return;
      }
      if (!c.hydro) {
        if (intersects(r, this.hydroRect)) consider({ chunk: c, kind: 'hydro', priority: d }, () => this.hydroReady(c));
        return;
      }
      if (!intersects(r, this.genRect)) return;
      if (!c.dem) {
        consider({ chunk: c, kind: 'dem', priority: d }, () => this.demReady(c));
        return;
      }
      if (!c.bitmap) consider({ chunk: c, kind: 'render', priority: d }, () => true);
      else if (c.bitmapBucket !== this.renderBucket)
        consider({ chunk: c, kind: 'render', priority: d + 3000 }, () => true); // stale zoom: still drawable
    });
    pres.sort((a, b) => a.priority - b.priority);
    // Pre tasks are cheap and everything waits on them: prefer a batch when one is closer.
    if (pres.length && (!best || pres[0].priority <= best.priority + CHUNK)) return pres.slice(0, PRE_BATCH);
    return best ? [best] : [];
  }

  private dispatch(cands: Candidate[]): void {
    const kind = cands[0].kind;
    for (const c of cands) c.chunk.busy = true;
    const c = cands[0].chunk;
    let task: TaskRequest;
    let transfer: Transferable[] = [];
    switch (kind) {
      case 'pre': {
        const r = cands.reduce(
          (acc, k) => ({
            x0: Math.min(acc.x0, k.chunk.cx * CHUNK),
            y0: Math.min(acc.y0, k.chunk.cy * CHUNK),
            x1: Math.max(acc.x1, (k.chunk.cx + 1) * CHUNK),
            y1: Math.max(acc.y1, (k.chunk.cy + 1) * CHUNK),
          }),
          { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
        );
        task = { kind, chunks: cands.map((k) => [k.chunk.cx, k.chunk.cy]), seeds: this.seeds.payloadFor(expand(r, 16)) };
        break;
      }
      case 'hydro': {
        const centre = { x: (c.cx + 0.5) * CHUNK, y: (c.cy + 0.5) * CHUNK };
        task = {
          kind,
          cx: c.cx,
          cy: c.cy,
          win: this.window(c),
          seeds: this.seeds.payloadFor(
            // Whole window: routing randomness comes from each node's chunk seed.
            expand(chunkRect(c.cx, c.cy), WIN_CHUNKS * CHUNK + 16),
            expand({ x0: centre.x, y0: centre.y, x1: centre.x, y1: centre.y }, COARSE_RADIUS_M),
          ),
        };
        break;
      }
      case 'dem':
        task = {
          kind,
          cx: c.cx,
          cy: c.cy,
          patch: this.demPatch(c),
          seeds: this.seeds.payloadFor(expand(chunkRect(c.cx, c.cy), 16)),
        };
        break;
      case 'render': {
        const dem = c.dem!.slice();
        const water = c.water!.slice();
        const cover = c.cover!.slice();
        const streams = c.streams!.slice();
        task = { kind, cx: c.cx, cy: c.cy, dem, water, cover, streams, pxSize: this.pxSize, dpr: Math.min(this.dpr, DPR_MAX) };
        transfer = [dem.buffer, water.buffer, cover.buffer, streams.buffer];
        break;
      }
    }
    const bucket = this.renderBucket;
    this.pool
      .run(task, transfer)
      .then((res) => {
        for (const k of cands) k.chunk.busy = false;
        this.stats[res.kind].ms += res.ms;
        this.stats[res.kind].n++;
        this.receive(cands, res, bucket);
      })
      .catch((err) => {
        for (const k of cands) {
          k.chunk.busy = false;
          k.chunk.failed = true;
        }
        this.stats.errors++;
        console.error(`chunk ${c.key} ${kind} failed`, err);
      });
  }

  private alive(c: Chunk): boolean {
    return this.chunks.get(c.key) === c;
  }

  private receive(cands: Candidate[], res: TaskResult, bucket: number): void {
    const c = cands[0].chunk;
    switch (res.kind) {
      case 'pre':
        res.results.forEach((r, i) => {
          const k = cands[i].chunk;
          if (this.alive(k)) k.pre = r;
        });
        break;
      case 'hydro':
        if (this.alive(c)) c.hydro = res.result.core;
        break;
      case 'dem':
        if (!this.alive(c)) return;
        c.dem = res.result.dem;
        c.water = res.result.water;
        c.cover = res.result.cover;
        c.streams = res.result.streams;
        c.region = res.result.region;
        break;
      case 'render':
        if (!this.alive(c) || !c.dem) {
          res.bitmap.close();
          return;
        }
        c.bitmap?.close();
        c.bitmap = res.bitmap;
        c.bitmapBucket = bucket;
        this.onChange();
        break;
    }
  }

  // --- Hydro data plumbing -----------------------------------------------------

  private window(c: Chunk): HydroWindow {
    const w = (2 * WIN_CHUNKS + 1) * NODES;
    const win: HydroWindow = {
      gx: (c.cx - WIN_CHUNKS) * NODES,
      gy: (c.cy - WIN_CHUNKS) * NODES,
      w,
      h: w,
      zPre: new Float32Array(w * w),
      R: new Float32Array(w * w),
    };
    for (let dy = -WIN_CHUNKS; dy <= WIN_CHUNKS; dy++)
      for (let dx = -WIN_CHUNKS; dx <= WIN_CHUNKS; dx++) {
        const p = this.get(c.cx + dx, c.cy + dy)!.pre!;
        const oi = (dx + WIN_CHUNKS) * NODES;
        const oj = (dy + WIN_CHUNKS) * NODES;
        for (let j = 0; j < NODES; j++) {
          const o = (oj + j) * w + oi;
          win.zPre.set(p.zPre.subarray(j * NODES, (j + 1) * NODES), o);
          win.R.set(p.R.subarray(j * NODES, (j + 1) * NODES), o);
        }
      }
    return win;
  }

  /**
   * Hydro data for chunk ± DEM_PAD nodes. Elevation is the bilinear blend of the
   * window solves around each node; lakes blend by majority; rivers (receivers,
   * drainage area) come from the solve of the node's own chunk.
   */
  private demPatch(c: Chunk): DemPatch {
    const W = DEM_PATCH;
    const N = W * W;
    const p: DemPatch = {
      zPre: new Float32Array(N),
      zE: new Float32Array(N),
      A: new Float32Array(N),
      rec: new Int8Array(N),
      lake: new Float32Array(N),
      R: new Float32Array(N),
    };
    const coreIdx = (wc: Chunk, gx: number, gy: number) =>
      (gy - (wc.cy * NODES - CORE_PAD)) * CORE + (gx - (wc.cx * NODES - CORE_PAD));
    const gx0 = c.cx * NODES - DEM_PAD;
    const gy0 = c.cy * NODES - DEM_PAD;
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) {
        const gx = gx0 + i;
        const gy = gy0 + j;
        const o = j * W + i;
        const ocx = Math.floor(gx / NODES);
        const ocy = Math.floor(gy / NODES);
        const own = this.get(ocx, ocy)!;
        const pk = (gy - ocy * NODES) * NODES + (gx - ocx * NODES);
        p.zPre[o] = own.pre!.zPre[pk];
        p.R[o] = own.pre!.R[pk];
        const ok = coreIdx(own, gx, gy);
        p.A[o] = own.hydro!.A[ok];
        p.rec[o] = own.hydro!.rec[ok];
        // Blend the (up to) four solves whose weight is non-zero here.
        let z = 0;
        let lakeW = 0;
        let lakeL = 0;
        const ax = Math.floor((gx - (NODES - 1) / 2) / NODES);
        const ay = Math.floor((gy - (NODES - 1) / 2) / NODES);
        for (let wy = ay; wy <= ay + 1; wy++)
          for (let wx = ax; wx <= ax + 1; wx++) {
            const wgt = blendWeight(wx, gx) * blendWeight(wy, gy);
            if (wgt <= 0) continue;
            const wc = this.get(wx, wy)!;
            const k = coreIdx(wc, gx, gy);
            z += wgt * wc.hydro!.zE[k];
            const L = wc.hydro!.lake[k];
            if (!Number.isNaN(L)) {
              lakeW += wgt;
              lakeL += wgt * L;
            }
          }
        p.zE[o] = z;
        p.lake[o] = lakeW >= 0.5 ? lakeL / lakeW : NaN;
      }
    return p;
  }
}
