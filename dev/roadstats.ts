// Dev tool: road network defects per region, over several random areas.
//   npx vite-node dev/roadstats.ts [areas per region] [R,R,...]
// Runs the real pipeline in-process on seeded areas and reports road defects;
// see the README for the options.
import { ChunkManager } from '../src/chunks/manager';
import type { RoadEdge, SegmentPath } from '../src/gen/roads';
import type { Site } from '../src/gen/settle';
import { DEBUG_PATHS, debugPaths, edgeGrade, nearestVertex, neighbours, vertexPos } from '../src/gen/lattice';
import { setRegionOverride, Terrain, upliftOf } from '../src/gen/terrain';
import { SeedView } from '../src/gen/seeds';
import { APRON, CELL, CHUNK, DEM_W } from '../src/lib/constants';
import { COARSE, CoarseField, coarseBasins, CORE, CORE_PAD, NODE, NODES } from '../src/gen/hydro';
import { expand } from '../src/gen/seeds';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';
import { rng } from '../src/lib/hash';
import { smoothPolyline } from '../src/lib/polyline';
import { SMOOTH_PASSES } from '../src/render/roads';

declare const process: { argv: string[]; env: Record<string, string | undefined> };
const FS = 'node:fs';
const { writeFileSync } = (await import(/* @vite-ignore */ FS)) as { writeFileSync(file: string, data: string): void };

const AREAS = Number(process.argv[2] ?? 3);
const REGIONS = (process.argv[3] ?? '0.15,0.3,0.45,0.6').split(',').map(Number);
const SIZE = 3000;
/** Enclosed areas smaller than this (m²) are loops, not network meshes. */
const LOOP_AREA = Number(process.env.LOOP_HA ?? 2) * 10000;
let area = { x0: 0, y0: 0, x1: 0, y1: 0 };
/** Crossings this close to a path end are junctions. */
const JUNCTION = 40;
/** Another road this close counts as running alongside. */
const ALONGSIDE = 22;

let lastSites: Site[] = [];
/** Full terrain of the last area (fine seeds exist there). */
let areaTerrain: Terrain | undefined;
let lastEdges: RoadEdge[] = [];

/** Dead ends inside the area: drawn road ends that no other road shares and that aren't at a site. */
function deadEnds(segs: SegmentPath[]): { fine: { x: number; y: number }[] } {
  const inside = (x: number, y: number) => x >= area.x0 && x < area.x1 && y >= area.y0 && y < area.y1;
  const atSite = (x: number, y: number, r: number) => lastSites.some((t) => Math.hypot(t.x - x, t.y - y) < r);
  const deg = new Map<string, number>();
  for (const g of segs)
    for (const i of [0, g.xy.length - 2]) {
      const k = `${g.xy[i]},${g.xy[i + 1]}`;
      deg.set(k, (deg.get(k) ?? 0) + 1);
    }
  const fine: { x: number; y: number }[] = [];
  for (const [k, n] of deg) {
    if (n !== 1) continue;
    const [x, y] = k.split(',').map(Number);
    if (inside(x, y) && !atSite(x, y, 60)) fine.push({ x, y });
  }
  return { fine };
}

/** Terrain slope (m/m) at world (x, y), from the last area's DEMs. */
let slopeAt: (x: number, y: number) => number = () => NaN;
/** Hydro (16 m, what the fine routing sees) elevation at world (x, y), nearest node. */
let zEAt: (x: number, y: number) => number = () => NaN;
/** In a lake of a closed coarse basin (what the network could know about)? */
let coarseLakeAt: (x: number, y: number) => boolean = () => false;
/** Lake level at world (x, y) in the solve of the node's own chunk (what roads see), else NaN. */
let lakeOwnAt: (x: number, y: number) => number = () => NaN;
/** Lake depth (m, > 0 under water) at world (x, y), nearest DEM vertex. */
let waterAt: (x: number, y: number) => number = () => NaN;
/** Fine elevation (m) at world (x, y), from the last area's DEMs. */
let elevAt: (x: number, y: number) => number = () => NaN;

/** Base seed: areas are reproducible (Math.random drives every fresh seed), so code versions compare on the same terrain. */
const SEED = Number(process.env.SEED ?? 1);
let areaNo = 0;

async function segments(R: number): Promise<SegmentPath[]> {
  setRegionOverride(R);
  if (process.env.DETOURS || process.env.GRADECMP) debugPaths(true);
  Math.random = rng(SEED * 7919 + areaNo++ * 104729 + Math.round(R * 1000));
  const pool = {
    size: 4,
    busy: 0,
    get idle() {
      return this.size - this.busy;
    },
    run(task: TaskRequest): Promise<TaskResult> {
      this.busy++;
      return new Promise((resolve) =>
        setTimeout(() => {
          const r: TaskResult =
            task.kind === 'render'
              ? { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 }
              : runTask(task).result;
          this.busy--;
          resolve(r);
          queueMicrotask(() => m.schedule());
        }, 0),
      );
    },
  };
  // HASHSEED=n: seeds hashed from position, as the app's ?seed=n (to look at a place in the browser).
  const m = new ChunkManager(pool, () => {}, process.env.HASHSEED === undefined ? undefined : Number(process.env.HASHSEED) >>> 0);
  const x = Math.round((Math.random() - 0.5) * 2e6);
  const y = Math.round((Math.random() - 0.5) * 2e6);
  const view = { x0: x, y0: y, x1: x + SIZE, y1: y + SIZE };
  area = view;
  for (let i = 0; i < 40000 && !m.covered(view); i++) {
    m.update(view, view, [x + SIZE / 2, y + SIZE / 2]);
    await new Promise((r) => setTimeout(r, 0));
  }
  slopeAt = (x, y) => {
    const c = m.chunks.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
    if (!c?.dem) return NaN;
    const i = APRON + Math.round((x - c.cx * CHUNK) / CELL);
    const j = APRON + Math.round((y - c.cy * CHUNK) / CELL);
    const k = j * DEM_W + i;
    const d = c.dem;
    // 16 m baseline: road-scale terrain, not 4 m texture.
    return Math.hypot(d[k + 4] - d[k - 4], d[k + 4 * DEM_W] - d[k - 4 * DEM_W]) / (8 * CELL);
  };
  zEAt = (x, y) => {
    const gx = Math.round(x / NODE);
    const gy = Math.round(y / NODE);
    const c = m.chunks.get(`${Math.floor(gx / NODES)},${Math.floor(gy / NODES)}`);
    if (!c?.hydro) return NaN;
    return c.hydro.zE[(gy - (c.cy * NODES - CORE_PAD)) * CORE + (gx - (c.cx * NODES - CORE_PAD))];
  };
  elevAt = (x, y) => {
    const c = m.chunks.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
    if (!c?.dem) return NaN;
    const u = APRON + (x - c.cx * CHUNK) / CELL;
    const v = APRON + (y - c.cy * CHUNK) / CELL;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const k = j * DEM_W + i;
    const d = c.dem;
    return (d[k] * (1 - fu) + d[k + 1] * fu) * (1 - fv) + (d[k + DEM_W] * (1 - fu) + d[k + DEM_W + 1] * fu) * fv;
  };
  waterAt = (x, y) => {
    const c = m.chunks.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
    if (!c?.water) return NaN;
    const i = APRON + Math.round((x - c.cx * CHUNK) / CELL);
    const j = APRON + Math.round((y - c.cy * CHUNK) / CELL);
    return c.water[j * DEM_W + i];
  };
  lakeOwnAt = (x, y) => {
    const gx = Math.round(x / NODE);
    const gy = Math.round(y / NODE);
    const c = m.chunks.get(`${Math.floor(gx / NODES)},${Math.floor(gy / NODES)}`);
    if (!c?.hydro) return NaN;
    return c.hydro.lake[(gy - (c.cy * NODES - CORE_PAD)) * CORE + (gx - (c.cx * NODES - CORE_PAD))];
  };
  {
    const r = { x0: view.x0 - 600, y0: view.y0 - 600, x1: view.x1 + 600, y1: view.y1 + 600 };
    const sv = new SeedView(m.seeds.payloadFor(r, expand(r, 40000)));
    const basins = coarseBasins(new CoarseField(new Terrain(sv), sv), view.x0, view.y0, view.x1, view.y1);
    coarseLakeAt = (x, y) => {
      // The fine lake spreads up to a cell beyond the coarse lake cells.
      const i0 = Math.round(x / COARSE) - basins.g0x;
      const j0 = Math.round(y / COARSE) - basins.g0y;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const i = i0 + di, j = j0 + dj;
          if (i >= 0 && j >= 0 && i < basins.gw && j < basins.gh && basins.kind[j * basins.gw + i] === 1) return true;
        }
      return false;
    };
  }
  areaTerrain = new Terrain(new SeedView(m.seeds.payloadFor({ x0: view.x0 - 600, y0: view.y0 - 600, x1: view.x1 + 600, y1: view.y1 + 600 })));
  lastSites = [];
  lastEdges = [];
  for (const n of m.nets.values()) {
    lastSites.push(...(n.data?.sites ?? []));
    lastEdges.push(...(n.data?.edges ?? []));
  }
  const byKey = new Map<string, SegmentPath>();
  for (const c of m.chunks.values()) for (const s of c.roads ?? []) byKey.set(s.key, s);
  // Sampled every 8 m at most, so what lies under a long straight step is seen.
  return [...byKey.values()].map((g) => {
    const out: number[] = [g.xy[0], g.xy[1]];
    for (let i = 2; i < g.xy.length; i += 2) {
      const n = Math.max(1, Math.ceil(Math.hypot(g.xy[i] - g.xy[i - 2], g.xy[i + 1] - g.xy[i - 1]) / 8));
      for (let s = 1; s <= n; s++) out.push(g.xy[i - 2] + ((g.xy[i] - g.xy[i - 2]) * s) / n, g.xy[i - 1] + ((g.xy[i + 1] - g.xy[i - 1]) * s) / n);
    }
    return { ...g, xy: Float32Array.from(out) };
  });
}

