import { CHUNK, DPR_MAX, FORGET, GEN_MARGIN, M_PER_CSS_PX } from '../lib/constants';
import { DEM_PAD, DEM_PATCH, type DemPatch } from '../gen/dem';
import {
  blendWeight,
  COARSE,
  CORE,
  CORE_PAD,
  NODE,
  NODES,
  WIN_CHUNKS,
  COARSE_REACH,
  LAKE_REACH,
  TILE_STRIDE,
  type HydroCore,
  type HydroWindow,
  type PreResult,
} from '../gen/hydro';
import { latticeSegments } from '../gen/lattice';
import { motorwayEnd, MW_END_REACH, MW_SPILL, type MotorwayPiece } from '../gen/motorway';
import { FIELD_PAD, FIELD_REACH, type Fields } from '../gen/fields';
import { POI_PAD, type PoiPatch } from '../gen/poi';
import { NET_CELL, NET_REACH, ROAD_C, ROAD_PAD, type NetCell, type RoadEdge, type RoadPatch, type SegmentPath } from '../gen/roads';
import { expand, intersects, SeedStore, type Rect } from '../gen/seeds';
import { TOWN, type Site } from '../gen/settle';
import { PLAN_DRAW_PAD, PLAN_EXTENT, PLAN_MARGIN, type PlanInput, type TownPlan } from '../gen/town';
import type { TaskRunner } from '../worker/pool';
import type { TaskKind, TaskRequest, TaskResult } from '../worker/protocol';

export interface Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly key: string;
  busy: boolean;
  /** When its running task was sent (ms), for the progress estimate. */
  since?: number;
  /** Set after a task throws, so a broken chunk isn't retried forever. */
  failed?: boolean;
  /** Uplift surface and region at node resolution. */
  pre?: PreResult;
  /** Core of the window solve centred on this chunk. */
  hydro?: HydroCore;
  /** Fine road segments owned by this chunk (midpoint inside it). */
  roads?: SegmentPath[];
  dem?: Float32Array;
  water?: Float32Array;
  cover?: Int8Array;
  streams?: Float32Array;
  region?: number;
  bitmap?: ImageBitmap;
  bitmapBucket: number;
  /**
   * Its field parcels as last laid out, and what they were laid out from (fieldInputs):
   * given to the next render while those are the same objects (a zoom change redraws
   * the chunk, not its fields).
   */
  fields?: { inputs: unknown[]; layout: Fields };
}

type Candidate = { chunk: Chunk; kind: TaskKind; priority: number };

/** Blended ground may sit this far (m) below a lake's level and still hold it. */
const LAKE_DEFICIT = 1;

const chunkRect = (cx: number, cy: number): Rect => ({
  x0: cx * CHUNK,
  y0: cy * CHUNK,
  x1: (cx + 1) * CHUNK,
  y1: (cy + 1) * CHUNK,
});

export const chunkKey = (cx: number, cy: number) => `${cx},${cy}`;

/** The stage a chunk's next task makes. */
const firstMissing = (c: Chunk) => (!c.pre ? 'pre' : !c.hydro ? 'hydro' : !c.roads ? 'roads' : !c.dem ? 'dem' : 'render');

/** Calls `f` for every chunk coordinate overlapping `r`. */
export function forChunksIn(r: Rect, f: (cx: number, cy: number) => void): void {
  const cx0 = Math.floor(r.x0 / CHUNK);
  const cy0 = Math.floor(r.y0 / CHUNK);
  const cx1 = Math.ceil(r.x1 / CHUNK) - 1;
  const cy1 = Math.ceil(r.y1 / CHUNK) - 1;
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) f(cx, cy);
}

const PRE_BATCH = 8;
/** Coarse tile spacing (m): tile (tx, ty) is centred at ((tx + 1)·TILE_S, (ty + 1)·TILE_S). */
const TILE_S = TILE_STRIDE * COARSE;
/**
 * Coarse tiles whose centres lie this near a net cell's centre (m) are made first, once,
 * and handed to every worker (`tile` tasks): a cell reads ~110–130 tiles out to ~61 km.
 * Any it reads beyond are made where needed, as before; only speed depends on this.
 */
const TILE_REACH = 62000;
const tileKey = (tx: number, ty: number) => (tx + 32768) * 65536 + ty + 32768;
/** The coarse tiles a net cell (and its motorway cell) reads, as made first. */
function tilesOfCell(gx: number, gy: number): [number, number][] {
  const cx = (gx + 0.5) * NET_CELL;
  const cy = (gy + 0.5) * NET_CELL;
  const out: [number, number][] = [];
  for (let ty = Math.floor((cy - TILE_REACH) / TILE_S) - 1; ty <= Math.ceil((cy + TILE_REACH) / TILE_S); ty++)
    for (let tx = Math.floor((cx - TILE_REACH) / TILE_S) - 1; tx <= Math.ceil((cx + TILE_REACH) / TILE_S); tx++)
      if (Math.hypot((tx + 1) * TILE_S - cx, (ty + 1) * TILE_S - cy) <= TILE_REACH) out.push([tx, ty]);
  return out;
}
/**
 * Net cells this far around a chunk (m) own edges it needs: those it draws (owned by
 * the cell holding their midpoint; lattice edges are short) and their neighbours,
 * for smooth joins and clearance.
 */
