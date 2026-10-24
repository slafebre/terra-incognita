// SNAP=<file>: replay a snapshot saved from the app's info panel (key i) in a dev tool.
// The snapshot's region is forced and its world seed used; `apply` loads its seeds.
import type { SeedStore } from '../src/gen/seeds';
import { setRegionOverride } from '../src/gen/terrain';
import { BUILD_COMMIT, parseSnapshot, type Snapshot } from '../src/snapshot';

declare const process: { env: Record<string, string | undefined> };
const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync(file: string, enc: 'utf8'): string };

export const snap: Snapshot | undefined = process.env.SNAP ? parseSnapshot(JSON.parse(readFileSync(process.env.SNAP, 'utf8'))) : undefined;

if (snap) {
  if (snap.R !== null) setRegionOverride(snap.R);
  console.log(`snapshot ${process.env.SNAP}: at ${snap.at.join(',')}${snap.R === null ? '' : ` R=${snap.R}`}${snap.seed === null ? '' : ` seed ${snap.seed}`}, commit ${snap.commit}`);
  if (snap.commit !== BUILD_COMMIT) console.warn(`  warning: this code is ${BUILD_COMMIT}; the land may differ`);
}

/** Seed a store from the snapshot, if there is one. */
export function applySnap(seeds: SeedStore): void {
  if (snap) seeds.load(snap);
}
