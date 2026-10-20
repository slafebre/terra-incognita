// Dev tool: road network defects per region, over several random areas.
//   npx vite-node dev/roadstats.ts [areas per region] [R,R,...]
// Counts small closed loops (eyes, pears, knots), crossings away from junctions,
// and length running alongside another road. Runs the real pipeline in-process.
// SHEET=<prefix> writes a contact sheet of the loops, DUMP=<prefix> each area.
import { ChunkManager } from '../src/chunks/manager';
import { mergeApproaches, type RoadEdge, type SegmentPath } from '../src/gen/roads';
import type { Site } from '../src/gen/settle';
import { nearestVertex, vertexPos } from '../src/gen/lattice';
import { setRegionOverride } from '../src/gen/terrain';
import { APRON, CELL, CHUNK, DEM_W } from '../src/lib/constants';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';
import { rng } from '../src/lib/hash';
import { setNetworkMode } from '../src/gen/network';

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
let lastEdges: RoadEdge[] = [];

/**
 * Dead ends inside the area: drawn segment ends that no other segment shares and
 * that aren't at a site; and coarse route ends that are neither a site nor on
 * another route (the network's own fault, before fine routing).
 */
function deadEnds(segs: SegmentPath[]): { fine: { x: number; y: number }[]; coarse: { x: number; y: number; id: string }[] } {
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
  const nodes = new Set<string>();
  for (const e of lastEdges) for (let i = 0; i < e.route.length; i += 2) nodes.add(`${e.route[i]},${e.route[i + 1]}`);
  const useCount = new Map<string, number>();
  for (const e of lastEdges)
    for (let i = 0; i < e.route.length; i += 2) {
      const k = `${e.route[i]},${e.route[i + 1]}`;
      useCount.set(k, (useCount.get(k) ?? 0) + 1);
    }
  const coarse: { x: number; y: number; id: string }[] = [];
  for (const e of lastEdges)
    for (const i of [0, e.route.length - 2]) {
      const x = e.route[i];
      const y = e.route[i + 1];
      if (!inside(x, y) || atSite(x, y, 1)) continue;
      if ((useCount.get(`${x},${y}`) ?? 0) < 2) coarse.push({ x, y, id: e.id });
    }
  return { fine, coarse };
}

/** Terrain slope (m/m) at world (x, y), from the last area's DEMs. */
let slopeAt: (x: number, y: number) => number = () => NaN;
/** Water depth (m, ≤ 0 = dry) at world (x, y). */
let waterAt: (x: number, y: number) => number = () => NaN;

/** Base seed: areas are reproducible (Math.random drives every fresh seed), so code versions compare on the same terrain. */
const SEED = Number(process.env.SEED ?? 1);
setNetworkMode(process.env.NET ?? 'lattice');
let areaNo = 0;

async function segments(R: number): Promise<SegmentPath[]> {
  setRegionOverride(R);
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
  const m = new ChunkManager(pool, () => {});
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
  waterAt = (x, y) => {
    const c = m.chunks.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
    if (!c?.water) return NaN;
    const i = APRON + Math.round((x - c.cx * CHUNK) / CELL);
    const j = APRON + Math.round((y - c.cy * CHUNK) / CELL);
    return c.water[j * DEM_W + i];
  };
  lastSites = [];
  lastEdges = [];
  for (const n of m.nets.values()) {
    lastSites.push(...(n.data?.sites ?? []));
    lastEdges.push(...(n.data?.edges ?? []));
  }
  const byKey = new Map<string, SegmentPath>();
  for (const c of m.chunks.values()) for (const s of c.roads ?? []) byKey.set(s.key, s);
  return [...byKey.values()];
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

const breakdown = new Map<string, number>();
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
        const k = `${'NDC'[Math.min(s.cls, t.cls)]}${'NDC'[Math.max(s.cls, t.cls)]}${fork ? ' fork' : ' sep'}`;
        marks.push({ x, y, kind: fork ? 'along' : 'sep' });
        breakdown.set(k, (breakdown.get(k) ?? 0) + Math.hypot(x - s.xy[2 * i - 2], y - s.xy[2 * i - 1]));
      }
    }
  });
  return { km: len / 1000, crossings, alongside: along / 1000 };
}

