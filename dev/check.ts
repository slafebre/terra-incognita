// Dev tool: the spec's invariants, checked against the drawn map on seeded areas.
// Phase 1 covers the motorways (SPEC §3.5.1); the road network's own defects are
// measured by dev/roadstats.ts, which this leaves alone.
//   npx vite-node dev/check.ts [areas per region] [R,R,...]
// SEED=n picks the areas, as roadstats (the same n gives the same land, so versions
// compare); HASHSEED=n seeds the world from position instead, so a violation opens in
// the browser at ?at=x,y&seed=n. LOG=1 prints every violation, not just the counts.
// SNAP=<file> checks one snapshot's own land where it was taken, instead of seeded
// areas: what you saw on the map, put to the same rules.
// Exits non-zero where a count is over its budget: BUDGETS holds what is tolerated
// today, and lowering them is the work.
import { ChunkManager } from '../src/chunks/manager';
import { MW_PLAN_CLEAR, MW_WIDTH, Motorways, lineDistance } from '../src/gen/motorway';
import { CoarseField } from '../src/gen/hydro';
import { nearestVertex, vertexPos } from '../src/gen/lattice';
import { NET_REACH } from '../src/gen/roads';
import { expand, SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import { placePois } from '../src/gen/poi';
import { classifyMotorways, MW_LEVEL, MW_TUNNEL } from '../src/render/motorway';
import { CHUNK } from '../src/lib/constants';
import { rng } from '../src/lib/hash';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';
import { applySnap, snap } from './snap';

declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): void };

const AREAS = Number(process.argv[2] ?? 3);
const REGIONS = (process.argv[3] ?? '0.15,0.3,0.45,0.6').split(',').map(Number);
const SIZE = 3000;
const SEED = Number(process.env.SEED ?? 1);
const LOG = !!process.env.LOG;

/** The spec's distances, by the rule each belongs to (SPEC §3.5.1). */
const MW_VERTEX = 50;
const MW_EDGE = 30;
/** What the snap guarantees a drawn junction (FIT_MOTORWAY in lattice.ts). */
const MW_SNAP_CLEAR = 28;
const MW_CROSS_ANGLE = (35 * Math.PI) / 180;
/** A way counts as crossing (rather than running alongside) within this far of a crossing. */
const CROSS_NEAR = 60;
/** How far around a random point to look for a motorway to stand the area on (m). */
const FIND = Number(process.env.FIND ?? 24000);

/**
 * A motorway near a random point, from the same seeds the pipeline will use (the store
 * hands out each seed once and keeps it). Areas are stood on one: at ~1.4 km of motorway
 * per 100 km² a 3 km area picked at random holds none, and the run checks nothing.
 */
function motorwayNear(seeds: SeedStore, x: number, y: number): [number, number] | undefined {
  const r = { x0: x - FIND, y0: y - FIND, x1: x + FIND, y1: y + FIND };
  const view = new SeedView(seeds.payloadFor(r, expand(r, NET_REACH)));
  const t = new Terrain(view);
  const field = new CoarseField(t, view);
  const mw = new Motorways(field, t, new Settlements(field, t, view), view);
  let best: [number, number] | undefined;
  let bd = Infinity;
  for (const p of mw.piecesIn(r.x0, r.y0, r.x1 - 1, r.y1 - 1))
    for (let i = 0; i < p.xy.length; i += 2) {
      const d = Math.hypot(p.xy[i] - x, p.xy[i + 1] - y);
      if (d < bd) [bd, best] = [d, [p.xy[i], p.xy[i + 1]]];
    }
  return best;
}

/**
 * What each count is allowed to be over the whole run, and why. Zero means the invariant
 * is meant to hold outright; a number is a defect the spec already records as tolerated,
 * or one not yet fixed — see SPEC §3.5.1 Open.
 */
