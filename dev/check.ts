// Dev tool: the spec's invariants, checked against the drawn map on seeded areas.
// The motorways (SPEC §3.5.1) and the symbols and ramps against what the map draws
// round them (§3.8, §3.5.1): the seams between the tiers, where each tier's own rules
// are kept but nothing checks them against what a later tier adds. The road network's
// own defects are measured by dev/roadstats.ts, and street plans on synthetic land by
// test/town.test.ts; this leaves both alone.
//   npx vite-node dev/check.ts [areas per region] [R,R,...]
// SEED=n picks the areas, as roadstats (the same n gives the same land, so versions
// compare); HASHSEED=n seeds the world from position instead, so a violation opens in
// the browser at ?at=x,y&seed=n. LOG=1 prints every violation, not just the counts.
// SNAP=<file> checks one snapshot's own land where it was taken, instead of seeded
// areas: what you saw on the map, put to the same rules.
// Exits non-zero where a count is over its budget, and it is the only run that does:
// the budgets live in dev/judge.ts, and ROADS=<file> judges a dev/roadstats.ts run's
// rates (MEASURE=<file> there) in the same pass, so one command says yes or no.
// Lowering the budgets is the work.
import { ChunkManager } from '../src/chunks/manager';
import {
  FIT_MOTORWAY,
  lineDistance,
  Motorways,
  MW_ANGLE,
  MW_BRIDGE_FREE,
  MW_EDGE,
  MW_END_CLEAR,
  MW_END_HEAD,
  MW_END_TAIL,
  MW_PLAN_CLEAR,
  MW_SITE,
  MW_VERTEX,
  MW_WIDTH,
  MotorwayLookup,
} from '../src/gen/motorway';
import { motorwayTerminus, vertexPos } from '../src/gen/lattice';
import { CoarseField } from '../src/gen/hydro';
import { NET_REACH } from '../src/gen/roads';
import { expand, SeedStore, SeedView } from '../src/gen/seeds';
import { FARM, HAMLET, Settlements } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import { BUILT_CLEAR, CROSS, placePois, STREET_CLEAR as POI_STREET_CLEAR, WAY_CLEAR, type Poi } from '../src/gen/poi';
import { segQuadDist } from '../src/gen/buildings';
import { NODE } from '../src/gen/hydro';
import { classifyMotorways, MW_LEVEL, MW_TUNNEL } from '../src/render/motorway';
import { CHUNK } from '../src/lib/constants';
import { rng } from '../src/lib/hash';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';
import { applySnap, snap } from './snap';
import { JUDGE_KM, judgeRoad, judgeSeam, type RoadRegion, SEAM_BUDGETS } from './judge';

const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync(file: string, enc: 'utf8'): string };

declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): void };

const AREAS = Number(process.argv[2] ?? 3);
const REGIONS = (process.argv[3] ?? '0.15,0.3,0.45,0.6').split(',').map(Number);
const SIZE = 3000;
const SEED = Number(process.env.SEED ?? 1);
const LOG = !!process.env.LOG;

/** What the snap guarantees a drawn junction: the fit's own clearance (motorway.ts). */
const MW_SNAP_CLEAR = FIT_MOTORWAY;
/** What a plan's own symbol (a water tower, a reservoir) keeps from every way and building (§3.8). */
const PLAN_POI_CLEAR = 15;
/** Margin round an area to gather hamlet and farm sites in: more than any plan's extent. */
const SITE_PAD = 2000;
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
 * What the run actually looked at, so a count of 0 can be told from nothing to count: a
 * check over land with no settlement in it has no building to stand a symbol in.
 */
const seen = { symbols: 0, planSymbols: 0, buildings: 0, streetKm: 0, rampKm: 0, lowSites: 0, siteless: 0 };
const seenPlans = new Set<string>();

type Hit = { check: string; x: number; y: number; note: string };
const hits = new Map<string, Hit>();
const add = (check: string, x: number, y: number, note: string) =>
  hits.set(`${check}:${Math.round(x / 8)},${Math.round(y / 8)}`, { check, x, y, note });

