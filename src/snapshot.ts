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

export function parseSnapshot(j: unknown): Snapshot {
  const s = j as Partial<Snapshot> | null;
  if (!s || s.topo !== 1 || !s.chunks || !s.coarse || !Array.isArray(s.at)) throw new Error('not a Terra Incognita snapshot');
  return s as Snapshot;
}

/** File name for a snapshot of the view at (x, y). */
export const snapshotName = (x: number, y: number) => `topo_${Math.round(x)}_${Math.round(y)}.json`;