/**
 * Small loops: rasterise the roads (4 m cells, ~8 m wide), flood the background
 * from the border, and count the enclosed pockets below LOOP_AREA whose centre
 * lies in the area.
 */
function smallLoops(segs: SegmentPath[]): { x: number; y: number; a: number }[] {
  const C = 4;
  const M = 1000;
  const x0 = area.x0 - M, y0 = area.y0 - M;
  const W = Math.ceil((area.x1 - area.x0 + 2 * M) / C), H = Math.ceil((area.y1 - area.y0 + 2 * M) / C);
  const g = new Uint8Array(W * H);
  const dot = (x: number, y: number) => {
    const i = Math.round((x - x0) / C), j = Math.round((y - y0) / C);
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < W && b < H) g[b * W + a] = 1;
      }
  };
  for (const s of segs)
    for (let i = 1; i < s.xy.length / 2; i++) {
      const ax = s.xy[2 * i - 2], ay = s.xy[2 * i - 1], bx = s.xy[2 * i], by = s.xy[2 * i + 1];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 2) + 1;
      for (let t = 0; t <= n; t++) dot(ax + ((bx - ax) * t) / n, ay + ((by - ay) * t) / n);
    }
  const out: { x: number; y: number; a: number }[] = [];
  const stack: number[] = [];
  const fill = (k0: number) => {
    let n = 0, sx = 0, sy = 0, border = false;
    stack.push(k0);
    g[k0] = 2;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % W, j = (k - i) / W;
      n++; sx += i; sy += j;
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) border = true;
      for (const q of [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, j > 0 ? k - W : -1, j < H - 1 ? k + W : -1])
        if (q >= 0 && g[q] === 0) {
          g[q] = 2;
          stack.push(q);
        }
    }
    return { n, x: x0 + (sx / n) * C, y: y0 + (sy / n) * C, border };
  };
  for (let k = 0; k < W * H; k++) {
    if (g[k]) continue;
    const r = fill(k);
    const a = r.n * C * C;
    if (r.border || a >= LOOP_AREA) continue;
    if (r.x < area.x0 || r.x >= area.x1 || r.y < area.y0 || r.y >= area.y1) continue;
    out.push({ x: r.x, y: r.y, a });
  }
  return out;
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number] | null {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [ax + t * rx, ay + t * ry] : null;
}

const marks: { x: number; y: number; kind: 'cross' | 'along' | 'sep' }[] = [];

function stats(segs: SegmentPath[]): { km: number; crossings: number; alongside: number } {
  marks.length = 0;
  const ends: [number, number][] = [];
  let len = 0;
  for (const s of segs) {
    const n = s.xy.length / 2;
    ends.push([s.xy[0], s.xy[1]], [s.xy[2 * n - 2], s.xy[2 * n - 1]]);
    for (let i = 1; i < n; i++) len += Math.hypot(s.xy[2 * i] - s.xy[2 * i - 2], s.xy[2 * i + 1] - s.xy[2 * i - 1]);
  }
  const nearEnd = (x: number, y: number, d: number) => ends.some(([ex, ey]) => Math.hypot(ex - x, ey - y) < d);
  // Spatial hash of polyline pieces.
  const G = 64;
  const grid = new Map<string, [number, number][]>();
  segs.forEach((s, si) => {
    for (let i = 1; i < s.xy.length / 2; i++) {
      const k = `${Math.floor(s.xy[2 * i] / G)},${Math.floor(s.xy[2 * i + 1] / G)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push([si, i]);
    }
  });
  let crossings = 0;
  const seen = new Set<string>();
  segs.forEach((s, si) => {
    for (let i = 1; i < s.xy.length / 2; i++) {
      const gx = Math.floor(s.xy[2 * i] / G), gy = Math.floor(s.xy[2 * i + 1] / G);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          for (const [sj, j] of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (sj < si || (sj === si && j <= i + 1)) continue;
            const t = segs[sj];
            const p = cross(s.xy[2 * i - 2], s.xy[2 * i - 1], s.xy[2 * i], s.xy[2 * i + 1], t.xy[2 * j - 2], t.xy[2 * j - 1], t.xy[2 * j], t.xy[2 * j + 1]);
            if (!p || nearEnd(p[0], p[1], JUNCTION)) continue;
            const key = `${Math.round(p[0] / 30)},${Math.round(p[1] / 30)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            crossings++;
            {
              const e = (q: SegmentPath) => [`${q.xy[0]},${q.xy[1]}`, `${q.xy[q.xy.length - 2]},${q.xy[q.xy.length - 1]}`];
              const kind = sj === si ? 'self' : e(s).some((k) => e(t).includes(k)) ? 'adjacent' : 'other';
              crossKinds.set(kind, (crossKinds.get(kind) ?? 0) + 1);
            }
            marks.push({ x: p[0], y: p[1], kind: 'cross' });
          }
    }
  });
  // Length of road with a different segment alongside, away from shared ends.
  let along = 0;
  segs.forEach((s, si) => {
    for (let i = 1; i < s.xy.length / 2; i++) {
      const x = s.xy[2 * i], y = s.xy[2 * i + 1];
      if (nearEnd(x, y, 3 * ALONGSIDE)) continue;
      const gx = Math.floor(x / G), gy = Math.floor(y / G);
      let hit = false;
      let other = -1;
      for (let dy = -1; dy <= 1 && !hit; dy++)
        for (let dx = -1; dx <= 1 && !hit; dx++)
          for (const [sj, j] of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (sj === si) continue;
            const t = segs[sj];
            if (Math.hypot(t.xy[2 * j] - x, t.xy[2 * j + 1] - y) < ALONGSIDE) {
              hit = true;
              other = sj;
              break;
            }
          }
      if (hit) {
        along += Math.hypot(x - s.xy[2 * i - 2], y - s.xy[2 * i - 1]);
        const t = segs[other];
        const e = (q: SegmentPath) => [[q.xy[0], q.xy[1]], [q.xy[q.xy.length - 2], q.xy[q.xy.length - 1]]];
        const fork = e(s).some(([ax, ay]) => e(t).some(([bx, by]) => Math.hypot(ax - bx, ay - by) < 1));
        marks.push({ x, y, kind: fork ? 'along' : 'sep' });
      }
    }
  });
  return { km: len / 1000, crossings, alongside: along / 1000 };
}