/** A hilltop symbol stands on a fine node; a wayside cross stands off one, beside a junction. */
const onNode = (q: Poi) => Math.abs(q.x / NODE - Math.round(q.x / NODE)) < 1e-6 && Math.abs(q.y / NODE - Math.round(q.y / NODE)) < 1e-6;

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
async function checkArea(R: number, areaNo: number): Promise<{ km: number; km2: number }> {
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
      return { km: 0, km2: 0 };
    }
  }
  const x = Math.round(on[0] - SIZE / 2);
  const y = Math.round(on[1] - SIZE / 2);
  const view = { x0: x, y0: y, x1: x + SIZE, y1: y + SIZE };
  for (let i = 0; i < 40000 && !m.covered(view); i++) {
    m.update(view, view, [x + SIZE / 2, y + SIZE / 2]);
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * The sites a hamlet or a farm may not stand on (§3.5.1 A barrier): the network leaves a
   * site within MW_SITE of a motorway out, so the drawn world should hold no plan for one.
   * Checked by site id, because a plan's centre is its crossroads and a farmstead's is its
   * vertex — neither is the site the rule judges, and a distance measured at the centre
   * would be measuring the wrong point, which is the mistake `mw-vertex` made twice. The
   * sites and the motorways are rebuilt from the same seeds the pipeline used (both are
   * pure functions of them), and the lookup is given the terminus run-ons latticeCell gives
   * it, so a site beside a terminus counts as near as the network counts it.
   */
  const sview = new SeedView(m.seeds.payloadFor(view, expand(view, NET_REACH)));
  const sterrain = new Terrain(sview);
  const sfield = new CoarseField(sterrain, sview);
  const sset = new Settlements(sfield, sterrain, sview);
  const slook = new MotorwayLookup(new Motorways(sfield, sterrain, sset, sview), (px, py, tx, ty) => vertexPos(motorwayTerminus(px, py, tx, ty)));
  const siteOff = new Map<string, { x: number; y: number; off: number }>();
  for (const rank of [HAMLET, FARM] as const)
    for (const q of sset.sitesIn(rank, view.x0 - SITE_PAD, view.y0 - SITE_PAD, view.x1 + SITE_PAD, view.y1 + SITE_PAD))
      siteOff.set(q.id, { x: q.x, y: q.y, off: slook.dist(q.x, q.y) });

  let km = 0;
  let km2 = 0;
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
    const { roads, motorways, motorwayEnds, plans, poi, edges } = d;
    const inChunk = (px: number, py: number) => px >= cx0 && py >= cy0 && px < cx0 + CHUNK && py < cy0 + CHUNK;
    // What the render draws, and what it hands its symbols: the network's segments the
    // plans did not redraw, plus the plans' own pieces (render/chunkRender.ts). The raw
    // segments still hold roads a plan has replaced or dropped, so a check reading them
    // judges a map nobody sees — which is what this tool exists not to do.
    const redrawn = new Set(plans.flatMap((p) => p.replaced));
    const drawn = [...roads.filter((r) => !redrawn.has(r.key)), ...plans.flatMap((p) => p.roads)];
    const ramps = drawn.filter((r) => r.ramp);
    const ways = drawn.filter((r) => !r.ramp);
    const streets = plans.flatMap((p) => p.streets);
    const rampLines = ramps.map((r) => Float64Array.from(r.xy));
    const buildings: number[][] = [];
    for (const pl of plans) for (let k = 0; k < pl.buildings.length; k += 8) buildings.push(Array.from(pl.buildings.subarray(k, k + 8)));
    const pois = poi ? placePois({ cx: c.cx, cy: c.cy, patch: poi, roads: drawn, plans, motorways: [...motorways, ...rampLines] }) : [];
    km2 += (CHUNK * CHUNK) / 1e6;
    for (const pl of plans)
      if (!seenPlans.has(pl.id)) {
        seenPlans.add(pl.id);
        seen.buildings += pl.buildings.length / 8;
        const need = MW_SITE[pl.rank] ?? 0;
        if (need) {
          const q = siteOff.get(pl.id);
          // No site of its own found means the margin above is too small for this plan, and
          // the check passed over it rather than holding: counted, not swallowed.
          if (!q) seen.siteless++;
          else if (q.off < need)
            add('mw-site', q.x, q.y, `a ${pl.rank === HAMLET ? 'hamlet' : 'farm'} drawn on a site ${q.off.toFixed(0)} m from the motorway (MW_SITE ${need} m)`);
          else seen.lowSites++;
        }
      }
    for (const q of pois) if (inChunk(q.x, q.y)) seen.symbols++;
    for (const pl of plans) for (const q of pl.pois) if (inChunk(q.x, q.y)) seen.planSymbols++;
    for (const t of streets) for (let i = 2; i < t.xy.length; i += 2) if (inChunk(t.xy[i], t.xy[i + 1])) seen.streetKm += Math.hypot(t.xy[i] - t.xy[i - 2], t.xy[i + 1] - t.xy[i - 1]) / 1000;
    for (const r of ramps) for (let i = 2; i < r.xy.length; i += 2) if (inChunk(r.xy[i], r.xy[i + 1])) seen.rampKm += Math.hypot(r.xy[i] - r.xy[i - 2], r.xy[i + 1] - r.xy[i - 1]) / 1000;

    // §3.8: a symbol stands clear of the buildings and streets on the map. placePois keeps
    // it clear of the plans it is handed; this asks whether those were every plan drawing
    // into the chunk — a plan it never saw is a building the symbol can stand in.
    for (const q of pois) {
      if (!inChunk(q.x, q.y)) continue;
      let bd = Infinity;
      for (const b of buildings) bd = Math.min(bd, segQuadDist(q.x, q.y, q.x, q.y, b));
      if (bd < BUILT_CLEAR) add('poi-on-building', q.x, q.y, `a symbol ${bd.toFixed(0)} m from a building (${BUILT_CLEAR} m)`);
      for (const t of streets) {
        const sd = toLine(t.xy, q.x, q.y);
        if (sd < POI_STREET_CLEAR) add('poi-on-building', q.x, q.y, `a symbol ${sd.toFixed(0)} m from a street (${POI_STREET_CLEAR} m)`);
      }
    }

    // §3.8: a wayside cross is set beyond its junction's ways, by their own clearance. (A
    // hilltop symbol has no such rule — a chapel may stand beside a road.)
    for (const q of pois) {
      if (q.kind !== CROSS || onNode(q) || !inChunk(q.x, q.y)) continue;
      for (const o of ways) {
        const wd = toLine(o.xy, q.x, q.y);
        if (wd < WAY_CLEAR[o.cls]) add('poi-on-way', q.x, q.y, `a wayside cross ${wd.toFixed(1)} m into a ${'NDCTP'[o.cls]} way (${WAY_CLEAR[o.cls]} m)`);
      }
    }

    // A plan's own symbol (a water tower, a reservoir) is placed by planTown against that
    // plan's ways and buildings — on synthetic land in test/town.test.ts, and never against
    // the plans next to it, the motorways or the ramps. Nothing downstream moves it.
    for (const pl of plans)
      for (const q of pl.pois) {
        if (!inChunk(q.x, q.y)) continue;
        let bd = Infinity;
        for (const other of plans) {
          if (other === pl) continue;
          for (let k = 0; k < other.buildings.length; k += 8) bd = Math.min(bd, segQuadDist(q.x, q.y, q.x, q.y, Array.from(other.buildings.subarray(k, k + 8))));
          for (const t of other.streets) bd = Math.min(bd, toLine(t.xy, q.x, q.y));
        }
        if (bd < PLAN_POI_CLEAR) add('plan-poi-clear', q.x, q.y, `${pl.id}: its symbol ${bd.toFixed(0)} m from another plan's building or street (${PLAN_POI_CLEAR} m)`);
        const lines = [...motorways, ...rampLines];
        const md = lines.length ? Math.min(...lines.map((xy) => toLine(xy, q.x, q.y))) : Infinity;
        if (md < MW_PLAN_CLEAR) add('plan-poi-clear', q.x, q.y, `${pl.id}: its symbol ${md.toFixed(0)} m from a motorway or ramp`);
      }

    // Ramps come with the motorways, after the plans: a plan keeps its buildings and
    // streets off a motorway's centre line (§3.5.1 Plans) but cannot keep them off a ramp,
    // which did not exist when it was laid out.
    for (const r of ramps) {
      for (let i = 2; i < r.xy.length; i += 2) {
        if (!inChunk(r.xy[i], r.xy[i + 1])) continue;
        for (const b of buildings) {
          const bd = segQuadDist(r.xy[i - 2], r.xy[i - 1], r.xy[i], r.xy[i + 1], b);
          if (bd < MW_PLAN_CLEAR) add('ramp-building', r.xy[i], r.xy[i + 1], `a ramp ${bd.toFixed(0)} m from a building (${MW_PLAN_CLEAR.toFixed(0)} m)`);
        }
      }
      for (const t of streets) for (const q of crossings(r.xy, [Float64Array.from(t.xy)])) if (inChunk(q.x, q.y)) add('ramp-street', q.x, q.y, 'a ramp crosses a street');
    }

    if (!motorways.length) continue;
    const mws = classifyMotorways(motorways, poi, motorwayEnds);
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

    const mwLines = mws.map((q) => q.xy);
    /**
     * The same chains with the terminus approach cut off, for the vertex and the alongside rule
     * both. Where a motorway runs on to a terminus the network stops seeing it MW_END_CLEAR short
     * of the ring (runOns in motorway.ts), and that is not an oversight: MW_END_CLEAR is
     * MW_END_RING + MW_END_SPLIT, so the stretch left out is the roundabout and the lanes flaring
     * onto it — which roads are meant to reach, and which no vertex rule can keep them off. The
     * drawing draws that stretch, so measuring a vertex against the drawn chain reads a
     * legitimate junction near a terminus as a violation. The drawn junction is still held
     * MW_SNAP_CLEAR out and mw-junction below still checks it. Each cut chain keeps the vertex it
     * starts at, since a level (tunnel, viaduct, at grade) is read off the uncut chain's own cls.
     */
    const vertexCut = mws.map((q, li) => {
      const flags = motorwayEnds[li] ?? 0;
      const xy = q.xy;
      let a = 0;
      let b = xy.length / 2 - 1;
      const seg = (i: number) => Math.hypot(xy[2 * i + 2] - xy[2 * i], xy[2 * i + 3] - xy[2 * i + 1]);
      if (flags & MW_END_HEAD) for (let d = 0; a < b && d < MW_END_CLEAR; a++) d += seg(a);
      if (flags & MW_END_TAIL) for (let d = 0; b > a && d < MW_END_CLEAR; b--) d += seg(b - 1);
      return { xy: b > a ? xy.slice(2 * a, 2 * b + 2) : new Float64Array(0), a };
    });
    const vertexLines = vertexCut.map((v) => v.xy);

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
      // The drawing snaps a junction onto gentler, dry ground and keeps it only
      // MW_SNAP_CLEAR out, so a drawn junction may sit between the two rules.
      // That gap is real: closing it would push vertices back onto wet or steep ground.
      const off = Math.min(...mwLines.map((xy) => toLine(xy, e.x, e.y)));
      if (off < MW_SNAP_CLEAR) add('mw-junction', e.x, e.y, `a junction of ${e.n} ways drawn ${off.toFixed(0)} m from the motorway`);
    }
    // The network's rule, on the network's own vertices. edgeCostRaw gives an edge
    // Infinity where either endpoint is within MW_VERTEX of a motorway, so no used edge
    // may touch such a vertex — degree 1 is already a violation, not just a junction.
    // A lattice edge's route starts and ends at its two vertices, unsnapped; reading the
    // nearest vertex to a *drawn* junction instead would be unsound, since vertices sit
    // as little as 30 m apart (LATTICE 150 m, JITTER 0.4) while the snap moves a junction
    // up to VSNAP fine nodes, so the vertex nearest where it ended up is not always the
    // one the ways meet at. That is what an earlier version of this check did, and the
    // two hits it reported were both of its own making.
    for (const route of edges) {
      const n = route.length;
      if (n < 4) continue;
      for (const [vx, vy] of [[route[0], route[1]], [route[n - 2], route[n - 1]]]) {
        if (!inChunk(vx, vy)) continue;
        let bi = -1, bk = -1, lat = Infinity;
        vertexLines.forEach((xy, li) => {
          for (let k = 0; k + 3 < xy.length; k += 2) {
            const dd = toLine(xy.subarray(k, k + 4), vx, vy);
            if (dd < lat) [lat, bi, bk] = [dd, li, k];
          }
        });
        if (lat < MW_VERTEX) {
          // Where along the chain, since a hit near one of its ends is the terminus
          // approach and a hit in the middle of a run is something else.
          const xy = vertexLines[bi];
          let before = 0, total = 0;
          for (let k = 0; k + 3 < xy.length; k += 2) {
            const seg = Math.hypot(xy[k + 2] - xy[k], xy[k + 3] - xy[k + 1]);
            if (k < bk + 2) before += seg;
            total += seg;
          }
          add('mw-vertex', vx, vy, `a lattice vertex carrying a way ${lat.toFixed(0)} m from the motorway` +
            ` (${Math.min(before, total - before).toFixed(0)} m from the chain's nearest end, ends ${motorwayEnds[bi] ?? 0},` +
            ` level ${mws[bi].cls[bk / 2 + vertexCut[bi].a]})`);
        }
      }
    }
    /**
     * Where a lattice chord crosses: the bridge the network's exemption is for. edgeCostRaw
     * lets a crossing edge off the MW_EDGE rule, and §3.5.1 bounds what that buys to
     * MW_BRIDGE_FREE of where the *vertices' line* crosses — so that stretch, and not some
     * radius round where the drawn curve crosses, is the one a way is entitled to run close
     * in. An edge's route starts and ends at its two unsnapped vertices (see the vertex rule
     * above), so the chord between them is the network's own. The crossings are collected for
     * the chunk rather than per way: a way is fitted to one chord but nothing here maps the
     * one to the other, and a bridge is a place on the motorway either way.
     */
    const bridges: { x: number; y: number }[] = [];
    for (const route of edges) {
      const n = route.length;
      if (n < 4) continue;
      bridges.push(...crossings(Float64Array.of(route[0], route[1], route[n - 2], route[n - 1]), mwLines));
    }
    for (const o of ways) {
      const cross = crossings(o.xy, mwLines);
      for (const q of cross)
        if (inChunk(q.x, q.y) && Math.min(q.angle, Math.PI - q.angle) < MW_ANGLE)
          add('mw-cross-angle', q.x, q.y, `a ${'NDCTP'[o.cls]} way crosses at ${((180 / Math.PI) * Math.min(q.angle, Math.PI - q.angle)).toFixed(0)}°`);
      const along: { i: number; off: number; bridge: number }[] = [];
      for (let i = 0; i < o.xy.length; i += 2) {
        const px = o.xy[i], py = o.xy[i + 1];
        if (!inChunk(px, py)) continue;
        // On the stretches the network sees, and at grade: off a terminus approach, which
        // vertexCut takes out above, and off a tunnel or a viaduct, where the way passes
        // under or over the motorway rather than beside it.
        let off = Infinity, cls = MW_LEVEL;
        vertexCut.forEach((v, li) => {
          for (let k = 0; k + 3 < v.xy.length; k += 2) {
            const dd = toLine(v.xy.subarray(k, k + 4), px, py);
            if (dd < off) [off, cls] = [dd, mws[li].cls[k / 2 + v.a]];
          }
        });
        if (off >= MW_EDGE || cls !== MW_LEVEL) continue;
        // How far the nearest bridge is, reported with the hit: inside MW_BRIDGE_FREE the
        // run is entitled to be there, and just outside it the hit is edgeCostRaw's
        // unbounded exemption showing through (§3.5.1 Open), which reads differently from
        // a hit with no crossing for a kilometre.
        const bridge = Math.min(Infinity, ...bridges.map((q) => Math.hypot(q.x - px, q.y - py)));
        if (bridge < MW_BRIDGE_FREE) continue;
        along.push({ i, off, bridge });
      }
      // The run alongside, not every 8 m of it: add() keys a hit to an 8 m cell, so one way
      // running 97 m in counted as twelve defects. A run is the way's consecutive vertices,
      // reported at its closest, with how far it holds.
      for (let j = 0; j < along.length; ) {
        let e = j;
        while (e + 1 < along.length && along[e + 1].i === along[e].i + 2) e++;
        let len = 0;
        for (let k = j + 1; k <= e; k++)
          len += Math.hypot(o.xy[along[k].i] - o.xy[along[k - 1].i], o.xy[along[k].i + 1] - o.xy[along[k - 1].i + 1]);
        const worst = along.slice(j, e + 1).reduce((a, b) => (b.off < a.off ? b : a));
        add('mw-alongside', o.xy[worst.i], o.xy[worst.i + 1],
          `a ${'NDCTP'[o.cls]} way ${worst.off.toFixed(0)} m from the motorway for ${len.toFixed(0)} m, not crossing` +
          ` (nearest bridge ${worst.bridge === Infinity ? 'none' : worst.bridge.toFixed(0) + ' m'})`);
        j = e + 1;
      }
    }

    // §3.8: no symbol on a motorway or a ramp.
    const near = lineDistance([...mwLines, ...rampLines], MW_PLAN_CLEAR);
    for (const q of pois) if (inChunk(q.x, q.y) && near(q.x, q.y) < MW_PLAN_CLEAR) add('poi-on-mw', q.x, q.y, `a symbol ${near(q.x, q.y).toFixed(0)} m from the motorway`);

  }
  return { km, km2 };
}