const detour = [[0, 0], [0, 0], [0, 0]];
const flat: string[] = [];
const loops = [[0, 0], [0, 0], [0, 0]];
let loopsN = 0, areaKm2 = 0, inKm = 0, loopsRaw = 0, deadFine = 0, deadCoarse = 0;
const siteCount = [0, 0, 0, 0];
const unreached = [0, 0, 0, 0];
for (const R of REGIONS) {
  let km = 0, crossings = 0, alongside = 0;
  for (let a = 0; a < AREAS; a++) {
    const raw = await segments(R);
    loopsRaw += smallLoops(raw).length;
    const segs = mergeApproaches(raw);
    const s = stats(segs);
    const lp = smallLoops(segs);
    const de = deadEnds(segs);
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
    for (const g of raw) {
      const n = g.xy.length;
      const chord = Math.hypot(g.xy[n - 2] - g.xy[0], g.xy[n - 1] - g.xy[1]);
      if (chord > 700) console.log(`  LONG segment cls ${g.cls} chord ${chord.toFixed(0)} m ${g.key}`);
    }
    deadFine += de.fine.length;
    deadCoarse += de.coarse.length;
    if (process.env.DEADLOG) for (const c of de.coarse.slice(0, 5)) console.log('  coarse dead end', c.id, Math.round(c.x), Math.round(c.y));
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
    for (const g of segs) {
      const n = g.xy.length / 2;
      const chord = Math.hypot(g.xy[2 * n - 2] - g.xy[0], g.xy[2 * n - 1] - g.xy[1]);
      let len = 0, sl = 0, ns = 0;
      for (let i = 1; i < n; i++) len += Math.hypot(g.xy[2 * i] - g.xy[2 * i - 2], g.xy[2 * i + 1] - g.xy[2 * i - 1]);
      for (let i = 0; i < n; i++) {
        const v = slopeAt(g.xy[2 * i], g.xy[2 * i + 1]);
        if (!Number.isNaN(v)) (sl += v), ns++;
      }
      if (!ns || chord < 100) continue;
      const band = sl / ns < 0.06 ? 0 : sl / ns < 0.15 ? 1 : 2;
      detour[band][0] += len;
      detour[band][1] += Math.max(0, len - 1.25 * chord);
      let wet = 0;
      for (let t = 0; t <= 20; t++) if (waterAt(g.xy[0] + ((g.xy[2 * n - 2] - g.xy[0]) * t) / 20, g.xy[1] + ((g.xy[2 * n - 1] - g.xy[1]) * t) / 20) > 0) wet++;
      if (len > 1.6 * chord) {
        loops[band][wet ? 1 : 0]++;
        if (band === 0 || !wet) flat.push(`${g.key} cls ${g.cls} chord ${chord.toFixed(0)} len ${len.toFixed(0)} slope ${(sl / ns).toFixed(3)} wet ${wet}/21`);
      }
    }
    if (process.env.DUMP) svg(segs, `${process.env.DUMP}-R${R}-${a}.svg`);
    if (process.env.SHEET) sheet(segs, lp, `${process.env.SHEET}-R${R}-${a}.svg`);
    km += s.km;
    crossings += s.crossings;
    alongside += s.alongside;
  }
  console.log([...breakdown].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(', '));
  breakdown.clear();
  console.log('excess length (> 1.25 × chord) by terrain slope <0.06 / <0.15 / steeper: ' + detour.map(([l, e]) => `${((100 * e) / l).toFixed(1)}% of ${(l / 1000).toFixed(0)} km`).join(' / '));
  console.log('detours > 1.6 × chord [dry, chord over water] by slope band: ' + JSON.stringify(loops));
  loops.forEach((d) => d.fill(0));
  for (const f of flat.slice(0, 12)) console.log('  flat detour: ' + f);
  detour.forEach((d) => d.fill(0));
  console.log(`SMALL LOOPS R=${R}: ${loopsN} in ${areaKm2} km² with ${inKm.toFixed(0)} km road → ${((100 * loopsN) / inKm).toFixed(1)} per 100 km (unmerged ${((100 * loopsRaw) / inKm).toFixed(1)})`);
  console.log(`DEAD ENDS R=${R}: drawn ${deadFine}, in the network ${deadCoarse}`);
  console.log(`UNREACHED R=${R} town/village/hamlet/farm: ${unreached.map((u, i) => `${u}/${siteCount[i]}`).join('  ')}`);
  siteCount.fill(0);
  unreached.fill(0);
  deadFine = 0;
  deadCoarse = 0;
  loopsRaw = 0;
  loopsN = 0; areaKm2 = 0; inKm = 0;
  flat.length = 0;
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
  const col = ['#d0302a', '#e0a020', '#555'];
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${((x1 - x0) * k).toFixed(0)}" height="${((y1 - y0) * k).toFixed(0)}" style="background:#fbfaf5">`];
  for (const m of marks)
    out.push(m.kind === 'cross' ? `<circle cx="${X(m.x)}" cy="${Y(m.y)}" r="8" fill="none" stroke="#c0f" stroke-width="2"/>` : `<circle cx="${X(m.x)}" cy="${Y(m.y)}" r="3" fill="${m.kind === 'along' ? '#f88' : '#8cf'}"/>`);
  for (const s of segs) {
    const pts: string[] = [];
    for (let i = 0; i < s.xy.length; i += 2) pts.push(`${X(s.xy[i])},${Y(s.xy[i + 1])}`);
    const hue = [...s.key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
    out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${process.env.HUE ? `hsl(${hue},70%,40%)` : col[s.cls]}" stroke-width="${[3, 2, 1.2][s.cls]}"/>`);
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
    for (const g of segs) {
      let near = false;
      for (let i = 0; i < g.xy.length && !near; i += 2) near = Math.abs(g.xy[i] - l.x) < half * 1.5 && Math.abs(g.xy[i + 1] - l.y) < half * 1.5;
      if (!near) continue;
      const hue = [...g.key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
      const pts: string[] = [];
      for (let i = 0; i < g.xy.length; i += 2) pts.push(`${g.xy[i].toFixed(1)},${g.xy[i + 1].toFixed(1)}`);
      out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="hsl(${hue},75%,42%)" stroke-width="${[7, 5, 3][g.cls]}" stroke-opacity="0.75"/>`);
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