const EDGE_REACH = 1000;
/** Sites within this distance matter to a chunk's land cover and placeholders (m). */
const SITE_REACH = 1600;

/** A net cell's lattice (and sites), or the motorway pieces of its motorway cells. */
interface CellState<T> {
  busy: boolean;
  /** When its task was sent (ms), for the progress estimate. */
  since?: number;
  failed?: boolean;
  data?: T;
}
type NetState = CellState<NetCell>;
type MwState = CellState<MotorwayPiece[]>;

/** The chunks overlapping `r`, as one rectangle: what they need reaches from their edges, not from `r`'s. */
const wholeChunks = (r: Rect): Rect => ({
  x0: Math.floor(r.x0 / CHUNK) * CHUNK,
  y0: Math.floor(r.y0 / CHUNK) * CHUNK,
  x1: Math.ceil(r.x1 / CHUNK) * CHUNK,
  y1: Math.ceil(r.y1 / CHUNK) * CHUNK,
});

const sameItems = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Smallest rectangle holding every one of `rs`. */
const bounds = (rs: Rect[]): Rect =>
  rs.reduce((a, r) => ({ x0: Math.min(a.x0, r.x0), y0: Math.min(a.y0, r.y0), x1: Math.max(a.x1, r.x1), y1: Math.max(a.y1, r.y1) }));

interface PlanState {
  site: Site;
  busy: boolean;
  failed?: boolean;
  data?: TownPlan;
}

const point = (s: Site): Rect => ({ x0: s.x, y0: s.y, x1: s.x, y1: s.y });

/** Bounding boxes of motorway pieces, computed once each. */
const pieceBoxes = new WeakMap<MotorwayPiece, Rect>();
function pieceBox(p: MotorwayPiece): Rect {
  let b = pieceBoxes.get(p);
  if (!b) {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let k = 0; k < p.xy.length; k += 2) {
      b.x0 = Math.min(b.x0, p.xy[k]);
      b.x1 = Math.max(b.x1, p.xy[k]);
      b.y0 = Math.min(b.y0, p.xy[k + 1]);
      b.y1 = Math.max(b.y1, p.xy[k + 1]);
    }
    pieceBoxes.set(p, b);
  }
  return b;
}
/**
 * Motorways passing this near a chunk (m) are given to it: it draws those within 64 m
 * (they are wide), and the road's height round its points is the ground averaged along
 * the motorway over ±500 m (render/motorway.ts), so it needs them that far beyond.
 */
const MOTORWAY_DRAW = 700;
/**
 * …and this near, its roads keep clear of them: every run a chunk's edges belong to
 * (up to three edges out) and the room around it.
 */