let km = 0;
let km2 = 0;
const tally = (r: { km: number; km2: number }) => ((km += r.km), (km2 += r.km2));
if (snap) tally(await checkArea(0, 0));
else for (const R of REGIONS) for (let a = 0; a < AREAS; a++) tally(await checkArea(R, a));

const counts = new Map<string, number>();
for (const h of hits.values()) counts.set(h.check, (counts.get(h.check) ?? 0) + 1);
if (LOG) for (const h of [...hits.values()].sort((a, b) => a.check.localeCompare(b.check))) console.log(`  ${h.check} at ?at=${Math.round(h.x)},${Math.round(h.y)}  ${h.note}`);
console.log(
  `\nINVARIANTS: ${snap ? `the snapshot's land` : `${REGIONS.length * AREAS} areas`} of ${SIZE / 1000} km, ${km2.toFixed(0)} km² of land drawn, ${km.toFixed(1)} km of motorway in it`,
);
let over = 0;
for (const check of Object.keys(SEAM_BUDGETS)) {
  const v = judgeSeam(check, counts.get(check) ?? 0, km, km2);
  if (v.over) over++;
  console.log(v.line);
}
console.log(
  `  looked at ${seen.symbols} symbols and ${seen.planSymbols} a plan's, ${seenPlans.size} plans with ${seen.buildings} buildings` +
    ` and ${seen.streetKm.toFixed(1)} km of street, ${seen.rampKm.toFixed(1)} km of ramp` +
    `, ${seen.lowSites} hamlet and farm sites${seen.siteless ? ` (${seen.siteless} whose own site the margin missed)` : ''}`,
);
/**
 * The network's own defects, measured by dev/roadstats.ts and judged here: its rates are
 * per region, because they move with the land by more than a regression would, and a
 * region with too little road in its areas is reported and not judged, so a quick look
 * cannot fail for being quick. Without a file this run judges the seams alone and says
 * so, rather than letting a silent half-verdict read as a pass.
 */
if (process.env.ROADS) {
  const regions = JSON.parse(readFileSync(process.env.ROADS, 'utf8')) as RoadRegion[];
  for (const t of regions) {
    const thin = t.inKm < JUDGE_KM;
    console.log(
      `\nROAD DEFECTS R=${t.R}: ${t.areas} area(s) of ${t.size / 1000} km, ${t.km2.toFixed(0)} km² holding ${t.inKm.toFixed(0)} km of road` +
        ` (${t.km.toFixed(0)} km drawn in all), ${t.sites} settlements and farms` +
        (thin ? ` — under the ${JUDGE_KM} km a rate needs, so measured and not judged` : ''),
    );
    for (const d of t.rows) {
      const v = judgeRoad(d, t.R, thin);
      if (v.over) over++;
      console.log(v.line);
    }
  }
  console.log(`  from ${process.env.ROADS}, ${regions.length} region(s) of road measurements`);
} else {
  console.log('\n  (seams only: no road measurements handed over. MEASURE=<file> npx vite-node dev/roadstats.ts, then ROADS=<file> here.)');
}
console.log(over ? `\n${over} check(s) over budget.` : '\nEverything judged is within budget.');
process.exit(over ? 1 : 0);
