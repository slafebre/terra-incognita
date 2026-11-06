/**
 * Dev tool support: where the budgets live, and where a run is judged (SPEC §7).
 *
 * `dev/roadstats.ts` measures the network's own defects and `dev/check.ts` the seams
 * between the tiers. Neither should also be the thing that decides whether the map
 * passes: two tools each exiting on its own budgets is two places a judgement is kept,
 * and a run of one says nothing about the other. So the budgets and the verdict are
 * here, `roadstats` measures and writes what it found (`MEASURE=<file>`), and `check`
 * is the only run that says yes or no — over its own counts, and over `roadstats`'
 * rates where it is handed them (`ROADS=<file>`).
 *
 * The two verdicts are not the same shape, and that is deliberate. A seam check is a
 * count over the whole run, because what it looks for is meant not to happen at all or
 * is a defect the spec records; a road defect is a rate per region, because those rates
 * move with the land by more than a regression would.
 */

/** A measured row: the count, what it is rated against, and by how much to scale it. */
export type Row = {
  name: string;
  n: number;
  /** The denominator (km of road, km² of land, sites): 0 where there was nothing. */
  by: number;
  /** 10 or 100: the rate is `per * n / by`. */
  per: number;
  unit: string;
  /** The count is itself a length in km, not a number of things. */
  km?: boolean;
};

/** One region of a roadstats run, as it hands it over. */
export type RoadRegion = {
  R: number;
  areas: number;
  size: number;
  km2: number;
  /** Road inside the areas, which most rows are rated against. */
  inKm: number;
  /** Road drawn in all, which the rows taken over every piece are rated against. */
  km: number;
  sites: number;
  rows: Row[];
};

/** A row's rate, or NaN where there is nothing to rate it against. */
export const rateOf = (d: Row): number => (d.by > 0 ? (d.per * d.n) / d.by : NaN);

/**
 * What is tolerated today in the network's own defects, per region type and in the row's
 * own unit. Per region because the rates move with the land by more than a regression
 * would: micro detours run ~10 per 100 km in the lowlands and ~46 in the alpine, road
 * over 1.5× its class limit 2.5 % to 13 %. One number for all four could only be the
 * alpine's, and would wave a fourfold lowland regression through. A single `[0, n]` entry
 * is a budget for every region; otherwise the run's R takes the last entry at or below
 * it. Set from the worst of three seeds plus a quarter, on three areas per region each —
 * thin, so a near miss is worth rerunning on another seed before believing it. Lowering
 * them is the work.
 */
export const ROAD_BUDGETS: Record<string, [r: number, budget: number][]> = {
  // Zero: the spec gives these outright (§3.5 no way ends in a lake, §3.4 every
  // settlement connected), and 36 areas over three seeds hold them everywhere.
  'way-in-lake': [[0, 0]],
  'unreached-site': [[0, 0]],
  'dead-end': [[0.15, 15], [0.3, 21], [0.45, 20], [0.6, 28]],
  'small-loop': [[0.15, 37], [0.3, 54], [0.45, 51], [0.6, 42]],
  // Mountains' detours re-set when steep pieces got room to wind (58.8 at worst): the
  // count rose with switchbacks the climb needs; paths longer than both 1.5× their chord
  // and 1.5× what their climb needs held at ~5 per 100 km.
  'micro-detour': [[0.15, 18], [0.3, 38], [0.45, 53], [0.6, 73.5]],
  'steep-road': [[0.15, 3.7], [0.3, 6.6], [0.45, 9.7], [0.6, 14.6]],
  // Counts of 0–8 a region that moved severalfold between seeds (one seed's land is
  // simply wetter): too few to put a rate on. Loose ceilings for every region, set to
  // catch a gross regression and to measure nothing. An undrawn edge is the extreme
  // case — 0–2 a region, where one edge alone is already ~1 per 100 km, so the ceiling
  // has to tolerate four of them to not fire on the land it was measured against.
  'wet-run': [[0, 10]],
  'undrawn-at-water': [[0, 4]],
};