const MOTORWAY_ROADS = 2000;
/** Where a settlement's street plan may draw. */
const planDrawRect = (s: Site) => expand(point(s), PLAN_EXTENT[s.rank] + PLAN_DRAW_PAD);
/** Chunks whose roads a plan reads: its extent and margin, plus one lattice edge (edges are owned by their midpoint's chunk). */
const planRoadsRect = (s: Site) => expand(point(s), PLAN_EXTENT[s.rank] + PLAN_MARGIN + PLAN_EDGE);
const PLAN_EDGE = 200;
/** Furthest a plan's drawing reaches from its site. */
const PLAN_REACH = PLAN_EXTENT[TOWN] + PLAN_DRAW_PAD;
/** Coarse reach of a window solve: the coarse surface around the window and its lake grid. */
const COARSE_RADIUS_M = COARSE_REACH + (WIN_CHUNKS + 1) * CHUNK + LAKE_REACH + 512;

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
  readonly seeds: SeedStore;
  renderBucket = 1;
  dpr = 1;
  readonly stats: Record<TaskKind, { ms: number; n: number }> & { errors: number } = {
    pre: { ms: 0, n: 0 },
    hydro: { ms: 0, n: 0 },
    net: { ms: 0, n: 0 },
    mw: { ms: 0, n: 0 },
    tile: { ms: 0, n: 0 },
    roads: { ms: 0, n: 0 },
    plan: { ms: 0, n: 0 },
    dem: { ms: 0, n: 0 },
    render: { ms: 0, n: 0 },
    errors: 0,
  };

  private genRect: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private roadsRect: Rect = this.genRect;
  private hydroRect: Rect = this.genRect;
  private netRect: Rect = this.genRect;
  private mwRect: Rect = this.genRect;
  /** Chunks whose roads the needed plans read (beyond the roads rectangle too), as of the last schedule. */
  private planRoads: Rect[] = [];
  readonly nets = new Map<string, NetState>();
  /** Motorway pieces by net cell: cheap, but needed much further out than the lattice. */
  readonly mws = new Map<string, MwState>();
  /** Coarse tiles made and handed to every worker, by tileKey (see TILE_REACH). */
  readonly tiles = new Map<number, CellState<true>>();
  /** Plans of settlements (street plans, farmsteads), by site id. */
  readonly plans = new Map<string, PlanState>();
  private lastPrune: Rect | undefined;
  private preRect: Rect = this.genRect;
  private keepBitmapRect: Rect = this.genRect;
  private forgetRect: Rect = this.genRect;
  private focus: [number, number] = [0, 0];

  constructor(
    private readonly pool: TaskRunner,
    private readonly onChange: () => void,
    /** Debugging: a world seed makes every place reproducible (see SeedStore). */
    worldSeed?: number,
  ) {
    this.seeds = new SeedStore(worldSeed);
  }

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
  /**
   * How far the land the view needs is made (0..1): the tasks its rectangles call for,
   * each weighted by its kind's mean time so far (or a typical one), finished ones in
   * full and running ones by the time they have taken (at most 90 %), so the estimate
   * moves on through a long net cell too. Street plans are left out (they are quick).
   */
  progress(): number {
    const now = performance.now();
    const mean = (k: TaskKind, typical: number) => (this.stats[k].n >= 2 ? this.stats[k].ms / this.stats[k].n : typical);
    const w = {
      pre: mean('pre', 15) / PRE_BATCH,
      hydro: mean('hydro', 70),
      roads: mean('roads', 3),
      dem: mean('dem', 40),
      render: mean('render', 25),
      net: mean('net', 5000),
      mw: mean('mw', 20),
      tile: mean('tile', 25),
    };
    let done = 0;
    let total = 0;
    const running = (since: number | undefined, weight: number) => (since === undefined ? 0 : Math.min(0.9 * weight, now - since));
    const stage = (r: Rect, has: (c: Chunk) => boolean, weight: number, kind: 'pre' | 'hydro' | 'roads' | 'dem' | 'render') =>
      forChunksIn(r, (cx, cy) => {
        const c = this.get(cx, cy);
        total += weight;
        if (c && has(c)) done += weight;
        // A busy chunk is working on its first missing stage.
        else if (c?.busy && firstMissing(c) === kind) done += running(c.since, weight);
      });
    stage(this.preRect, (c) => !!c.pre, w.pre, 'pre');
    stage(this.hydroRect, (c) => !!c.hydro, w.hydro, 'hydro');
    stage(this.roadsRect, (c) => !!c.roads, w.roads, 'roads');
    stage(this.genRect, (c) => !!c.dem, w.dem, 'dem');
    stage(this.genRect, (c) => !!c.bitmap, w.render, 'render');
    const cells = (rect: Rect, map: Map<string, CellState<unknown>>, weight: number) => {
      for (const [gx, gy] of this.netCells(rect)) {
        const n = map.get(`${gx},${gy}`);
        total += weight;
        if (n?.data) done += weight;
        else if (n?.busy) done += running(n.since, weight);
      }
    };
    cells(this.netRect, this.nets, w.net);
    cells(this.mwRect, this.mws, w.mw);
    for (const k of this.tilesWanted().keys()) {
      const t = this.tiles.get(k);
      total += w.tile;
      if (t?.data || t?.failed) done += w.tile;
      else if (t?.busy) done += running(t.since, w.tile);
    }
    return total > 0 ? done / total : 1;
  }

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
    this.roadsRect = expand(this.genRect, CHUNK);
    this.hydroRect = expand(this.roadsRect, CHUNK);
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
        this.dropPlans(r);
        // Neighbours' surfaces blended this chunk's solve: recompute them later.
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const n = this.get(c.cx + dx, c.cy + dy);
            if (n && !n.busy) {
              if (n.dem) this.dropSurface(n);
              n.roads = undefined; // its segment snaps used this chunk's nodes
              this.dropPlans(chunkRect(n.cx, n.cy));
            }
          }
      } else if (c.bitmap && !c.busy && !intersects(r, this.keepBitmapRect)) {
        c.bitmap.close();
        c.bitmap = undefined;
      }
    }
    for (const [k, pl] of this.plans) if (!pl.busy && !intersects(planDrawRect(pl.site), this.forgetRect)) this.plans.delete(k);
    const netKeep = expand(this.forgetRect, 20000);
    for (const cells of [this.nets, this.mws] as Map<string, CellState<unknown>>[])
      for (const [k, n] of cells) {
        const [gx, gy] = k.split(',').map(Number);
        const r = { x0: gx * NET_CELL, y0: gy * NET_CELL, x1: (gx + 1) * NET_CELL, y1: (gy + 1) * NET_CELL };
        if (!n.busy && !intersects(r, netKeep)) cells.delete(k);
      }
    const coarseKeep = expand(netKeep, TILE_REACH);
    for (const [k, t] of this.tiles) {
      const tx = Math.floor(k / 65536) - 32768;
      const ty = (k % 65536) - 32768;
      if (!t.busy && !intersects({ x0: tx * TILE_S, y0: ty * TILE_S, x1: (tx + 2) * TILE_S, y1: (ty + 2) * TILE_S }, coarseKeep)) this.tiles.delete(k);
    }
    // Pruning walks every seed; only bother once the view has moved a bit.
    const lp = this.lastPrune;
    if (!lp || Math.abs(lp.x0 - this.forgetRect.x0) + Math.abs(lp.y0 - this.forgetRect.y0) > 256 || Math.abs(lp.x1 - lp.x0 - (this.forgetRect.x1 - this.forgetRect.x0)) > 256) {
      this.seeds.prune(this.forgetRect);
      this.lastPrune = this.forgetRect;
    }
  }

  /** Plans reading roads in `r` are out of date: drop them, and the bitmaps that drew them. */
  private dropPlans(r: Rect): void {
    for (const [k, pl] of this.plans) {
      if (!intersects(planRoadsRect(pl.site), r)) continue;
      this.plans.delete(k);
      forChunksIn(planDrawRect(pl.site), (cx, cy) => {
        const c = this.get(cx, cy);
        if (c?.bitmap && !c.busy) {
          c.bitmap.close();
          c.bitmap = undefined;
        }
      });
    }
  }

  private dropSurface(c: Chunk): void {
    c.dem = c.water = c.cover = c.streams = undefined;
    c.bitmap?.close();
    c.bitmap = undefined;
  }

  // --- Scheduling ------------------------------------------------------------

  schedule(): void {
    this.planRoads = this.neededPlans().map(planRoadsRect);
    // Every net cell and motorway cell something waits on (otherwise it waits forever):
    // lattice edges within EDGE_REACH of every chunk getting roads (plans pull some beyond
    // the roads rectangle) and the sites a drawn chunk's surface and plans read; motorway
    // pieces round every chunk getting roads, and those a drawn chunk draws.
    const roads = [this.roadsRect, ...this.planRoads].map(wholeChunks);
    const drawn = wholeChunks(this.genRect);
    this.netRect = bounds([...roads.map((r) => expand(r, EDGE_REACH)), expand(drawn, Math.max(SITE_REACH, PLAN_REACH))]);
    this.mwRect = bounds([...roads.map((r) => expand(r, MW_SPILL + MOTORWAY_ROADS)), expand(drawn, MW_SPILL + MW_END_REACH)]);
    while (this.pool.idle > 0) {
      if (this.schedulePreFirst()) continue;
      if (this.scheduleTile()) continue;
      if (this.scheduleCell('mw', this.mws, this.mwRect)) continue;
      if (this.scheduleCell('net', this.nets, this.netRect)) continue;
      if (this.schedulePlan()) continue;
      const next = this.pick();
      if (!next.length) return;
      this.dispatch(next);
    }
  }

  // --- Net cells (settlements + road corridors) -------------------------------

  private netCells(r: Rect): [number, number][] {
    const out: [number, number][] = [];
    for (let gy = Math.floor(r.y0 / NET_CELL); gy <= Math.floor(r.y1 / NET_CELL); gy++)
      for (let gx = Math.floor(r.x0 / NET_CELL); gx <= Math.floor(r.x1 / NET_CELL); gx++) out.push([gx, gy]);
    return out;
  }

  private netsReady(r: Rect): boolean {
    return this.netCells(r).every(([gx, gy]) => this.nets.get(`${gx},${gy}`)?.data);
  }

  private mwsReady(r: Rect): boolean {
    return this.netCells(r).every(([gx, gy]) => this.mws.get(`${gx},${gy}`)?.data);
  }

  /**
   * Pre data for the chunks to draw comes first, nearest first: it is cheap (~13 ms a
   * batch), and the loading sketches (view/preview.ts) are made from it. Net cells would
   * otherwise take every worker for the first seconds with nothing to show.
   */
  private schedulePreFirst(): boolean {
    const [fx, fy] = this.focus;
    const cands: Candidate[] = [];
    forChunksIn(this.genRect, (cx, cy) => {
      const c = this.ensure(cx, cy);
      if (c.pre || c.busy || c.failed) return;
      cands.push({ chunk: c, kind: 'pre', priority: Math.hypot((cx + 0.5) * CHUNK - fx, (cy + 0.5) * CHUNK - fy) });
    });
    if (!cands.length) return false;
    cands.sort((a, b) => a.priority - b.priority);
    this.dispatch(cands.slice(0, PRE_BATCH));
    return true;
  }

  private tilesReady(gx: number, gy: number): boolean {
    return tilesOfCell(gx, gy).every(([tx, ty]) => {
      const t = this.tiles.get(tileKey(tx, ty));
      return t?.data || t?.failed;
    });
  }

  /** The coarse tiles the net and motorway cells still to make read (see TILE_REACH). */
  private tilesWanted(): Map<number, [number, number]> {
    const out = new Map<number, [number, number]>();
    for (const [rect, cells] of [
      [this.netRect, this.nets],
      [this.mwRect, this.mws],
    ] as [Rect, Map<string, CellState<unknown>>][])
      for (const [gx, gy] of this.netCells(rect)) {
        if (cells.get(`${gx},${gy}`)?.data) continue;
        for (const [tx, ty] of tilesOfCell(gx, gy)) out.set(tileKey(tx, ty), [tx, ty]);
      }
    return out;
  }

  /** Dispatches the nearest wanted coarse tile not made yet, if any; the result goes to every worker. */
  private scheduleTile(): boolean {
    const [fx, fy] = this.focus;
    let best: [number, number] | undefined;
    let bestD = Infinity;
    for (const [k, [tx, ty]] of this.tilesWanted()) {
      if (this.tiles.has(k)) continue;
      const d = Math.hypot((tx + 1) * TILE_S - fx, (ty + 1) * TILE_S - fy);
      if (d < bestD) {
        bestD = d;
        best = [tx, ty];
      }
    }
    if (!best) return false;
    const [tx, ty] = best;
    const state: CellState<true> = { busy: true, since: performance.now() };
    this.tiles.set(tileKey(tx, ty), state);
    const c = { x: (tx + 1) * TILE_S, y: (ty + 1) * TILE_S };
    this.pool
      .run({
        kind: 'tile',
        tx,
        ty,
        // The tile spans two strides from (tx, ty)·TILE_S; its terrain reads coarse seeds round it.
        seeds: this.seeds.payloadFor({ x0: c.x, y0: c.y, x1: c.x + 16, y1: c.y + 16 }, expand({ x0: tx * TILE_S, y0: ty * TILE_S, x1: (tx + 2) * TILE_S, y1: (ty + 2) * TILE_S }, 2000)),
      })
      .then((res) => {
        state.busy = false;
        this.stats.tile.ms += res.ms;
        this.stats.tile.n++;
        if (res.kind !== 'tile') return;
        state.data = true;
        this.pool.shareTiles?.({ tiles: [{ key: res.key, tile: res.tile }] });
      })
      .catch((err) => {
        state.busy = false;
        state.failed = true; // its cells make it themselves
        this.stats.errors++;
        console.error(`coarse tile ${tx},${ty} failed`, err);
      });
    return true;
  }

  /** Dispatches the nearest missing cell of a kind in `rect`, if any. */
  private scheduleCell<T>(kind: 'net' | 'mw', cells: Map<string, CellState<T>>, rect: Rect): boolean {
    const [fx, fy] = this.focus;
    let best: [number, number] | undefined;
    let bestD = Infinity;
    for (const [gx, gy] of this.netCells(rect)) {
      const n = cells.get(`${gx},${gy}`);
      if (n && (n.busy || n.data || n.failed)) continue;
      // Not before its coarse tiles are made: each worker would make them all again.
      if (!this.tilesReady(gx, gy)) continue;
      const d = Math.hypot((gx + 0.5) * NET_CELL - fx, (gy + 0.5) * NET_CELL - fy);
      if (d < bestD) {
        bestD = d;
        best = [gx, gy];
      }
    }
    if (!best) return false;
    const [gx, gy] = best;
    const key = `${gx},${gy}`;
    const state: CellState<T> = { busy: true, since: performance.now() };
    cells.set(key, state);
    const cx = (gx + 0.5) * NET_CELL;
    const cy = (gy + 0.5) * NET_CELL;
    this.pool
      .run({
        kind,
        gx,
        gy,
        seeds: this.seeds.payloadFor(
          { x0: cx, y0: cy, x1: cx + 16, y1: cy + 16 },
          expand({ x0: gx * NET_CELL, y0: gy * NET_CELL, x1: (gx + 1) * NET_CELL, y1: (gy + 1) * NET_CELL }, NET_REACH),
        ),
      })
      .then((res) => {
        state.busy = false;
        this.stats[kind].ms += res.ms;
        this.stats[kind].n++;
        if ((res.kind === 'net' || res.kind === 'mw') && cells.get(key) === state) state.data = res.result as T;
      })
      .catch((err) => {
        state.busy = false;
        state.failed = true;
        this.stats.errors++;
        console.error(`${kind === 'net' ? 'net' : 'motorway'} cell ${key} failed`, err);
      });
    return true;
  }

  /**
   * Centre lines of the motorways a chunk draws: those passing within MOTORWAY_DRAW, a
   * piece where the motorway ends run on to its terminus (motorwayEnd) among `roads`
   * (the chunk's and its neighbours', which hold every terminus near enough to matter).
   */
  private motorwaysToDraw(c: Chunk, roads: SegmentPath[]): Float64Array[] {
    const r = chunkRect(c.cx, c.cy);
    const q = expand(r, MOTORWAY_DRAW);
    const out: Float64Array[] = [];
    const lanes: SegmentPath[] = [];
    for (const [gx, gy] of this.netCells(expand(r, MW_SPILL + MW_END_REACH)))
      for (const p of this.mws.get(`${gx},${gy}`)?.data ?? []) {
        if (!p.endA && !p.endB) {
          if (intersects(pieceBox(p), q)) out.push(p.xy);
          continue;
        }
        const end = motorwayEnd(p, roads);
        const near = (xy: ArrayLike<number>) => {
          for (let k = 0; k < xy.length; k += 2) if (xy[k] >= q.x0 && xy[k] <= q.x1 && xy[k + 1] >= q.y0 && xy[k + 1] <= q.y1) return true;
          return false;
        };
        if (near(end.xy)) out.push(end.xy);
        // Its lanes into the roundabout: drawn as ramps, with the roads.
        end.lanes.forEach((xy, i) => near(xy) && lanes.push({ key: `mwlane:${p.key}:${i}`, cls: ROAD_C, xy: Float32Array.from(xy), ramp: true }));
      }
    roads.push(...lanes);
    return out;
  }

  /** Centre lines of the motorway pieces passing within `m` of `r`. */
  private motorwaysNear(r: Rect, m: number): Float64Array[] {
    const out: Float64Array[] = [];
    const q = expand(r, m);
    for (const [gx, gy] of this.netCells(expand(r, MW_SPILL)))
      for (const p of this.mws.get(`${gx},${gy}`)?.data ?? []) if (intersects(pieceBox(p), q)) out.push(p.xy);
    return out;
  }

  private edgesNear(r: Rect): RoadEdge[] {
    const out: RoadEdge[] = [];
    for (const [gx, gy] of this.netCells(expand(r, EDGE_REACH))) out.push(...(this.nets.get(`${gx},${gy}`)?.data?.edges ?? []));
    return out;
  }

  /** Settlements (farms included) whose plans may draw into `r` (as far as the net cells are known). */
  private planSites(r: Rect): Site[] {
    return this.sitesNear(expand(r, PLAN_REACH)).filter((s) => intersects(planDrawRect(s), r));
  }

  /** Plans that drawing the generation rectangle needs. */
  private neededPlans(): Site[] {
    return this.planSites(this.genRect);
  }

  /** Dispatches a needed plan whose inputs all exist, if any. */
  private schedulePlan(): boolean {
    for (const site of this.neededPlans()) {
      const pl = this.plans.get(site.id);
      if (pl) continue;
      const input = this.planInput(site);
      if (!input) continue;
      const state: PlanState = { site, busy: true };
      this.plans.set(site.id, state);
      this.pool
        .run({ kind: 'plan', input })
        .then((res) => {
          state.busy = false;
          this.stats.plan.ms += res.ms;
          this.stats.plan.n++;
          if (res.kind === 'plan' && this.plans.get(site.id) === state) state.data = res.result;
        })
        .catch((err) => {
          state.busy = false;
          state.failed = true;
          this.stats.errors++;
          console.error(`plan ${site.id} failed`, err);
        });
      return true;
    }
    return false;
  }

  /** Plans drawn by a chunk: done (data) or given up on (failed); undefined while any is pending. */
  private plansFor(c: Chunk): TownPlan[] | undefined {
    const r = chunkRect(c.cx, c.cy);
    if (!this.netsReady(expand(r, PLAN_REACH))) return undefined;
    const out: TownPlan[] = [];
    for (const s of this.planSites(r)) {
      const pl = this.plans.get(s.id);
      if (!pl || pl.busy) return undefined;
      if (pl.data) out.push(pl.data);
    }
    return out;
  }

  private sitesNear(r: Rect): Site[] {
    const out: Site[] = [];
    for (const [gx, gy] of this.netCells(r))
      for (const s of this.nets.get(`${gx},${gy}`)?.data?.sites ?? [])
        if (s.x >= r.x0 && s.x < r.x1 && s.y >= r.y0 && s.y < r.y1) out.push(s);
    return out;
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

  private ring(c: Chunk, f: (n: Chunk | undefined) => boolean): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!f(this.get(c.cx + dx, c.cy + dy))) return false;
    return true;
  }

  private roadsReady(c: Chunk): boolean {
    const r = chunkRect(c.cx, c.cy);
    return this.ring(c, (n) => !!n?.hydro && !!n.pre) && this.netsReady(expand(r, EDGE_REACH)) && this.mwsReady(expand(r, MW_SPILL + MOTORWAY_ROADS));
  }

  private demReady(c: Chunk): boolean {
    return this.ring(c, (n) => !!n?.hydro) && this.netsReady(expand(chunkRect(c.cx, c.cy), SITE_REACH));
  }

  private renderReady(c: Chunk): boolean {
    // (Motorway pieces as far as motorwaysToDraw reads them.)
    return this.ring(c, (n) => !!n?.roads) && !!this.plansFor(c) && this.mwsReady(expand(chunkRect(c.cx, c.cy), MW_SPILL + MW_END_REACH));
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
    // Plans read roads around their settlements, a little beyond the roads rectangle:
    // those roads, the solves under them and the pre data those need are made too.
    const planRoads = this.planRoads;
    const planHydro = planRoads.map((r) => expand(r, CHUNK));
    let preBox = this.preRect;
    for (const r of planHydro) {
      const q = expand(r, WIN_CHUNKS * CHUNK);
      preBox = { x0: Math.min(preBox.x0, q.x0), y0: Math.min(preBox.y0, q.y0), x1: Math.max(preBox.x1, q.x1), y1: Math.max(preBox.y1, q.y1) };
    }
    forChunksIn(preBox, (cx, cy) => {
      const c = this.ensure(cx, cy);
      if (c.busy || c.failed) return;
      const r = chunkRect(cx, cy);
      const d = Math.hypot((cx + 0.5) * CHUNK - fx, (cy + 0.5) * CHUNK - fy);
      if (!c.pre) {
        pres.push({ chunk: c, kind: 'pre', priority: d });
        return;
      }
      if (!c.hydro) {
        if (intersects(r, this.hydroRect) || planHydro.some((q) => intersects(r, q)))
          consider({ chunk: c, kind: 'hydro', priority: d }, () => this.hydroReady(c));
        return;
      }
      if (!c.roads) {
        if (intersects(r, this.roadsRect) || planRoads.some((q) => intersects(r, q)))
          consider({ chunk: c, kind: 'roads', priority: d }, () => this.roadsReady(c));
        return;
      }
      if (!intersects(r, this.genRect)) return;
      if (!c.dem) {
        consider({ chunk: c, kind: 'dem', priority: d }, () => this.demReady(c));
        return;
      }
      if (!c.bitmap) consider({ chunk: c, kind: 'render', priority: d }, () => this.renderReady(c));
      else if (c.bitmapBucket !== this.renderBucket)
        consider({ chunk: c, kind: 'render', priority: d + 3000 }, () => this.renderReady(c)); // stale zoom: still drawable
    });
    pres.sort((a, b) => a.priority - b.priority);
    // Pre tasks are cheap and everything waits on them: prefer a batch when one is closer.
    if (pres.length && (!best || pres[0].priority <= best.priority + CHUNK)) return pres.slice(0, PRE_BATCH);
    return best ? [best] : [];
  }

  private dispatch(cands: Candidate[]): void {
    const kind = cands[0].kind;
    const now = performance.now();
    for (const c of cands) {
      c.chunk.busy = true;
      c.chunk.since = now;
    }
    const c = cands[0].chunk;
    let task: TaskRequest;
    let transfer: Transferable[] = [];
    let fieldInputs: unknown[] | undefined;
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
        task = {
          kind,
          chunks: cands.map((k) => [k.chunk.cx, k.chunk.cy]),
          // zPre starts from the coarse field, which reads tiles far around.
          seeds: this.seeds.payloadFor(expand(r, 16), expand(r, COARSE_RADIUS_M)),
        };
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
      case 'net':
      case 'mw':
      case 'tile':
        throw new Error('net and motorway cells are scheduled by scheduleCell');
      case 'plan':
        throw new Error('plans are scheduled by schedulePlan');
      case 'roads':
        const motorways = this.motorwaysNear(chunkRect(c.cx, c.cy), MOTORWAY_ROADS);
        task = {
          kind,
          cx: c.cx,
          cy: c.cy,
          segments: latticeSegments(this.edgesNear(chunkRect(c.cx, c.cy)), c.cx, c.cy, motorways),
          patch: this.roadPatch(c),
          motorways,
        };
        break;
      case 'dem':
        task = {
          kind,
          cx: c.cx,
          cy: c.cy,
          patch: this.demPatch(c),
          sites: this.sitesNear(expand(chunkRect(c.cx, c.cy), SITE_REACH)),
          seeds: this.seeds.payloadFor(expand(chunkRect(c.cx, c.cy), 16)),
        };
        break;
      case 'render': {
        const dem = c.dem!.slice();
        const water = c.water!.slice();
        const cover = c.cover!.slice();
        const streams = c.streams!.slice();
        const roads: SegmentPath[] = [];
        this.ring(c, (n) => (roads.push(...n!.roads!), true));
        const poi = this.poiPatch(c);
        // (Adds the lanes where a motorway runs into a roundabout to the roads.)
        const motorways = this.motorwaysToDraw(c, roads);
        const plans = this.plansFor(c)!;
        fieldInputs = this.fieldInputs(c, plans);
        const kept = c.fields && sameItems(c.fields.inputs, fieldInputs) ? c.fields.layout : undefined;
        task = {
          kind,
          cx: c.cx,
          cy: c.cy,
          dem,
          water,
          cover,
          streams,
          roads,
          motorways,
          plans,
          poi,
          edges: this.fieldEdges(c),
          fields: kept,
          pxSize: this.pxSize,
          dpr: Math.min(this.dpr, DPR_MAX),
        };
        transfer = [dem.buffer, water.buffer, cover.buffer, streams.buffer];
        if (poi) transfer.push(poi.zE.buffer, poi.A.buffer, poi.lake.buffer, poi.rec.buffer, poi.R.buffer);
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
        this.receive(cands, res, bucket, fieldInputs);
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

  private receive(cands: Candidate[], res: TaskResult, bucket: number, fieldInputs?: unknown[]): void {
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
      case 'roads':
        if (this.alive(c)) c.roads = res.result;
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
        if (res.fields && fieldInputs) c.fields = { inputs: fieldInputs, layout: res.fields };
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
   * Fine node data for routing roads around a chunk. Each node comes from the solve
   * of its own chunk (no blending), so the dependency stays within ±1 chunk while
   * every chunk still sees identical values for shared nodes.
   */
  private roadPatch(c: Chunk): RoadPatch {
    const w = NODES + 2 * ROAD_PAD;
    return this.nodePatch(c.cx * NODES - ROAD_PAD, c.cy * NODES - ROAD_PAD, w, w)!;
  }

  /** Fine node data (each node from its own chunk's solve) for a block of nodes, if every solve exists. */
  private nodePatch(gx0: number, gy0: number, w: number, h: number): RoadPatch | undefined {
    const p: RoadPatch = {
      gx: gx0,
      gy: gy0,
      w,
      h,
      zE: new Float32Array(w * h),
      A: new Float32Array(w * h),
      lake: new Float32Array(w * h),
    };
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const gx = p.gx + i;
        const gy = p.gy + j;
        const own = this.get(Math.floor(gx / NODES), Math.floor(gy / NODES));
        if (!own?.hydro) return undefined;
        const k = (gy - (own.cy * NODES - CORE_PAD)) * CORE + (gx - (own.cx * NODES - CORE_PAD));
        const o = j * w + i;
        p.zE[o] = own.hydro.zE[k];
        p.A[o] = own.hydro.A[k];
        p.lake[o] = own.hydro.lake[k];
      }
    return p;
  }

  /**
   * What a chunk's field parcels are laid out from, as the objects holding it: its
   * surface, the roads drawn round it, the plans drawing into it, the net and motorway
   * cells it reads, and the solves under its fine nodes. Data is only ever replaced,
   * never changed in place, so the same objects mean the same layout.
   */
  private fieldInputs(c: Chunk, plans: TownPlan[]): unknown[] {
    const out: unknown[] = [c.dem, ...plans];
    this.ring(c, (n) => (out.push(n?.roads), true));
    const r = chunkRect(c.cx, c.cy);
    for (const [gx, gy] of this.netCells(expand(r, EDGE_REACH))) out.push(this.nets.get(`${gx},${gy}`)?.data);
    for (const [gx, gy] of this.netCells(expand(r, MW_SPILL + MW_END_REACH))) out.push(this.mws.get(`${gx},${gy}`)?.data);
    const pad = Math.ceil(Math.max(POI_PAD, FIELD_PAD) / NODES);
    for (let dy = -pad; dy <= pad; dy++)
      for (let dx = -pad; dx <= pad; dx++) {
        const n = this.get(c.cx + dx, c.cy + dy);
        out.push(n?.hydro, n?.pre);
      }
    return out;
  }

  /** Lattice edges carrying ways within FIELD_REACH of a chunk (its field parcels' blocks), as their two vertices. */
  private fieldEdges(c: Chunk): number[][] {
    const r = expand(chunkRect(c.cx, c.cy), FIELD_REACH);
    const inR = (x: number, y: number) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
    return this.edgesNear(chunkRect(c.cx, c.cy))
      .filter((e) => inR(e.route[0], e.route[1]) || inR(e.route[2], e.route[3]))
      .map((e) => e.route);
  }

  /**
   * Fine nodes round a chunk (± POI_PAD, each from its own chunk's solve) for its
   * points of interest, with receivers and region as the DEM's streams read them.
   * Undefined if a solve is missing (the chunks within two of it normally have theirs:
   * their neighbours' roads needed them).
   */
  private poiPatch(c: Chunk): PoiPatch | undefined {
    // (Field parcels read it too, a little further out.)
    const pad = Math.max(POI_PAD, FIELD_PAD);
    const w = NODES + 2 * pad;
    const base = this.nodePatch(c.cx * NODES - pad, c.cy * NODES - pad, w, w);
    if (!base) return undefined;
    const p: PoiPatch = { ...base, rec: new Int8Array(w * w), R: new Float32Array(w * w) };
    for (let j = 0; j < w; j++)
      for (let i = 0; i < w; i++) {
        const gx = p.gx + i;
        const gy = p.gy + j;
        const own = this.get(Math.floor(gx / NODES), Math.floor(gy / NODES))!;
        if (!own.pre) return undefined;
        p.rec[j * w + i] = own.hydro!.rec[(gy - (own.cy * NODES - CORE_PAD)) * CORE + (gx - (own.cx * NODES - CORE_PAD))];
        p.R[j * w + i] = own.pre.R[(gy - own.cy * NODES) * NODES + (gx - own.cx * NODES)];
      }
    return p;
  }

  /**
   * What a settlement's street plan reads: the drawn roads and the fine nodes within
   * its extent (plus margin). Undefined until all of it exists.
   */
  planInput(site: Site): PlanInput | undefined {
    const r = expand({ x0: site.x, y0: site.y, x1: site.x, y1: site.y }, PLAN_EXTENT[site.rank] + PLAN_MARGIN);
    const roads: SegmentPath[] = [];
    let ok = true;
    forChunksIn(planRoadsRect(site), (cx, cy) => {
      const c = this.get(cx, cy);
      if (!c?.roads) ok = false;
      else roads.push(...c.roads);
    });
    if (!ok) return undefined;
    const gx0 = Math.floor(r.x0 / NODE);
    const gy0 = Math.floor(r.y0 / NODE);
    const patch = this.nodePatch(gx0, gy0, Math.ceil(r.x1 / NODE) - gx0 + 1, Math.ceil(r.y1 / NODE) - gy0 + 1);
    // Interchange ramps are part of the motorway to a plan: kept clear of, not joined.
    const ramps = roads.filter((q) => q.ramp).map((q) => Float64Array.from(q.xy));
    return patch && { site, roads: roads.filter((q) => !q.ramp), patch, motorways: [...this.motorwaysNear(r, 0), ...ramps] };
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
      off: new Float32Array(N),
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
        p.off[o] = own.pre!.off[pk];
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
        p.lake[o] = NaN;
        if (lakeW < 0.5) continue;
        // Solves without the lake here may have carved the ground well below its level.
        // The blended ground then can't hold the water: end the lake where it rises
        // above the blend instead of walling it in at the majority line.
        const level = lakeL / lakeW;
        let deficit = 0;
        for (let wy = ay; wy <= ay + 1; wy++)
          for (let wx = ax; wx <= ax + 1; wx++) {
            const wgt = blendWeight(wx, gx) * blendWeight(wy, gy);
            if (wgt <= 0) continue;
            const wc = this.get(wx, wy)!;
            const k = coreIdx(wc, gx, gy);
            if (Number.isNaN(wc.hydro!.lake[k])) deficit += wgt * Math.max(0, level - wc.hydro!.zE[k]);
          }
        if (deficit <= LAKE_DEFICIT) p.lake[o] = level;
      }
    return p;
  }
}