const BUDGETS: Record<string, number> = {
  'mw-end-tunnel': 0, // a motorway ending inside a tunnel: the drawing stops at the portal
  'mw-vertex': 0, // the lattice vertex of a junction within MW_VERTEX: the network's own rule
  'mw-junction': 0, // the junction as drawn within MW_SNAP_CLEAR: what the snap guarantees
  'poi-on-mw': 0, // a symbol on the carriageway or a ramp
  'ramp-merge': Infinity, // merging on a viaduct or in a tunnel: ramps are not fitted to the terrain
  'ramp-crossing': Infinity, // a ramp crossed without a junction: the network cannot see ramps
  'mw-alongside': Infinity, // a way within MW_EDGE without crossing
  'mw-cross-angle': Infinity, // a crossing shallower than 35°
};

type Hit = { check: string; x: number; y: number; note: string };
const hits = new Map<string, Hit>();
const add = (check: string, x: number, y: number, note: string) =>
  hits.set(`${check}:${Math.round(x / 8)},${Math.round(y / 8)}`, { check, x, y, note });

/** Distance from a point to a polyline, and how far along it the nearest point lies. */
function toLine(xy: ArrayLike<number>, x: number, y: number): number {
  let best = Infinity;
  for (let i = 2; i < xy.length; i += 2) {
    const ax = xy[i - 2], ay = xy[i - 1], bx = xy[i], by = xy[i + 1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}
/** Where two segments meet, or null. */
function meet(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const r1 = bx - ax, r2 = by - ay, s1 = dx - cx, s2 = dy - cy;
  const den = r1 * s2 - r2 * s1;
  if (!den) return null;
  const t = ((cx - ax) * s2 - (cy - ay) * s1) / den;
  const u = ((cx - ax) * r2 - (cy - ay) * r1) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: ax + t * r1, y: ay + t * r2, angle: Math.abs(Math.atan2(r1 * s2 - r2 * s1, r1 * s1 + r2 * s2)) };
}
/** Every place a way meets a motorway centre line, and at what angle. */
function crossings(way: ArrayLike<number>, lines: Float64Array[]) {
  const out: { x: number; y: number; angle: number }[] = [];
  for (let i = 2; i < way.length; i += 2)
    for (const xy of lines)
      for (let k = 2; k < xy.length; k += 2) {
        const q = meet(way[i - 2], way[i - 1], way[i], way[i + 1], xy[k - 2], xy[k - 1], xy[k], xy[k + 1]);
        if (q) out.push(q);
      }
  return out;
}

/** One area: builds the land, then checks every chunk's drawn world as the renderer sees it. */
async function checkArea(R: number, areaNo: number): Promise<number> {
  if (!snap) setRegionOverride(R);
  Math.random = rng(SEED * 7919 + areaNo * 104729 + Math.round(R * 1000));
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
          const r: TaskResult = task.kind === 'render' ? { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 } : runTask(task).result;
          this.busy--;
          resolve(r);
          queueMicrotask(() => m.schedule());
        }, 0),
      );
    },
  };
  const m = new ChunkManager(pool, () => {}, snap ? (snap.seed ?? undefined) : process.env.HASHSEED === undefined ? undefined : Number(process.env.HASHSEED) >>> 0);
  if (snap) applySnap(m.seeds);
  let on: [number, number] | undefined;
  if (snap) on = [snap.at[0], snap.at[1]];
  else {
    const rx = Math.round((Math.random() - 0.5) * 2e6);
    const ry = Math.round((Math.random() - 0.5) * 2e6);
    on = motorwayNear(m.seeds, rx, ry);
    if (!on) {
      console.log(`  R=${R} area ${areaNo}: no motorway within ${FIND / 1000} km of ${rx},${ry} — skipped`);
      return 0;
    }
  }
  const x = Math.round(on[0] - SIZE / 2);
  const y = Math.round(on[1] - SIZE / 2);
  const view = { x0: x, y0: y, x1: x + SIZE, y1: y + SIZE };
  for (let i = 0; i < 40000 && !m.covered(view); i++) {
    m.update(view, view, [x + SIZE / 2, y + SIZE / 2]);
    await new Promise((r) => setTimeout(r, 0));
  }

  let km = 0;
  for (const c of m.chunks.values()) {
    if (!c.roads || !c.dem) continue;
    const cx0 = c.cx * CHUNK, cy0 = c.cy * CHUNK;
    if (cx0 < view.x0 || cy0 < view.y0 || cx0 >= view.x1 || cy0 >= view.y1) continue;
    let d;
    try {
      d = m.drawnInput(c);
    } catch {
      continue; // a neighbour not ready: another chunk covers this ground
    }
    const { roads, motorways, motorwayEnds, plans, poi } = d;
    if (!motorways.length) continue;
    const mws = classifyMotorways(motorways, poi, motorwayEnds);
    const inChunk = (px: number, py: number) => px >= cx0 && py >= cy0 && px < cx0 + CHUNK && py < cy0 + CHUNK;
    for (const mw of mws)
      for (let i = 2; i < mw.xy.length; i += 2)
        if (inChunk(mw.xy[i], mw.xy[i + 1])) km += Math.hypot(mw.xy[i] - mw.xy[i - 2], mw.xy[i + 1] - mw.xy[i - 1]) / 1000;

    // §260: a motorway never ends inside a tunnel — the drawing stops at the portal.
    mws.forEach((mw, li) => {
      const n = mw.cls.length;
      for (const [flag, k] of [[1, 0], [2, n - 1]] as [number, number][])
        if (motorwayEnds[li] & flag && mw.cls[k] === MW_TUNNEL && inChunk(mw.xy[2 * k], mw.xy[2 * k + 1]))
          add('mw-end-tunnel', mw.xy[2 * k], mw.xy[2 * k + 1], `ground ${mw.d[k].toFixed(0)} m above the road`);
    });

    const ramps = roads.filter((r) => r.ramp);
    const ways = roads.filter((r) => !r.ramp);
    const mwLines = mws.map((q) => q.xy);
    const rampLines = ramps.map((r) => Float64Array.from(r.xy));

    // §256: a ramp merges onto the carriageway — which must be at grade there, not a
    // viaduct or a tunnel.
    for (const r of ramps) {
      const n = r.xy.length;
      const [ex, ey] = [r.xy[n - 2], r.xy[n - 1]];
      if (!inChunk(ex, ey)) continue;
      let best = Infinity, cls = MW_LEVEL, dep = 0;
      for (const mw of mws)
        for (let i = 0; i < mw.xy.length; i += 2) {
          const q = Math.hypot(mw.xy[i] - ex, mw.xy[i + 1] - ey);
          if (q < best) [best, cls, dep] = [q, mw.cls[i / 2], mw.d[i / 2]];
        }
      if (best < MW_WIDTH && cls !== MW_LEVEL)
        add('ramp-merge', ex, ey, `${cls === MW_TUNNEL ? 'in a tunnel' : 'on a viaduct'}, ground ${dep.toFixed(0)} m above the road`);
    }

    // §265 open: the network cannot see ramps, so a way may cross one without a junction.
    for (const r of ramps) {
      const ends = [[r.xy[0], r.xy[1]], [r.xy[r.xy.length - 2], r.xy[r.xy.length - 1]]];
      for (const o of ways)
        for (const q of crossings(r.xy, [Float64Array.from(o.xy)]))
          if (inChunk(q.x, q.y) && !ends.some(([ex, ey]) => Math.hypot(ex - q.x, ey - q.y) < 3))
            add('ramp-crossing', q.x, q.y, `a ramp crosses a ${'NDCTP'[o.cls]} way`);
    }

    // §251: no junction within MW_VERTEX of a motorway; no way within MW_EDGE of one
    // without crossing; a crossing at no less than 35°.
    const ends = new Map<string, { x: number; y: number; n: number }>();
    for (const o of ways) {
      const n = o.xy.length / 2;
      if (n < 2) continue;
      for (const [ex, ey] of [[o.xy[0], o.xy[1]], [o.xy[2 * n - 2], o.xy[2 * n - 1]]]) {
        const key = `${ex},${ey}`;
        const e = ends.get(key) ?? { x: ex, y: ey, n: 0 };
        e.n++;
        ends.set(key, e);
      }
    }
    for (const e of ends.values()) {
      if (e.n < 3 || !inChunk(e.x, e.y)) continue;
      // Two rules, because they are kept in two places. The network holds the lattice
      // vertex MW_VERTEX clear; the drawing snaps that vertex onto gentler ground and
      // only keeps it MW_SNAP_CLEAR out, so a drawn junction may sit between the two.
      // That gap is real: closing it would push vertices back onto wet or steep ground.
      const [vx, vy] = vertexPos(nearestVertex(e.x, e.y));
      const lat = Math.min(...mwLines.map((xy) => toLine(xy, vx, vy)));
      const off = Math.min(...mwLines.map((xy) => toLine(xy, e.x, e.y)));
      if (lat < MW_VERTEX) add('mw-vertex', e.x, e.y, `a junction of ${e.n} ways on a vertex ${lat.toFixed(0)} m from the motorway`);
      if (off < MW_SNAP_CLEAR) add('mw-junction', e.x, e.y, `a junction of ${e.n} ways drawn ${off.toFixed(0)} m from the motorway (vertex ${lat.toFixed(0)} m)`);
    }
    for (const o of ways) {
      const cross = crossings(o.xy, mwLines);
      for (const q of cross)
        if (inChunk(q.x, q.y) && Math.min(q.angle, Math.PI - q.angle) < MW_CROSS_ANGLE)
          add('mw-cross-angle', q.x, q.y, `a ${'NDCTP'[o.cls]} way crosses at ${((180 / Math.PI) * Math.min(q.angle, Math.PI - q.angle)).toFixed(0)}°`);
      for (let i = 0; i < o.xy.length; i += 2) {
        if (!inChunk(o.xy[i], o.xy[i + 1])) continue;
        const off = Math.min(...mwLines.map((xy) => toLine(xy, o.xy[i], o.xy[i + 1])));
        if (off >= MW_EDGE) continue;
        if (cross.some((q) => Math.hypot(q.x - o.xy[i], q.y - o.xy[i + 1]) < CROSS_NEAR)) continue;
        add('mw-alongside', o.xy[i], o.xy[i + 1], `a ${'NDCTP'[o.cls]} way ${off.toFixed(0)} m from the motorway, not crossing`);
      }
    }

    // §3.8: no symbol on a motorway or a ramp.
    if (poi) {
      const pois = placePois({ cx: c.cx, cy: c.cy, patch: poi, roads, plans, motorways: [...motorways, ...rampLines] });
      const near = lineDistance([...mwLines, ...rampLines], MW_PLAN_CLEAR);
      for (const q of pois) if (inChunk(q.x, q.y) && near(q.x, q.y) < MW_PLAN_CLEAR) add('poi-on-mw', q.x, q.y, `a symbol ${near(q.x, q.y).toFixed(0)} m from the motorway`);
    }

  }
  return km;
}

