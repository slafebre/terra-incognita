import { COARSE, type CoarseField, coarseBasins, DX, DY, LAKE_REACH, LAKE_SHORE_DROP, TILE_STRIDE } from './hydro';

/**
 * Lakes of closed coarse basins, as the network and settlements see them: the
 * window solves' rule for coarse lakes (hydro.ts) on the coarse surface alone. A
 * place is lake where a lake cell at or next to its nearest 128 m cell has a level
 * clearly above the coarse surface there. (The solves also require the level to be
 * above the node's starting surface, whose fine detail the network can't see.)
 *
 * Basins are found per fixed world tile of TILE m (coarseBasins reaching LAKE_REACH
 * beyond it), so a test at (x, y) reads the coarse surface up to TILE + LAKE_REACH
 * away (NET_REACH allows for it). They are a pure function of the coarse surface for every lake that
 * touches the tile, so every tile, cell and worker agrees.
 */
export const LAKE_TILE = 8192;
const TILE = LAKE_TILE;
/** Cells per tile edge. */
const TC = TILE / COARSE;
/** Lake levels kept per tile: its cells plus one around (for the neighbour rule). */
const TW = TC + 2;

/** Per worker: lake levels by tile and the coarse tiles they were built from (null: no lake in the tile). */
const cache = new Map<string, Float32Array | null>();
const CACHE_MAX = 256;
/** Coarse tiles are cached by seed signature (hydro.ts): the same object means the same surface. */
const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object) => {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return id;
};

export class CoarseLakes {
  private readonly local = new Map<number, Float32Array | null>();
  constructor(private readonly field: CoarseField) {}

  /** Level of the coarse lake at (x, y), or NaN where there is none. */
  level(x: number, y: number): number {
    const gi = Math.round(x / COARSE);
    const gj = Math.round(y / COARSE);
    const tx = Math.floor(gi / TC);
    const ty = Math.floor(gj / TC);
    const t = this.tile(tx, ty);
    if (!t) return NaN;
    const li = gi - tx * TC + 1;
    const lj = gj - ty * TC + 1;
    let L = NaN;
    // The same order as the solves, so the same level where two lakes meet.
    for (let d = -1; d < 8 && Number.isNaN(L); d++) L = t[d < 0 ? lj * TW + li : (lj + DY[d]) * TW + li + DX[d]];
    return Number.isNaN(L) || this.field.z(x, y) >= L - LAKE_SHORE_DROP ? NaN : L;
  }

  wet(x: number, y: number): boolean {
    return !Number.isNaN(this.level(x, y));
  }

  private tile(tx: number, ty: number): Float32Array | null {
    const lk = (tx + 32768) * 65536 + ty + 32768;
    const hit = this.local.get(lk);
    if (hit !== undefined) return hit;
    // World rectangle of the kept cells, and the coarse tiles the basin grid reads.
    const x0 = (tx * TC - 1) * COARSE;
    const y0 = (ty * TC - 1) * COARSE;
    const x1 = ((tx + 1) * TC) * COARSE;
    const y1 = ((ty + 1) * TC) * COARSE;
    const s = TILE_STRIDE * COARSE;
    let sig = '';
    for (let b = Math.floor((y0 - LAKE_REACH - COARSE) / s) - 1; b <= Math.floor((y1 + LAKE_REACH + COARSE) / s); b++)
      for (let a = Math.floor((x0 - LAKE_REACH - COARSE) / s) - 1; a <= Math.floor((x1 + LAKE_REACH + COARSE) / s); a++)
        sig += `${idOf(this.field.tile(a, b))},`;
    const key = `${tx},${ty}:${sig}`;
    let t = cache.get(key);
    if (t !== undefined) {
      cache.delete(key); // refresh LRU position
    } else {
      const bs = coarseBasins(this.field, x0, y0, x1, y1);
      const lv = new Float32Array(TW * TW);
      let any = false;
      for (let lj = 0; lj < TW; lj++)
        for (let li = 0; li < TW; li++) {
          const gi = tx * TC - 1 + li;
          const gj = ty * TC - 1 + lj;
          const L = bs.level[(gj - bs.g0y) * bs.gw + gi - bs.g0x];
          lv[lj * TW + li] = L;
          if (!Number.isNaN(L)) any = true;
        }
      t = any ? lv : null;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, t);
    this.local.set(lk, t);
    return t;
  }
}

const perField = new WeakMap<CoarseField, CoarseLakes>();
/** The coarse lakes of a field (one per field, so its tiles are shared by every user). */
export function lakesOf(field: CoarseField): CoarseLakes {
  let l = perField.get(field);
  if (!l) perField.set(field, (l = new CoarseLakes(field)));
  return l;
}
