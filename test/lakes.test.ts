import { describe, expect, it } from 'vitest';
import { NODE, NODES } from '../src/gen/hydro';
import { routeCurves } from '../src/gen/lattice';
import { ROAD_C, ROAD_PAD, ROAD_T, type RoadClass, type RoadPatch, type SegmentTask } from '../src/gen/roads';

/** Flat fine patch around chunk (0, 0) with lake nodes where `wet(x, y)`. */
function patch(wet: (x: number, y: number) => boolean): RoadPatch {
  const w = NODES + 2 * ROAD_PAD;
  const p: RoadPatch = { gx: -ROAD_PAD, gy: -ROAD_PAD, w, h: w, zE: new Float32Array(w * w), A: new Float32Array(w * w), lake: new Float32Array(w * w) };
  for (let j = 0; j < w; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      p.zE[k] = 100 + 0.001 * i;
      p.lake[k] = wet((p.gx + i) * NODE, (p.gy + j) * NODE) ? 100 : NaN;
    }
  return p;
}

const task = (cls: RoadClass, ax: number, ay: number, bx: number, by: number, extra: Partial<SegmentTask> = {}): SegmentTask => ({
  key: `${ax},${ay}_${bx},${by}`,
  cls,
  ax,
  ay,
  bx,
  by,
  rivals: [],
  wedges: [],
  obstacles: [],
  ...extra,
});

/** Is any point of the drawn ways (sampled every 2 m) on a lake node? */
function inWater(p: RoadPatch, xy: Float32Array): boolean {
  for (let i = 2; i < xy.length; i += 2) {
    const n = Math.ceil(Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]) / 2);
    for (let s = 0; s <= n; s++) {
      const x = xy[i - 2] + ((xy[i] - xy[i - 2]) * s) / n;
      const y = xy[i - 1] + ((xy[i + 1] - xy[i - 1]) * s) / n;
      const k = (Math.round(y / NODE) - p.gy) * p.w + Math.round(x / NODE) - p.gx;
      if (!Number.isNaN(p.lake[k])) return true;
    }
  }
  return false;
}

describe('roads and lakes', () => {
  // A lake of 200 m across, centred well inside the chunk.
  const disc = patch((x, y) => Math.hypot(x - 420, y - 256) < 100);
  // A strip of water across the whole patch: no way round.
  const strip = patch((x) => x > 220 && x < 300);

  it('stops a road ending in a lake at the shore', () => {
    // The road's far end, a dead end, lies in the middle of the lake.
    const out = routeCurves([task(ROAD_C, 100, 256, 420, 256, { spurB: [420, 256] })], disc);
    expect(out.length).toBe(1);
    const xy = out[0].xy;
    expect(inWater(disc, xy)).toBe(false);
    const [ex, ey] = [xy[xy.length - 2], xy[xy.length - 1]];
    // It ends at the near shore (the lake reaches 320 m on this side), not short of
    // it, nor across the lake.
    expect(ex).toBeGreaterThan(320 - 3 * NODE);
    expect(ex).toBeLessThan(320);
    expect(Math.abs(ey - 256)).toBeLessThan(2 * NODE);
  });

  it('drops an edge wholly in the water beyond the shore', () => {
    // The edge from a vertex in the lake to the dead end beyond it, further in.
    const out = routeCurves([task(ROAD_C, 380, 256, 440, 256, { spurB: [440, 256] })], disc);
    expect(out.length).toBe(0);
  });

  it('keeps roads crossing water (bridges) but not tracks', () => {
    const road = routeCurves([task(ROAD_C, 100, 256, 420, 256)], strip);
    expect(road.length).toBe(1);
    const track = routeCurves([task(ROAD_T, 100, 256, 420, 256)], strip);
    expect(track.length).toBe(2);
    for (const g of track) expect(inWater(strip, g.xy)).toBe(false);
  });
});