let km = 0;
if (snap) km = await checkArea(0, 0);
else for (const R of REGIONS) for (let a = 0; a < AREAS; a++) km += await checkArea(R, a);

const counts = new Map<string, number>();
for (const h of hits.values()) counts.set(h.check, (counts.get(h.check) ?? 0) + 1);
if (LOG) for (const h of [...hits.values()].sort((a, b) => a.check.localeCompare(b.check))) console.log(`  ${h.check} at ?at=${Math.round(h.x)},${Math.round(h.y)}  ${h.note}`);
console.log(`\nMOTORWAY INVARIANTS: ${snap ? `the snapshot's land` : `${REGIONS.length * AREAS} areas`} of ${SIZE / 1000} km, ${km.toFixed(1)} km of motorway drawn`);
let over = 0;
for (const check of Object.keys(BUDGETS)) {
  const n = counts.get(check) ?? 0;
  const b = BUDGETS[check];
  if (n > b) over++;
  const per = km > 0 ? ((10 * n) / km).toFixed(2) : '—';
  console.log(`  ${check.padEnd(16)} ${String(n).padStart(4)}   ${per.padStart(6)} per 10 km   budget ${b === Infinity ? '—' : b}${n > b ? '   OVER' : ''}`);
}
console.log(over ? `\n${over} check(s) over budget.` : '\nAll checks within budget.');
process.exit(over ? 1 : 0);