export const roadBudget = (check: string, R: number): number => {
  const table = ROAD_BUDGETS[check];
  if (!table) return Infinity;
  let b = table[0][1];
  for (const [r, v] of table) if (r <= R) b = v;
  return b;
};

/**
 * A rate off a short run is mostly noise: one 3 km area holds ~47 km of road, and its
 * loop rate lands within 3 % of the budget by luck alone. A region with less road than
 * this inside its areas is reported and not judged, so a quick look can't fail for being
 * quick. Three areas give a region 100–150 km.
 */
export const JUDGE_KM = 80;

/**
 * What each seam check is allowed to be over the whole run, and why. Zero means the
 * invariant is meant to hold outright; a number is a defect the spec already records as
 * tolerated, or one not yet fixed — see SPEC §3.5.1 Open.
 */
export const SEAM_BUDGETS: Record<string, number> = {
  'mw-end-tunnel': 0, // a motorway ending inside a tunnel: the drawing stops at the portal
  'mw-vertex': 0, // the lattice vertex of a junction within MW_VERTEX: the network's own rule
  'mw-junction': 0, // the junction as drawn within MW_SNAP_CLEAR: what the snap guarantees
  'poi-on-mw': 0, // a symbol on the carriageway or a ramp
  'mw-site': 0, // a hamlet or a farm drawn on a site MW_SITE says the network leaves out
  'ramp-merge': Infinity, // merging on a structure: the slide clears every case measured, but not a merge with no grade within IC_SLIDE, nor one in a motorway end's blind stretch
  'ramp-crossing': Infinity, // a ramp crossed without a junction: the network cannot see ramps
  'mw-alongside': Infinity, // a way within MW_EDGE without crossing
  'mw-cross-angle': Infinity, // a crossing shallower than 35°
  'poi-on-building': 0, // §3.8: a symbol within BUILT_CLEAR of a building, or POI_STREET_CLEAR of a street
  'poi-on-way': 0, // §3.8: a wayside cross inside its ways' own clearance
  'plan-poi-clear': Infinity, // a plan's symbol against the world beyond its own plan
  'ramp-building': Infinity, // a ramp over a building: plans are laid out before ramps exist
  'ramp-street': Infinity, // a ramp over a street, for the same reason
};

/** Which seam checks' rates are per 100 km² of land rather than per 10 km of motorway. */
export const SEAM_PER_KM2 = new Set(['poi-on-building', 'poi-on-way', 'plan-poi-clear']);

/** A row as the measuring tool prints it: the rate, and no verdict. */
export const measuredLine = (d: Row, pad = 17): string => {
  const r = rateOf(d);
  const n = d.km ? `${d.n.toFixed(1)} km` : String(d.n);
  return `  ${d.name.padEnd(pad)} ${n.padStart(8)}   ${(Number.isNaN(r) ? '—' : r.toFixed(2)).padStart(6)} ${d.unit}`;
};

/** A road defect judged: its line, and whether it is over budget. */
export function judgeRoad(d: Row, R: number, thin: boolean): { line: string; over: boolean } {
  const b = roadBudget(d.name, R);
  const r = rateOf(d);
  const over = !thin && Number.isFinite(b) && r > b;
  return { line: `${measuredLine(d)}   budget ${Number.isFinite(b) ? b.toFixed(2) : '—'}${over ? '   OVER' : ''}`, over };
}

/**
 * A seam check judged: its line, and whether it is over budget. The verdict is on the
 * count, not the rate — the rate is printed to compare runs of different lengths by, but
 * what the budget tolerates is a number of defects over the whole run.
 */
export function judgeSeam(check: string, n: number, km: number, km2: number): { line: string; over: boolean } {
  const b = SEAM_BUDGETS[check] ?? Infinity;
  const km2Rate = SEAM_PER_KM2.has(check);
  const d: Row = { name: check, n, by: km2Rate ? km2 : km, per: km2Rate ? 100 : 10, unit: km2Rate ? 'per 100 km²' : 'per 10 km  ' };
  const over = n > b;
  return { line: `${measuredLine(d, 16)}   budget ${b === Infinity ? '—' : b}${over ? '   OVER' : ''}`, over };
}