let loopsN = 0, areaKm2 = 0, inKm = 0, deadFine = 0;
const microStats = [0, 0, 0];
/** Hairpins of fine-routed pieces as drawn: apex radius and leg spacing (m), per region. */
let pinR: number[] = [];
let pinSep: number[] = [];
let pinLeg: number[] = [];
let pinKm = 0;
/** Per class: [hairpins, km of fine-routed way, legs between hairpins]. */
let pinCls: [number, number, number[]][] = [0, 1, 2, 3, 4].map(() => [0, 0, []]);
const microGrade = [0, 0, 0];
const siteCount = [0, 0, 0, 0];
const gradeLen = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
const crossKinds = new Map<string, number>();
const unreached = [0, 0, 0, 0];
/** Roads in lakes per class: [km in water, crossings over WET_RUN m, short clips]; lake share of the area. */
const wetLen = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
const WET_RUN = 30;
/** Ways ending in a lake, per class (drawn ends no other way shares, in water). */
const wetEnds = [0, 0, 0, 0, 0];
/** Ways ending within 24 m of a lake, per class; lattice edges in the area that no chunk draws (near water / elsewhere). */
const shoreEnds = [0, 0, 0, 0, 0];
const undrawn = [0, 0];
let lakeCells = 0, areaCells = 0, wetVerts = 0, allVerts = 0, wetCoarse = 0, wetVertsCoarse = 0, lakeCoarse = 0;
const wetMarks: { x: number; y: number; a: number }[] = [];
for (const R of REGIONS) {
  let km = 0, crossings = 0, alongside = 0;
  for (let a = 0; a < AREAS; a++) {
    const segs = await segments(R);
    const s = stats(segs);
    const lp = smallLoops(segs);
    const de = deadEnds(segs);
    {
      // Micro-routed pieces (keys of several edges joined by '+', or single edges whose
      // drawn length is well beyond the straight line).
      let pieces = 0, pieceKm = 0, longer = 0;
      for (const g of segs) {
        const n = g.xy.length / 2;
        let len = 0;
        for (let i = 1; i < n; i++) len += Math.hypot(g.xy[2 * i] - g.xy[2 * i - 2], g.xy[2 * i + 1] - g.xy[2 * i - 1]);
        const chord = Math.hypot(g.xy[2 * n - 2] - g.xy[0], g.xy[2 * n - 1] - g.xy[1]);
        if (g.key.includes('+')) {
          pieces++;
          pieceKm += len / 1000;
        }
        if (len > 1.5 * chord) longer++;
      }
      // Gradients of micro pieces: on the 16 m hydro surface and on the DEM, over 48 m.
      for (const g of segs) {
        if (!g.micro) continue;
        const lim = [0.07, 0.1, 0.15, 0.22, 0.45][g.cls];
        let acc = 0;
        let la = 0;
        const n = g.xy.length / 2;
        for (let i = 1; i < n; i++) {
          acc += Math.hypot(g.xy[2 * i] - g.xy[2 * la], g.xy[2 * i + 1] - g.xy[2 * la + 1]);
          if (acc < 48 && i < n - 1) continue;
          const d = Math.hypot(g.xy[2 * i] - g.xy[2 * la], g.xy[2 * i + 1] - g.xy[2 * la + 1]) || 1;
          const a = Math.abs(zEAt(g.xy[2 * i], g.xy[2 * i + 1]) - zEAt(g.xy[2 * la], g.xy[2 * la + 1])) / d;
          const b = Math.abs(elevAt(g.xy[2 * i], g.xy[2 * i + 1]) - elevAt(g.xy[2 * la], g.xy[2 * la + 1])) / d;
          if (!Number.isNaN(a) && !Number.isNaN(b)) {
            microGrade[0] += acc;
            if (a > lim) microGrade[1] += acc;
            if (b > lim) microGrade[2] += acc;
          }
          acc = 0;
          la = i;
        }
      }
      // Hairpins as drawn (see `hairpins`).
      const pins: Pin[] = [];
      for (const g of segs) {
        if (!g.micro) continue;
        let km = 0;
        for (let i = 1; i < g.xy.length / 2; i++) km += Math.hypot(g.xy[2 * i] - g.xy[2 * i - 2], g.xy[2 * i + 1] - g.xy[2 * i - 1]) / 1000;
        const pc = pinCls[g.cls];
        pc[1] += km;
        const hs = hairpins(g);
        pc[0] += hs.length;
        for (const h of hs) if (!Number.isNaN(h.leg)) pc[2].push(h.leg);
        if (g.cls > 2) continue;
        pinKm += km;
        for (const h of hs) {
          pins.push(h);
          pinR.push(h.r);
          pinSep.push(h.sep);
          if (!Number.isNaN(h.leg)) pinLeg.push(h.leg);
        }
      }
      if (process.env.HAIRPINS) hairpinSheet(segs, pins.slice(0, 24), `${process.env.HAIRPINS}-R${R}-${a}.svg`);
      if (process.env.PINLOG) for (const h of pins) console.log(`  hairpin at ${h.x.toFixed(0)},${h.y.toFixed(0)} r=${h.r.toFixed(0)} m sep=${h.sep.toFixed(0)} m`);
      microStats[0] += pieces;
      microStats[1] += pieceKm;
      microStats[2] += longer;
    }
    if (process.env.GRADECMP && DEBUG_PATHS?.length) {
      // Coarse (what the network sees) vs fine (what the map shows) gradient of every
      // lattice edge in the area, between its vertices.
      const field = DEBUG_PATHS[0].field;
      let n = 0, err = 0, falseSteep = 0, falseGentle = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      const seenE = new Set<number>();
      for (let x = area.x0; x < area.x1; x += 120)
        for (let y = area.y0; y < area.y1; y += 120) {
          const v = nearestVertex(x, y);
          if (seenE.has(v)) continue;
          seenE.add(v);
          const [vx, vy] = vertexPos(v);
          for (const w of neighbours(v)) {
            if (w < v) continue;
            const [wx, wy] = vertexPos(w);
            const L = Math.hypot(wx - vx, wy - vy);
            const gc = edgeGrade(field, v, w);
            const gf = Math.abs(elevAt(wx, wy) - elevAt(vx, vy)) / L;
            if (Number.isNaN(gf)) continue;
            n++;
            err += Math.abs(gc - gf);
            if (gc > 0.07 && gf < 0.05) falseSteep++;
            if (gc < 0.05 && gf > 0.07) falseGentle++;
            sx += gc; sy += gf; sxx += gc * gc; syy += gf * gf; sxy += gc * gf;
          }
        }
      const r = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
      {
        // Heights themselves at vertices.
        let m = 0, a = 0, b = 0, aa = 0, bb = 0, ab = 0, d = 0;
        for (const v of seenE) {
          const [vx, vy] = vertexPos(v);
          const zc = field.z(vx, vy);
          const zf = elevAt(vx, vy);
          if (Number.isNaN(zf)) continue;
          m++; a += zc; b += zf; aa += zc * zc; bb += zf * zf; ab += zc * zf; d += Math.abs(zc - zf);
        }
        const rz = (m * ab - a * b) / Math.sqrt((m * aa - a * a) * (m * bb - b * b));
        if (areaTerrain) {
          const DEBUG_TERRAIN = areaTerrain;
          const f = new Float64Array(4);
          let q = 0, c1 = 0, c2 = 0, c11 = 0, c22 = 0, c12 = 0, dd = 0;
          for (const v of seenE) {
            const [vx, vy] = vertexPos(v);
            DEBUG_TERRAIN.fields(vx, vy, f);
            const zp = DEBUG_TERRAIN.elevationWith(vx, vy, f[0], f[1], f[2], f[3], 64) + upliftOf(f[0]);
            const zf = elevAt(vx, vy);
            if (Number.isNaN(zf)) continue;
            q++; c1 += zp; c2 += zf; c11 += zp * zp; c22 += zf * zf; c12 += zp * zf; dd += Math.abs(zp - zf);
          }
          {
            const zp = (x: number, y: number) => {
              DEBUG_TERRAIN.fields(x, y, f);
              return DEBUG_TERRAIN.elevationWith(x, y, f[0], f[1], f[2], f[3], 64) + upliftOf(f[0]);
            };
            let n2 = 0, a1 = 0, a2 = 0, a11 = 0, a22 = 0, a12 = 0;
            for (const v of seenE) {
              const [vx, vy] = vertexPos(v);
              for (const w of neighbours(v)) {
                if (w < v) continue;
                const [wx, wy] = vertexPos(w);
                const L = Math.hypot(wx - vx, wy - vy);
                const gp = Math.abs(zp(wx, wy) - zp(vx, vy)) / L;
                const gf = Math.abs(elevAt(wx, wy) - elevAt(vx, vy)) / L;
                if (Number.isNaN(gf)) continue;
                n2++; a1 += gp; a2 += gf; a11 += gp * gp; a22 += gf * gf; a12 += gp * gf;
              }
            }
            console.log(`PRE-EROSION GRADES: correlation with the map ${((n2 * a12 - a1 * a2) / Math.sqrt((n2 * a11 - a1 * a1) * (n2 * a22 - a2 * a2))).toFixed(2)} (mean ${(100 * a1 / n2).toFixed(1)}% vs map ${(100 * a2 / n2).toFixed(1)}%)`);
          }
          console.log(`PRE-EROSION: mean ${(c1 / q).toFixed(0)} m vs fine ${(c2 / q).toFixed(0)} m, mean |diff| ${(dd / q).toFixed(1)} m, correlation ${((q * c12 - c1 * c2) / Math.sqrt((q * c11 - c1 * c1) * (q * c22 - c2 * c2))).toFixed(3)}`);
        }
        console.log(`HEIGHTS: ${m} vertices, mean coarse ${(a / m).toFixed(0)} m, fine ${(b / m).toFixed(0)} m, mean |diff| ${(d / m).toFixed(1)} m, correlation ${rz.toFixed(3)}, std coarse ${Math.sqrt(aa / m - (a / m) ** 2).toFixed(0)} fine ${Math.sqrt(bb / m - (b / m) ** 2).toFixed(0)}`);
      }
      console.log(`GRADECMP: ${n} edges, mean |coarse − fine| ${(100 * err / n).toFixed(1)} pts, correlation ${r.toFixed(2)}; coarse >7% but map <5%: ${(100 * falseSteep / n).toFixed(1)}%, coarse <5% but map >7%: ${(100 * falseGentle / n).toFixed(1)}%  (mean coarse ${(100 * sx / n).toFixed(1)}%, fine ${(100 * sy / n).toFixed(1)}%)`);
    }
    if (process.env.DETOURS && DEBUG_PATHS) {
      const seenD = new Set<string>();
      for (const p of DEBUG_PATHS) {
        const vs = [p.edges[p.edges.length - 1][0], ...p.edges.slice().reverse().map((e) => e[1])];
        const P = vs.map((v) => vertexPos(v));
        const along: number[] = [0];
        for (let i = 1; i < vs.length; i++) along.push(along[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
        for (let i = 0; i < vs.length; i++)
          for (let j = i + 4; j < vs.length; j++) {
            const direct = Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]);
            if (direct > 250 || along[j] - along[i] < 4 * direct + 400) continue;
            if (!neighbours(vs[i]).includes(vs[j])) break;
            const inArea = P[i][0] >= area.x0 && P[i][0] < area.x1 && P[i][1] >= area.y0 && P[i][1] < area.y1;
            const k = `${vs[i]}-${vs[j]}`;
            if (!inArea || seenD.has(k)) break;
            seenD.add(k);
            const fine = Math.abs(elevAt(P[j][0], P[j][1]) - elevAt(P[i][0], P[i][1])) / direct;
            console.log(`  detour cls ${p.k}: ${(along[j] - along[i]).toFixed(0)} m round, direct ${direct.toFixed(0)} m: coarse grade ${(100 * edgeGrade(p.field, vs[i], vs[j])).toFixed(0)}%, fine ${(100 * fine).toFixed(0)}%`);
            i = j;
            break;
          }
      }
      debugPaths(true);
    }
    // Grades along drawn roads on the fine DEM, over 48 m windows.
    for (const g of segs) {
      const pts: [number, number][] = [];
      let acc = 0;
      for (let i = 0; i < g.xy.length; i += 2) {
        if (i > 0) acc += Math.hypot(g.xy[i] - g.xy[i - 2], g.xy[i + 1] - g.xy[i - 1]);
        pts.push([acc, elevAt(g.xy[i], g.xy[i + 1])]);
      }
      let j = 0;
      for (let i = 0; i < pts.length; i++) {
        while (j < pts.length && pts[j][0] - pts[i][0] < 48) j++;
        if (j >= pts.length) break;
        const ds = pts[j][0] - pts[i][0];
        const gr = Math.abs(pts[j][1] - pts[i][1]) / ds;
        if (Number.isNaN(gr)) continue;
        const step = i + 1 < pts.length ? pts[i + 1][0] - pts[i][0] : 0;
        const lim = [0.07, 0.1, 0.15, 0.22, 0.45][g.cls];
        gradeLen[g.cls][0] += step;
        if (gr > lim) gradeLen[g.cls][1] += step;
        if (gr > 1.5 * lim) gradeLen[g.cls][2] += step;
      }
    }
    // Roads standing in lakes (DEM water > 0), inside the area: total length, and runs
    // of wet road longer than WET_RUN (crossings) vs shorter (shore clips).
    for (const g of segs) {
      let run = 0, rx = 0, ry = 0;
      const end = () => {
        if (run > WET_RUN) {
          wetLen[g.cls][1]++;
          wetMarks.push({ x: rx, y: ry, a: run });
        } else if (run > 0) wetLen[g.cls][2]++;
        run = 0;
      };
      for (let i = 1; i < g.xy.length / 2; i++) {
        const x = g.xy[2 * i], y = g.xy[2 * i + 1];
        if (x < area.x0 || x >= area.x1 || y < area.y0 || y >= area.y1) {
          end();
          continue;
        }
        const step = Math.hypot(x - g.xy[2 * i - 2], y - g.xy[2 * i - 1]);
        if (waterAt(x, y) > 0) {
          if (run === 0) [rx, ry] = [x, y];
          run += step;
          wetLen[g.cls][0] += step / 1000;
          if (coarseLakeAt(x, y)) wetCoarse += step / 1000;
        } else end();
      }
      end();
    }
    {
      const vs = new Set<string>();
      for (const e of lastEdges)
        for (const i of [0, 2]) {
          const [x, y] = [e.route[i], e.route[i + 1]];
          if (x < area.x0 || x >= area.x1 || y < area.y0 || y >= area.y1 || vs.has(`${x},${y}`)) continue;
          vs.add(`${x},${y}`);
          allVerts++;
          if (waterAt(x, y) > 0) {
            wetVerts++;
            if (coarseLakeAt(x, y)) wetVertsCoarse++;
          }
        }
    }
    if (process.env.LAKECMP) {
      // Roads see each node's own-chunk solve; the map draws the blend. How far apart?
      let both = 0, ownOnly = 0, mapOnly = 0;
      const mapOnlyDist = new Array(8).fill(0);
      for (let y = area.y0; y < area.y1; y += 16)
        for (let x = area.x0; x < area.x1; x += 16) {
          const own = !Number.isNaN(lakeOwnAt(x, y));
          const drawn = waterAt(x, y) > 0;
          if (own && drawn) both++;
          else if (own) ownOnly++;
          else if (drawn) {
            mapOnly++;
            let d = 99;
            for (let r = 1; r <= 6 && d === 99; r++)
              for (let dy = -r; dy <= r; dy++)
                for (let dx = -r; dx <= r; dx++) if (!Number.isNaN(lakeOwnAt(x + 16 * dx, y + 16 * dy))) d = Math.min(d, r);
            mapOnlyDist[Math.min(d, 7)]++;
          }
        }
      console.log(`LAKECMP: lake in both ${both}, only in own-chunk solve ${ownOnly}, only on the map ${mapOnly} (16 m samples); nodes from the nearest own-solve lake: ${mapOnlyDist.join(' ')}`);
    }
    {
      const deg = new Map<string, number>();
      for (const g of segs)
        for (const i of [0, g.xy.length - 2]) {
          const k = `${g.xy[i]},${g.xy[i + 1]}`;
          deg.set(k, (deg.get(k) ?? 0) + 1);
        }
      for (const g of segs)
        for (const i of [0, g.xy.length - 2]) {
          const x = g.xy[i], y = g.xy[i + 1];
          if (deg.get(`${x},${y}`) !== 1 || x < area.x0 || x >= area.x1 || y < area.y0 || y >= area.y1 || !(waterAt(x, y) > 0)) continue;
          wetEnds[g.cls]++;
          if (process.env.WETLOG) console.log(`  way (class ${g.cls}) ending in a lake at ?at=${Math.round(x)},${Math.round(y)}`);
        }
      const nearWater = (x: number, y: number) => {
        for (const r of [8, 16, 24]) for (let k = 0; k < 8; k++) if (waterAt(x + r * Math.cos((k * Math.PI) / 4), y + r * Math.sin((k * Math.PI) / 4)) > 0) return true;
        return waterAt(x, y) > 0;
      };
      for (const g of segs)
        for (const i of [0, g.xy.length - 2]) {
          const x = g.xy[i], y = g.xy[i + 1];
          if (deg.get(`${x},${y}`) !== 1 || x < area.x0 || x >= area.x1 || y < area.y0 || y >= area.y1 || !nearWater(x, y)) continue;
          shoreEnds[g.cls]++;
          if (process.env.WETLOG) console.log(`  way (class ${g.cls}) ending at a lake at ?at=${Math.round(x)},${Math.round(y)}`);
        }
      const drawnKeys = new Set<string>();
      for (const g of segs) for (const k of g.key.split('~')[0].split('+')) drawnKeys.add(k);
      for (const e of lastEdges) {
        const mx = (e.route[0] + e.route[2]) / 2, my = (e.route[1] + e.route[3]) / 2;
        if (mx < area.x0 || mx >= area.x1 || my < area.y0 || my >= area.y1 || drawnKeys.has(e.id)) continue;
        const wetish = nearWater(mx, my) || nearWater(e.route[0], e.route[1]) || nearWater(e.route[2], e.route[3]);
        undrawn[wetish ? 0 : 1]++;
        if (process.env.WETLOG) console.log(`  undrawn edge (class ${e.cls}${wetish ? ', at water' : ''}) at ?at=${Math.round(mx)},${Math.round(my)}`);
      }
    }
    for (let y = area.y0; y < area.y1; y += 16)
      for (let x = area.x0; x < area.x1; x += 16) {
        const wv = waterAt(x, y);
        if (Number.isNaN(wv)) continue;
        areaCells++;
        if (wv > 0) lakeCells++;
        if (wv > 0 && coarseLakeAt(x, y)) lakeCoarse++;
        if (process.env.COARSELOG && wv > 0 && coarseLakeAt(x, y) && x % 512 === area.x0 % 512 && y % 512 === area.y0 % 512) console.log(`  coarse lake at ?at=${x},${y}`);
      }
    if (process.env.WETLOG) for (const w of wetMarks) console.log(`  wet run ${w.a.toFixed(0)} m at ?at=${Math.round(w.x)},${Math.round(w.y)}`);
    if (process.env.WET && wetMarks.length) sheet(segs, wetMarks.splice(0), `${process.env.WET}-R${R}-${a}.svg`);
    wetMarks.length = 0;
    // Settlements in the area that no road reaches (within 120 m of a drawn road point).
    {
      const pts = new Set<string>();
      for (const g of segs) for (let i = 0; i < g.xy.length; i += 2) pts.add(`${Math.floor(g.xy[i] / 100)},${Math.floor(g.xy[i + 1] / 100)}`);
      const reached = (s: Site) => {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (pts.has(`${Math.floor(s.x / 100) + dx},${Math.floor(s.y / 100) + dy}`)) return true;
        return false;
      };
      for (const st of lastSites) {
        if (st.x < area.x0 || st.x >= area.x1 || st.y < area.y0 || st.y >= area.y1) continue;
        siteCount[st.rank]++;
        if (!reached(st)) {
          unreached[st.rank]++;
          if (process.env.UNLOG) {
            const v = nearestVertex(st.x, st.y);
            const [vx, vy] = vertexPos(v);
            const edgesAt = lastEdges.filter((e) => (e.route[0] === vx && e.route[1] === vy) || (e.route[2] === vx && e.route[3] === vy)).length;
            const near = lastEdges.filter((e) => Math.hypot(e.route[0] - st.x, e.route[1] - st.y) < 400).length;
            console.log(`  unreached rank ${st.rank} at ${Math.round(st.x)},${Math.round(st.y)}: vertex ${Math.round(Math.hypot(vx - st.x, vy - st.y))} m away, edges there ${edgesAt}, edges within 400 m ${near}`);
          }
        }
      }
    }
    deadFine += de.fine.length;
    if (process.env.DEADLOG)
      for (const f of de.fine.slice(0, 6)) {
        console.log(`  drawn dead end at ${f.x},${f.y}`);
        for (const e of lastEdges)
          for (let i = 0; i < e.route.length; i += 2)
            if (Math.hypot(e.route[i] - f.x, e.route[i + 1] - f.y) < 80) {
              const prev = i > 0 ? `${e.route[i - 2]},${e.route[i - 1]}` : '-';
              const next = i < e.route.length - 2 ? `${e.route[i + 2]},${e.route[i + 3]}` : '-';
              const here = `${e.route[i]},${e.route[i + 1]}`;
              const has = (p: string) => p === '-' || segs.some((g) => g.key === (p < here ? `${p}|${here}` : `${here}|${p}`));
              console.log(`    edge ${e.id} cls ${e.cls} node ${i / 2}/${e.route.length / 2} at ${here}  seg-prev ${has(prev)} seg-next ${has(next)}`);
            }
      }
    if (process.env.DEAD) sheet(segs, de.fine.map((p) => ({ ...p, a: 0 })), `${process.env.DEAD}-R${R}-${a}.svg`);
    loopsN += lp.length;
    for (const l of lp) marks.push({ x: l.x, y: l.y, kind: 'cross' });
    areaKm2 += (SIZE / 1000) ** 2;
    // Road length inside the area only, for a density.
    for (const g of segs)
      for (let i = 1; i < g.xy.length / 2; i++) {
        const x = g.xy[2 * i], y = g.xy[2 * i + 1];
        if (x >= area.x0 && x < area.x1 && y >= area.y0 && y < area.y1) inKm += Math.hypot(x - g.xy[2 * i - 2], y - g.xy[2 * i - 1]) / 1000;
      }
    if (process.env.DUMP) svg(segs, `${process.env.DUMP}-R${R}-${a}.svg`);
    if (process.env.SHEET) sheet(segs, lp, `${process.env.SHEET}-R${R}-${a}.svg`);
    if (process.env.LOOPLOG)
      lp.forEach((l, n) => {
        const near = segs.filter((g) => {
          for (let i = 0; i < g.xy.length; i += 2) if (Math.hypot(g.xy[i] - l.x, g.xy[i + 1] - l.y) < 40) return true;
          return false;
        });
        console.log(`LOOP ${n} ${(l.a / 1e4).toFixed(2)} ha at ${l.x.toFixed(0)},${l.y.toFixed(0)}: ${near.map((g) => `${'NDCTP'[g.cls]}${g.micro ? '*' : ''}(${g.key.split('+').length}) ${g.xy[0].toFixed(0)},${g.xy[1].toFixed(0)}>${g.xy[g.xy.length - 2].toFixed(0)},${g.xy[g.xy.length - 1].toFixed(0)} n${g.xy.length / 2}`).join(' | ')}`);
      });
    if (process.env.LOOPZOOM) {
      // Close-ups of loops: every drawn vertex, micro pieces marked.
      const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${4 * 300}" height="${Math.ceil(lp.length / 4) * 300}" style="background:#fff">`];
      lp.forEach((l, n) => {
        const half = 50;
        out.push(`<svg x="${(n % 4) * 300}" y="${Math.floor(n / 4) * 300}" width="296" height="296" viewBox="${l.x - half} ${l.y - half} ${2 * half} ${2 * half}"><rect x="${l.x - half}" y="${l.y - half}" width="${2 * half}" height="${2 * half}" fill="#fbfaf5"/>`);
        for (const g of segs) {
          let near = false;
          for (let i = 0; i < g.xy.length && !near; i += 2) near = Math.abs(g.xy[i] - l.x) < half * 2 && Math.abs(g.xy[i + 1] - l.y) < half * 2;
          if (!near) continue;
          const col = g.micro ? '#c33' : '#36c';
          out.push(`<polyline points="${Array.from({ length: g.xy.length / 2 }, (_, i) => `${g.xy[2 * i].toFixed(1)},${g.xy[2 * i + 1].toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="0.6"/>`);
          for (let i = 0; i < g.xy.length; i += 2) out.push(`<circle cx="${g.xy[i]}" cy="${g.xy[i + 1]}" r="0.5" fill="${col}"/>`);
        }
        out.push(`<text x="${l.x - half + 2}" y="${l.y - half + 6}" font-size="5">${n}</text></svg>`);
      });
      out.push('</svg>');
      writeFileSync(`${process.env.LOOPZOOM}-R${R}-${a}.svg`, out.join('\n'));
    }
    km += s.km;
    crossings += s.crossings;
    alongside += s.alongside;
  }
  console.log(`SMALL LOOPS R=${R}: ${loopsN} in ${areaKm2} km² with ${inKm.toFixed(0)} km road → ${((100 * loopsN) / inKm).toFixed(1)} per 100 km`);
  console.log(`MICRO R=${R}: ${microStats[0]} multi-edge pieces drawn (${microStats[1].toFixed(1)} km), ${microStats[2]} paths over 1.5× their chord`);
  console.log(`MICRO GRADE R=${R}: over the class limit on the 16 m surface ${((100 * microGrade[1]) / (microGrade[0] || 1)).toFixed(0)}%, on the DEM ${((100 * microGrade[2]) / (microGrade[0] || 1)).toFixed(0)}% of ${(microGrade[0] / 1000).toFixed(1)} km`);
  const med = (a: number[]) => (a.length ? [...a].sort((u, v) => u - v)[a.length >> 1] : NaN);
  const q = (a: number[], f: number) => (a.length ? [...a].sort((u, v) => u - v)[Math.floor(f * (a.length - 1))] : NaN);
  console.log(`HAIRPINS R=${R}: ${pinR.length} on ${pinKm.toFixed(1)} km of fine-routed roads; apex radius median ${med(pinR).toFixed(0)} m (p10 ${q(pinR, 0.1).toFixed(0)}, p90 ${q(pinR, 0.9).toFixed(0)}), leg spacing 50 m back median ${med(pinSep).toFixed(0)} m, legs between hairpins median ${med(pinLeg).toFixed(0)} m (p10 ${q(pinLeg, 0.1).toFixed(0)}, p90 ${q(pinLeg, 0.9).toFixed(0)})`);
  console.log(`HAIRPINS BY CLASS R=${R}: ` + ['N', 'D', 'C', 'T', 'P'].map((c, i) => `${c} ${pinCls[i][0]} on ${pinCls[i][1].toFixed(1)} km, legs ${med(pinCls[i][2]).toFixed(0)} m`).join('  '));
  pinCls = [0, 1, 2, 3, 4].map(() => [0, 0, []]);
  pinR = [];
  pinSep = [];
  pinLeg = [];
  pinKm = 0;
  microGrade.fill(0);
  microStats.fill(0);
  console.log(`DEAD ENDS R=${R}: ${deadFine} (road ends not at a settlement or farm)`);
  console.log(`UNREACHED R=${R} town/village/hamlet/farm: ${unreached.map((u, i) => `${u}/${siteCount[i]}`).join('  ')}`);
  console.log(`GRADE R=${R} share of road over its limit / over 1.5× limit: ` + ['N', 'D', 'C', 'T', 'P'].map((n, i) => `${n} ${((100 * gradeLen[i][1]) / (gradeLen[i][0] || 1)).toFixed(0)}% / ${((100 * gradeLen[i][2]) / (gradeLen[i][0] || 1)).toFixed(0)}% of ${(gradeLen[i][0] / 1000).toFixed(0)} km`).join('  '));
  for (const gl of gradeLen) gl.fill(0);
  console.log(`LAKES R=${R}: ${((100 * lakeCells) / (areaCells || 1)).toFixed(1)}% of the area is lake, ${wetVerts} of ${allVerts} way vertices in a lake; road in water (km, crossings > ${WET_RUN} m, shore clips): ` + ['N', 'D', 'C', 'T', 'P'].map((n, i) => `${n} ${wetLen[i][0].toFixed(2)} / ${wetLen[i][1]} / ${wetLen[i][2]}`).join('  ') + `; ways ending in a lake N/D/C/T/P ${wetEnds.join('/')}, within 24 m of one ${shoreEnds.join('/')}; undrawn edges at water ${undrawn[0]}, elsewhere ${undrawn[1]}`);
  wetEnds.fill(0);
  shoreEnds.fill(0);
  undrawn.fill(0);
  console.log(`COARSE LAKES R=${R}: ${((100 * lakeCoarse) / (lakeCells || 1)).toFixed(0)}% of lake area, ${wetVertsCoarse} of ${wetVerts} wet vertices, ${wetCoarse.toFixed(2)} km of road in water lie in (or a cell from) a closed coarse basin's lake`);
  for (const wl of wetLen) wl.fill(0);
  lakeCells = 0;
  areaCells = 0;
  wetVerts = 0;
  allVerts = 0;
  wetCoarse = 0;
  wetVertsCoarse = 0;
  lakeCoarse = 0;
  console.log(`CROSS KINDS R=${R}: ${JSON.stringify(Object.fromEntries(crossKinds))}`);
  crossKinds.clear();
  siteCount.fill(0);
  unreached.fill(0);
  deadFine = 0;
  loopsN = 0; areaKm2 = 0; inKm = 0;
  console.log(`R=${R}  road ${km.toFixed(1)} km  crossings ${crossings} (${(crossings / km).toFixed(2)}/km)  alongside ${alongside.toFixed(2)} km (${((100 * alongside) / km).toFixed(1)}%)`);
}

/** Writes roads (by class), waypoints and defect marks as an SVG, north up. */
function svg(segs: SegmentPath[], file: string): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs)
    for (let i = 0; i < s.xy.length; i += 2) {
      x0 = Math.min(x0, s.xy[i]); x1 = Math.max(x1, s.xy[i]);
      y0 = Math.min(y0, s.xy[i + 1]); y1 = Math.max(y1, s.xy[i + 1]);
    }
  const k = Number(process.env.SCALE ?? 0.25); // px per m
  const X = (x: number) => ((x - x0) * k).toFixed(1);
  const Y = (y: number) => ((y - y0) * k).toFixed(1);
  const col = ['#d0302a', '#e0a020', '#555', '#999', '#bbb'];
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${((x1 - x0) * k).toFixed(0)}" height="${((y1 - y0) * k).toFixed(0)}" style="background:#fbfaf5">`];
  for (const m of marks)
    out.push(m.kind === 'cross' ? `<circle cx="${X(m.x)}" cy="${Y(m.y)}" r="8" fill="none" stroke="#c0f" stroke-width="2"/>` : `<circle cx="${X(m.x)}" cy="${Y(m.y)}" r="3" fill="${m.kind === 'along' ? '#f88' : '#8cf'}"/>`);
  for (const s of segs) {
    const pts: string[] = [];
    for (let i = 0; i < s.xy.length; i += 2) pts.push(`${X(s.xy[i])},${Y(s.xy[i + 1])}`);
    const hue = [...s.key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
    out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${process.env.HUE ? `hsl(${hue},70%,40%)` : col[s.cls]}" stroke-width="${[3, 2, 1.2, 0.8, 0.6][s.cls]}"/>`);
    const n = s.xy.length;
    out.push(`<circle cx="${X(s.xy[0])}" cy="${Y(s.xy[1])}" r="3" fill="#06c"/><circle cx="${X(s.xy[n - 2])}" cy="${Y(s.xy[n - 1])}" r="3" fill="#06c"/>`);
  }
  out.push('</svg>');
  writeFileSync(file, out.join('\n'));
}

/** Contact sheet: one tile per small loop, 500 m across, segments in distinct colours. */
function sheet(segs: SegmentPath[], lp: { x: number; y: number; a: number }[], file: string): void {
  if (!lp.length) return;
  const T = 300, cols = 4, half = 250;
  const rows = Math.ceil(lp.length / cols);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${cols * T}" height="${rows * T}" style="background:#fff">`];
  lp.forEach((l, n) => {
    const tx = (n % cols) * T, ty = Math.floor(n / cols) * T;
    out.push(`<svg x="${tx}" y="${ty}" width="${T - 4}" height="${T - 4}" viewBox="${l.x - half} ${l.y - half} ${2 * half} ${2 * half}" style="background:#fbfaf5">`);
    out.push(`<rect x="${l.x - half}" y="${l.y - half}" width="${2 * half}" height="${2 * half}" fill="#fbfaf5" stroke="#999"/>`);
    for (let wy = l.y - half; wy < l.y + half; wy += 8)
      for (let wx = l.x - half; wx < l.x + half; wx += 8) if (waterAt(wx, wy) > 0) out.push(`<rect x="${wx - 4}" y="${wy - 4}" width="8" height="8" fill="#9cd3f0"/>`);
    for (const g of segs) {
      let near = false;
      for (let i = 0; i < g.xy.length && !near; i += 2) near = Math.abs(g.xy[i] - l.x) < half * 1.5 && Math.abs(g.xy[i + 1] - l.y) < half * 1.5;
      if (!near) continue;
      const hue = [...g.key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
      const pts: string[] = [];
      for (let i = 0; i < g.xy.length; i += 2) pts.push(`${g.xy[i].toFixed(1)},${g.xy[i + 1].toFixed(1)}`);
      out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="hsl(${hue},75%,42%)" stroke-width="${[7, 5, 3, 2, 1.5][g.cls]}" stroke-opacity="0.75"/>`);
      const n2 = g.xy.length;
      out.push(`<circle cx="${g.xy[0]}" cy="${g.xy[1]}" r="6" fill="none" stroke="#000"/><circle cx="${g.xy[n2 - 2]}" cy="${g.xy[n2 - 1]}" r="6" fill="none" stroke="#000"/>`);
    }
    const sl = slopeAt(l.x, l.y);
    out.push(`<text x="${l.x - half + 8}" y="${l.y - half + 30}" font-size="26" fill="#000">${n} a=${(l.a / 1e4).toFixed(2)}ha s=${sl.toFixed(2)}</text>`);
    out.push('</svg>');
  });
  out.push('</svg>');
  writeFileSync(file, out.join('\n'));
}

type Pin = { x: number; y: number; r: number; sep: number; leg: number; xs: number[]; ys: number[] };

/**
 * Hairpins of a road as the renderer draws it (same smoothing): along the line,
 * resampled every 2 m, places where the heading turns by more than 150° within
 * ±40 m. Apex: the sharpest point there; r: radius of the circle through the line
 * 8 m either side of it; sep: distance between the legs 50 m back from it.
 */
function hairpins(g: SegmentPath): Pin[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < g.xy.length; i += 2) {
    xs.push(g.xy[i]);
    ys.push(g.xy[i + 1]);
  }
  for (let pass = 0; pass < SMOOTH_PASSES[g.cls]; pass++) smoothPolyline(xs, ys);
  const P: number[] = [xs[0], ys[0]];
  let carry = 0;
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i] - xs[i - 1];
    const dy = ys[i] - ys[i - 1];
    const L = Math.hypot(dx, dy);
    let s = 2 - carry;
    for (; s <= L; s += 2) P.push(xs[i - 1] + (dx * s) / L, ys[i - 1] + (dy * s) / L);
    carry = L - (s - 2);
  }
  const n = P.length / 2;
  const head = (i: number) => Math.atan2(P[2 * i + 3] - P[2 * i + 1], P[2 * i + 2] - P[2 * i]);
  const turnBetween = (i: number, j: number) => {
    let d = Math.abs(head(j) - head(i)) % (2 * Math.PI);
    return d > Math.PI ? 2 * Math.PI - d : d;
  };
  const W = 20;
  const B = 25;
  const out: Pin[] = [];
  let lastApex = 0;
  for (let i = Math.max(W, B); i < n - Math.max(W, B) - 1; i++) {
    if (turnBetween(i - W, i + W) < (150 * Math.PI) / 180) continue;
    // The sharpest point of this hairpin, then skip past it.
    let best = i;
    let bestT = -1;
    let j = i;
    for (; j < n - Math.max(W, B) - 1 && turnBetween(j - W, j + W) >= (150 * Math.PI) / 180; j++) {
      const t = turnBetween(j - 3, j + 3);
      if (t > bestT) {
        bestT = t;
        best = j;
      }
    }
    const [ax, ay, bx, by, cx, cy] = [P[2 * best - 8], P[2 * best - 7], P[2 * best], P[2 * best + 1], P[2 * best + 8], P[2 * best + 9]];
    const a = Math.hypot(bx - cx, by - cy);
    const b = Math.hypot(ax - cx, ay - cy);
    const c = Math.hypot(ax - bx, ay - by);
    const area2 = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    const r = area2 > 1e-6 ? (a * b * c) / (2 * area2) : Infinity;
    const sep = Math.hypot(P[2 * (best - B)] - P[2 * (best + B)], P[2 * (best - B) + 1] - P[2 * (best + B) + 1]);
    out.push({ x: bx, y: by, r, sep, leg: out.length ? (best - lastApex) * 2 : NaN, xs, ys });
    lastApex = best;
    i = j + W;
  }
  return out;
}

/** Contact sheet of hairpins: the drawn line at road width over 5 m contours. */
function hairpinSheet(segs: SegmentPath[], pins: Pin[], file: string): void {
  if (!pins.length) return;
  const T = 300, cols = 4, half = 120, step = 4, interval = 5;
  const rows = Math.ceil(pins.length / cols);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${cols * T}" height="${rows * T}" style="background:#fff">`];
  pins.forEach((h, n) => {
    const tx = (n % cols) * T, ty = Math.floor(n / cols) * T;
    out.push(`<svg x="${tx}" y="${ty}" width="${T - 4}" height="${T - 4}" viewBox="${h.x - half} ${h.y - half} ${2 * half} ${2 * half}">`);
    out.push(`<rect x="${h.x - half}" y="${h.y - half}" width="${2 * half}" height="${2 * half}" fill="#fbfaf5" stroke="#999"/>`);
    // Contours by marching squares on a 4 m grid.
    const m = (2 * half) / step + 1;
    const z: number[] = [];
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) z.push(elevAt(h.x - half + i * step, h.y - half + j * step));
    const segsC: string[] = [];
    for (let j = 0; j < m - 1; j++)
      for (let i = 0; i < m - 1; i++) {
        const c = [z[j * m + i], z[j * m + i + 1], z[(j + 1) * m + i + 1], z[(j + 1) * m + i]];
        const lo = Math.min(...c), hi = Math.max(...c);
        for (let L = Math.ceil(lo / interval) * interval; L < hi; L += interval) {
          const pts: [number, number][] = [];
          const corner = [[0, 0], [1, 0], [1, 1], [0, 1]];
          for (let e = 0; e < 4; e++) {
            const z0 = c[e], z1 = c[(e + 1) & 3];
            if ((z0 < L) === (z1 < L)) continue;
            const t = (L - z0) / (z1 - z0);
            const [u0, v0] = corner[e], [u1, v1] = corner[(e + 1) & 3];
            pts.push([h.x - half + (i + u0 + (u1 - u0) * t) * step, h.y - half + (j + v0 + (v1 - v0) * t) * step]);
          }
          if (pts.length >= 2) segsC.push(`M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}L${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`);
        }
      }
    out.push(`<path d="${segsC.join('')}" stroke="#c9a27a" stroke-width="0.6" fill="none"/>`);
    for (const g of segs) {
      let near = false;
      for (let i = 0; i < g.xy.length && !near; i += 2) near = Math.abs(g.xy[i] - h.x) < half * 1.5 && Math.abs(g.xy[i + 1] - h.y) < half * 1.5;
      if (!near) continue;
      const xs: number[] = [], ys: number[] = [];
      for (let i = 0; i < g.xy.length; i += 2) {
        xs.push(g.xy[i]);
        ys.push(g.xy[i + 1]);
      }
      for (let pass = 0; pass < SMOOTH_PASSES[g.cls]; pass++) smoothPolyline(xs, ys);
      const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
      const wd = [9, 7, 5, 2, 1.5][g.cls];
      out.push(`<polyline points="${pts}" fill="none" stroke="#444" stroke-width="${wd + 1.5}" stroke-linejoin="round"/><polyline points="${pts}" fill="none" stroke="#fff" stroke-width="${wd}" stroke-linejoin="round"/>`);
    }
    out.push(`<text x="${h.x - half + 4}" y="${h.y - half + 14}" font-size="11" fill="#000">${n}: r=${h.r.toFixed(0)} m, legs ${h.sep.toFixed(0)} m apart</text>`);
    out.push('</svg>');
  });
  out.push('</svg>');
  writeFileSync(file, out.join('\n'));
}
