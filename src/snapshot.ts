import type { SeedDump, SeedStore } from './gen/seeds';

declare const __COMMIT__: string;

/**
 * Everything needed to rebuild the land around a view exactly, in the app (`?snap=`)
 * or a dev tool (`SNAP=`): every seed held, the view, the forced region and world
 * seed if any, and the code it was made with (other code builds other land from the
 * same seeds).
 */
export interface Snapshot extends SeedDump {
  topo: 1;
  commit: string;
  at: [number, number];
  z: number;
  R: number | null;
  seed: number | null;
}

/** Commit the code was built from (at dev-server start), `-dirty` with uncommitted changes. */
export const BUILD_COMMIT: string = typeof __COMMIT__ === 'string' ? __COMMIT__ : 'unknown';

export function takeSnapshot(
  seeds: SeedStore,
  view: { x: number; y: number; zoom: number },
  R: number | null,
  seed: number | null,
  commit: string,
): Snapshot {
  return { topo: 1, commit, at: [Math.round(view.x), Math.round(view.y)], z: +view.zoom.toFixed(3), R, seed, ...seeds.dump() };
}

/** Checks every field's type: a snapshot can come from anywhere, and its values reach the page. */
export function parseSnapshot(j: unknown): Snapshot {
  const s = j as Record<string, unknown> | null;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const int = (v: unknown): v is number => Number.isSafeInteger(v);
  const grid = (g: unknown): boolean => {
    const o = g as Record<string, unknown> | null;
    return !!o && int(o.ix0) && int(o.iy0) && int(o.w) && int(o.h) && (o.w as number) >= 0 && (o.h as number) >= 0 && typeof o.seeds === 'string' && typeof o.mask === 'string';
  };
  const ok =
    !!s &&
    s.topo === 1 &&
    typeof s.commit === 'string' &&
    Array.isArray(s.at) && s.at.length === 2 && s.at.every(num) &&
    num(s.z) &&
    (s.R === null || num(s.R)) &&
    (s.seed === null || num(s.seed)) &&
    grid(s.chunks) &&
    !!s.coarse && typeof s.coarse === 'object' && Object.values(s.coarse).every(grid);
  if (!ok) throw new Error('not a Terra Incognita snapshot');
  return s as unknown as Snapshot;
}

/** File name for a snapshot of the view at (x, y). */
export const snapshotName = (x: number, y: number) => `topo_${Math.round(x)}_${Math.round(y)}.json`;
