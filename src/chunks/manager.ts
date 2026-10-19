import { CHUNK, DPR_MAX, FORGET, GEN_MARGIN, M_PER_CSS_PX } from '../lib/constants';
import { expand, intersects, SeedStore, type Rect } from '../gen/seeds';
import type { WorkerPool } from '../worker/pool';
import type { TaskRequest } from '../worker/protocol';

export interface Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly key: string;
  busy: boolean;
  /** Set after a task throws, so a broken chunk isn't retried forever. */
  failed?: boolean;
  dem?: Float32Array;
  region?: number;
  bitmap?: ImageBitmap;
  bitmapBucket: number;
}

type Candidate = { chunk: Chunk; kind: 'terrain' | 'render'; priority: number };

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

/**
 * Owns chunk state: what exists, what's being generated, what's forgotten.
 *
 * Stages (milestone 1): terrain → render. Later milestones insert data stages
 * with neighbour dependencies between them.
 */
export class ChunkManager {
  readonly chunks = new Map<string, Chunk>();
  readonly seeds = new SeedStore();
  renderBucket = 1;
  dpr = 1;
  readonly stats = { terrainMs: 0, renderMs: 0, terrainN: 0, renderN: 0, errors: 0 };

  private genRect: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private keepBitmapRect: Rect = this.genRect;
  private forgetRect: Rect = this.genRect;
  private focus: [number, number] = [0, 0];

  constructor(
    private readonly pool: WorkerPool,
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

  /**
   * @param actual rectangle currently on screen
   * @param desired rectangle the user is trying to reach
   * @param focus world point to prioritise (desired view centre)
   */
  update(actual: Rect, desired: Rect, focus: [number, number]): void {
    const union = {
      x0: Math.min(actual.x0, desired.x0),
      y0: Math.min(actual.y0, desired.y0),
      x1: Math.max(actual.x1, desired.x1),
      y1: Math.max(actual.y1, desired.y1),
    };
    this.genRect = expand(union, GEN_MARGIN);
    this.keepBitmapRect = expand(union, 2 * CHUNK);
    this.forgetRect = expand(actual, FORGET);
    this.focus = focus;
    this.forget();
    this.schedule();
  }

  private forget(): void {
    for (const [k, c] of this.chunks) {
      const r = chunkRect(c.cx, c.cy);
      if (!intersects(r, this.forgetRect)) {
        c.bitmap?.close();
        this.chunks.delete(k);
      } else if (c.bitmap && !c.busy && !intersects(r, this.keepBitmapRect)) {
        c.bitmap.close();
        c.bitmap = undefined;
      }
    }
    this.seeds.prune(this.forgetRect);
  }

  schedule(): void {
    while (this.pool.idle > 0) {
      const next = this.pick();
      if (!next) return;
      this.dispatch(next);
    }
  }

  private pick(): Candidate | undefined {
    let best: Candidate | undefined;
    const [fx, fy] = this.focus;
    forChunksIn(this.genRect, (cx, cy) => {
      const key = chunkKey(cx, cy);
      let c = this.chunks.get(key);
      if (!c) this.chunks.set(key, (c = { cx, cy, key, busy: false, bitmapBucket: 0 }));
      if (c.busy || c.failed) return;
      let kind: Candidate['kind'];
      let penalty = 0;
      if (!c.dem) kind = 'terrain';
      else if (!c.bitmap) kind = 'render';
      else if (c.bitmapBucket !== this.renderBucket) {
        kind = 'render';
        penalty = 3000; // stale zoom bucket: still drawable, so lower priority
      } else return;
      const d = Math.hypot((cx + 0.5) * CHUNK - fx, (cy + 0.5) * CHUNK - fy) + penalty;
      if (!best || d < best.priority) best = { chunk: c, kind, priority: d };
    });
    return best;
  }

  private dispatch({ chunk: c, kind }: Candidate): void {
    c.busy = true;
    let task: TaskRequest;
    let transfer: Transferable[] = [];
    if (kind === 'terrain') {
      const pad = 16;
      const r = chunkRect(c.cx, c.cy);
      task = { kind, cx: c.cx, cy: c.cy, seeds: this.seeds.payloadFor(expand(r, pad)) };
    } else {
      const dem = c.dem!.slice();
      task = { kind, cx: c.cx, cy: c.cy, dem, pxSize: this.pxSize, dpr: Math.min(this.dpr, DPR_MAX) };
      transfer = [dem.buffer];
    }
    const bucket = this.renderBucket;
    this.pool
      .run(task, transfer)
      .then((res) => {
        c.busy = false;
        const alive = this.chunks.get(c.key) === c;
        if (res.kind === 'terrain') {
          this.stats.terrainMs += res.ms;
          this.stats.terrainN++;
          if (!alive) return;
          c.dem = res.dem;
          c.region = res.region;
        } else {
          this.stats.renderMs += res.ms;
          this.stats.renderN++;
          if (!alive) {
            res.bitmap.close();
            return;
          }
          c.bitmap?.close();
          c.bitmap = res.bitmap;
          c.bitmapBucket = bucket;
          this.onChange();
        }
      })
      .catch((err) => {
        c.busy = false;
        c.failed = true;
        this.stats.errors++;
        console.error(`chunk ${c.key} ${kind} failed`, err);
      });
  }
}
