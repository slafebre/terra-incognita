# Topo — infinite generated topographic map

Status: milestones 1–3 implemented; milestone 4 (settlements & roads) in progress, 2026-10-19.

## 1. Product requirements (agreed)

| Topic | Decision |
|---|---|
| Interaction | Drag-pan (mouse, touch, keyboard). Fixed 1:10,000 with small zoom tweak 0.5×–2×. |
| Pan speed | Ungenerated land is never shown. Panning is clamped at the edge of finished chunks. |
| Persistence | Fully emergent: everything, terrain included, grows from retained neighbours. Anything farther than **viewport + 4 km** is forgotten. Coming back regenerates it differently. |
| Landscape | Varied regions: lowland, bocage/plateau, low mountains, alpine. Regions change character every **8–20 km**. |
| Human setting | Western/Central Europe: nucleated villages, market towns, bocage hamlets, alpine valley-floor settlement. |
| Content | Elevation, rivers, streams, lakes, land use, roads (all classes), towns, every building, **railways**, **field parcels & hedges**, **point symbols** (churches, chapels, crosses, mills, spot heights, summits, power lines). No text labels. |
| Style | French IGN Top25, adapted to 1:10k. |
| Contours | Adaptive: 5 m (index 25 m) in normal terrain, 10 m (index 50 m) where steep. Rock hatching and scree where too steep for contours. |
| Overlays | Kilometre grid only. |
| Devices | Desktop and mobile equally (touch-first, tight budgets). |
| Stack | TypeScript + Vite, Canvas2D, Web Workers. |

## 2. Units and scale

- World coordinates are metres (float64). Rendering uses chunk-local coordinates to avoid float32 precision loss.
- 1:10,000 at 96 CSS dpi means 1 CSS px ≈ **2.65 m**. With zoom 0.5×–2× that's 1.3–5.3 m/px.
- A phone viewport (390 px) covers about 1 km across. A desktop viewport (1920 px) covers about 5 km.
- **Chunk** = 512 m × 512 m (≈ 193 CSS px). This is the unit for generating, rendering and forgetting.

## 3. Architecture

```
main thread                         worker pool (N = clamp(cores-1, 1, 4))
───────────                         ─────────────────────────────────────
Viewport / input / pan clamp        Stage pipeline per chunk
ChunkManager (state, scheduling) ─▶ (terrain → … → render)
Compositor (draw ImageBitmaps)  ◀─  Chunk raster (OffscreenCanvas → ImageBitmap)
Grid overlay
```

### 3.1 Staged generation

*(Revised in milestone 2. These are the stages as implemented; later milestones add their own.)*

| Stage | Output | Runs when |
|---|---|---|
| `pre` | Uplift surface `zPre` and region R on a 16 m node grid. Batched 8 chunks per task. | Chunk is within generation rectangle + 1 chunk + 3 chunks. |
| `hydro` | Window solve centred on the chunk (§3.3). Keeps the chunk ± 16 nodes. | Every chunk within ±3 chunks has `pre`. Solves are independent, so they run fully in parallel. |
| `net` | Per 8.2 km net cell: settlement sites and road edges with coarse routes (§3.4–3.5). | Cell is within ~9.5 km of the roads rectangle. |
| `roads` | Fine road segments whose midpoint lies in the chunk. | The chunk and its 8 neighbours have `hydro`, and the net cells within 9.5 km exist. |
| `dem` | 4 m DEM, lake depth field, land cover, stream polylines, built from a blend of the 3×3 surrounding solves. | The chunk and its 8 neighbours have `hydro`, and the nearby net cells exist. |
| `render` | Raster (land cover, hillshade, contours, water, settlements, roads). | DEM exists and the 3×3 chunks have `roads`. Re-run when the zoom bucket changes. |

- Every stage is a **pure function of the seeds**; nothing depends on the order in which chunks are generated.
- The **finished set** contains chunks with a bitmap. The viewport must always lie inside it.
- Chunks outside viewport + 4.5 km + 1 chunk are forgotten. When a chunk is forgotten, its neighbours drop their DEM and bitmap, because those blended its solve.

### 3.2 Emergent generation (no global seed)

*(Revised during milestone 1. The first draft proposed conditional extrapolation plus membrane correction along borders. Forgettable lattice seeds turned out simpler and give exact continuity.)*

- All terrain noise is gradient noise on lattices from 16 km down to 8 m. A lattice point's random gradient comes from a **seed created lazily the first time land needs it**, using `Math.random`. There is no world seed.
  - Fine lattices (spacing ≤ 512 m) use one seed per chunk.
  - Coarse lattices (1–16 km) store one seed per lattice point.
- **Retention invariant:** a seed is dropped only once no retained chunk can depend on it (forget rectangle, plus the lattice spacing, the maximum domain warp, and a margin). Retained land is therefore always exactly consistent: neighbouring chunks agree bit-for-bit on shared edges.
- Once every chunk that used a seed has been forgotten, the seed goes too. Revisiting the area creates new seeds, so the terrain comes back different. Large features (16 km lattice) survive longest: they are forgotten only about 4.5 km + 16 km away.
- **Region field.** R = logistic(16 km + 8 km noise). Kinds: lowland < 0.25 < hills < 0.52 < low mountains < 0.8 < alpine. Region parameters (base elevation, amplitude, octave gain) are Catmull-Rom interpolated from R. Clamps and piecewise-linear curves are avoided because they crease the terrain.
- **Shape.**
  - Derivative-damped fBm blends into a ridged multifractal as R rises.
  - Octaves of 1 km and up are domain-warped (up to about 540 m).
  - An independent base-level field (±220 m) keeps lowlands tilted instead of forming bowls.
  - A softplus floor keeps elevations above about 20 m.
- **Performance.** Slow fields (region, base level, warp) are evaluated on a world-aligned 16 m grid and interpolated. Noise reuses each lattice cell's corner gradients between samples. Terrain takes about 14 ms per chunk in node.
- Unknown terrain beyond the generation frontier needs no special handling: it's just lattice points that don't exist yet.

### 3.3 Hydrology and erosion

*(Revised twice in milestone 2. This is the design as implemented, in `src/gen/hydro.ts`. An earlier design froze each solve's result and made later solves respect it. It produced rectangular seams wherever overlapping solves disagreed, and was replaced by blending.)*

**Grid and uplift**
- Nodes are 16 m apart. `zPre` is the terrain without octaves < 64 m, plus regional **uplift**: 0 m in lowland, 120 m in hills, 450 m in low mountains, up to 1,600 m in alpine areas.
- The eroded landscape therefore approaches the steady state of its drainage network.

**Coarse base level**
- Coarse solves (256 m nodes, same erosion law) run on a **fixed lattice of overlapping 20 km tiles** at a 10 km stride, blended bilinearly.
- This makes the base level a pure function of the coarse seeds (kept within viewport + 4.5 km + 24 km).
- Each worker caches tiles, keyed by tile and a hash of the seeds they depend on.

**Window solve (one per chunk, ±3 chunks, 224² nodes)**
1. **Outlets.**
   - Window-edge nodes drain at `max(min(zPre, coarse base), zPre − maxIncision(R))`.
   - Big coarse rivers entering the window are injected as inflows.
2. **Routing.**
   - Priority-flood filling, then stochastic routing: a lower neighbour weighted by slope².
   - The randomness is **tied to place**: a hash of the node and its chunk's seed. Overlapping solves therefore agree on routing.
3. **Four erosion passes** of route → accumulate → carve:
   - Later passes use steepest descent on the carved surface, keeping the current receiver unless another neighbour is more than 1.5× steeper.
   - Carving: `zE = max(zE(rec) + ε·d, min(zPre, zE(rec) + S·d))`, with `S = clamp(k(R)·A^-½, 3e-4, Smax(R))`.
   - `k` ranges from 0.012 (lowland) to 0.15 (alpine). `Smax` ranges from 0.18 to 1.1.
4. **Lakes.**
   - *Dammed lakes:* every chunk has a seeded 5–12% chance of a dam (1.5–25 m by region) at a place-bound site. The lake floods upstream unless it would leak.
   - *Natural lakes:* filled depressions of at least 25 nodes and 1.5 m deep.
5. **Valley floors** around channels with A ≥ 0.5 km² (floodplains, glacial U-floors). Half-width is `k·√A`, capped at 180 m.
6. **Hillslope limiter.** Lower envelope: no hillslope node sits more than 1.15·Smax·d above any neighbour, which removes cliffs.
7. **Final drainage guarantee.** A priority-flood from the outlets fills any remaining pit by a hair and routes it on. Every receiver points at an earlier-settled node, so there are no dead ends and no cycles. Accumulation is then recomputed.
8. **Output.** Only the core is kept: the chunk ± 16 nodes, i.e. the support of its blend weight.

**Blending**
- A node's elevation is the blend of the four solves whose centres surround it.
- Weights are `cos²(π/2 · distance / chunk)` per axis. They sum to 1 and have zero slope at both ends, so the blend has no creases. A weight is zero one chunk from its centre, far from any window edge.
- Lakes blend by majority (weight ≥ 0.5), with a weighted level.
- Receivers and drainage area come from the solve of the node's own chunk. A stream crossing into a chunk whose solve has a smaller catchment there is carried on downstream by the renderer.

**DEM (4 m)**
- Cubic B-spline of the blended eroded nodes.
- Plus fine terrain detail where the land wasn't carved, and up to 60% of it on steep eroded slopes.
- Lakes are flat at their level. Shorelines come from `min(level − ground, splined lake mask)`.

**Streams**
- Channels with A ≥ 0.07–0.3 km² become polylines split at heads and confluences. The threshold is continuous in R, and everything downstream of a stream head stays a stream until it reaches a lake.
- They're Gaussian-smoothed over ±3 vertices and stroked per segment with width `1.1·A^0.55` m. Wider rivers get a casing.

**Invariants (tested)**
- DEM edges and aprons are identical between neighbouring chunks.
- DEM curvature at chunk borders and through chunk middles is within 1.3× of elsewhere (no seams).
- No stream node without a receiver (no dead ends).

### 3.4 Settlements

*(Milestone 4, as implemented in `src/gen/settle.ts`. Everything is a pure function of the long-lived coarse seeds.)*

**Suitability.** Computed from the coarse eroded surface, using the nearest 256 m tile:
- Flatness relative to the region (tolerance 0.08 in lowland up to 0.3 in alpine terrain).
- Valley position: hilltops and ridges are penalised.
- River proximity: towns want real rivers, villages and hamlets are happy with streams.
- Altitude: nothing above about 1,850 m.

**Candidates.** Each rank has candidates on a seeded, jittered lattice:

| Rank | Lattice | Spacing | Keep-out from higher ranks | Min suitability |
|---|---|---|---|---|
| Town | 3 km | 6.5 km | – | 0.30 |
| Village | 0.9 km | 1.9–3.4 km (by region) | 1.7 km | 0.15 |
| Hamlet | 0.35 km | 0.65–1.1 km | 0.55 km | 0.06 |

- A candidate becomes a site if its score (suitability × seeded random) beats every same-rank candidate within its spacing, and no higher-ranked site is within the keep-out distance.
- These rules are local, so every worker agrees.
- Measured density: villages about 0.065 per km² (France averages about 1 commune per 16 km²), hamlets about 0.5 per km².
- Land within 4× a site's built-up radius is cleared of forest.
- Until milestone 5, sites render as a built-up tint plus a church symbol.

### 3.5 Road network

*(Milestone 4, as implemented in `src/gen/roads.ts`.)*

**Net cells.** Topology and coarse routes are computed per 8.2 km net cell, using coarse terrain up to 44 km around the cell. Coarse seeds are kept within viewport + 4.5 km + 52 km.

| Class | Connects | Max length | Max gradient | Symbol |
|---|---|---|---|---|
| N | towns ↔ towns (relative-neighbourhood graph) | 9 km | 7 % | red, cased |
| D | villages ↔ villages / towns (relative-neighbourhood graph) | 4.5 km | 10 % | yellow, cased |
| C | each hamlet → the nearest of: a D-road waypoint, a village or town, or a hamlet closer to that network | 1.6 km (3.2 km fallback) | 15 % | white, cased |

- Every road ends at a site or exactly on the network. A C road stops at its first contact with a D road (or with the road of the hamlet it heads for): on one of its waypoints, or one coarse node beside it, joining across. There are no dead ends, and C roads form trees draining into the network instead of running alongside other roads.
- Each cell routes all D roads near it, not only those it owns, so cells agree on where the junction waypoints are.
- **Shortcuts** (C class) densify the network. Any two points of it — waypoints or sites — 0.5–2 km apart become a candidate when the network joins them only by a long way round: more than 2× their distance, and closing a loop of at least 1.8 km. A candidate is dropped if:
  - its mean gradient is over 8 %;
  - the straight line or the routed road crosses a road (that would be a crossing without a junction);
  - its route is more than 1.5× the distance;
  - more than half of it (away from its ends) runs on or beside the network.

  Candidates are taken in order of the way round they save; one that crosses an accepted shortcut, or starts and ends within 500 m of one, is dropped. Each shortcut is owned by the cell holding its first endpoint, and decided on the network computed above (never on other cells' shortcuts).
- A route that starts or ends on a grid node starts or ends exactly there; only sites may use any of the 4 nodes around them.

**Coarse routing.** A* on 256 m nodes, 16 directions:
- Cost is distance × (1 + 4·(g/0.1)²), the same for every class so roads heading the same way pick the same corridor. Steep coarse slopes cost 8× more.
- Valley floors (on or beside a stream draining 0.3–4 km² or more) cost up to 35 % less, so roads follow valleys rather than climbing over the spurs between them. A big river (> 15 km²) costs a bridge, half on each bank.
- Costs are symmetric, and each edge carries a fixed tie-break of up to 1 %. The best path between two nodes is then unique, so roads through the same nodes share the stretch between them instead of splitting into parallel tracks on flat ground.
- A route may start and end on any of the 4 nodes around a site. Waypoints are the site and the grid nodes.

**Fine routing.** Each segment between consecutive waypoints is owned by the chunk containing its midpoint, and routed by A* over (16 m node, heading):
- Turns are limited to 45° per step, with a turn cost by class, so hairpins sweep round rather than spike.
- Gradient above the class limit is heavily penalised. Water costs 60× distance (a way round is wanted) and crossing a stream costs a bridge. All costs are symmetric.
- Waypoints are snapped locally to buildable ground.
- **Approach trees:** within ~130 m of a waypoint (less on short segments), a segment follows the cheapest-path tree grown from that waypoint. Segments that leave a waypoint the same way share its branches and fork further out, like real junctions.
- After A*, the path is string-pulled (straight wherever gentle enough, moving it at most 8 m), then resampled.
- Node data comes from each node's own-chunk solve (not the blend), so roads only depend on hydro within ±1 chunk.

**Rendering.** Segments sharing a waypoint that stay within 24 m of each other leaving it are drawn on one line until they part, for up to 240 m and 40 % of the segment's length. This uses only the segments at that waypoint, so every chunk draws a junction the same way. Each segment is then Gaussian-smoothed with endpoints fixed (more passes for N and D roads). All casings are drawn first, then fills from C up to N.

**Open.** Bridges and tunnels as symbols, sharing corridors between N and D roads, and farm and field tracks for land away from settlements (milestones 5–6).

### 3.6 Built-up areas

- **Streets** grow from the roads entering the settlement. Old cores get an organic street pattern around a church square. Towns also get grid or cul-de-sac suburbs and an industrial zone near rail or the N road.
- **Buildings** are footprint polygons aligned to the street, with setbacks. Farmyards in villages are L- or U-shaped. Industrial halls are larger. Building density and size depend on settlement rank and distance from the centre.
- **Parcels** subdivide farmland bounded by roads and tracks. Shapes depend on the region: strip fields in lowland, small irregular fields with **hedges** in bocage, terraces on steep slopes. Vineyards go on south-facing slopes at roughly 150–500 m, orchards around villages.

### 3.7 Land cover

*(Milestone 3, as implemented in `src/gen/landcover.ts` and `src/render/landcover.ts`.)*

**Fields**
- Land cover is a set of continuous fields on the 4 m DEM grid; a class is present where its field is above 0. Values are stored as Int8.
- The inputs are all chunk-consistent: the blended eroded surface (slope, aspect and topographic position from nodes, splined), the region, and seeded noise. The noise is evaluated on a world-aligned 8 m grid and interpolated.
- Class boundaries therefore match exactly across chunk borders.

**Classes, in drawing priority order**

| Class | Rule (summary) |
|---|---|
| Glacier | Above an equilibrium line of about 2,850 m, ±150 m by aspect (lower on north faces). Not on slopes over about 0.85. |
| Rock | Slope over 1.0, falling to 0.75 above 2,100–2,900 m. |
| Scree | Slope 0.5–0.95, above the treeline, on concave foot-slopes (negative topographic position). |
| Forest | Regional bias, plus noise for natural blocks, plus steepness *relative to the region's typical maximum slope*, plus topographic position. Capped by an aspect-dependent treeline (about 1,950 m ± 130 m). Conifer share rises with altitude and region. |
| Vineyard | South-facing slopes of 0.08–0.45, at 100–750 m, in hill country. |
| Wetland | Flat (slope under 0.025), concave valley bottoms and hollows, more common in lowland. |
| Heath / dwarf pine | A band from just below the treeline to about 300 m above it. |

- **Calibrated forest cover** (from `dev/coverstats.ts`): about 16% in lowland, 35–45% in hills, 55–60% in low mountains. Alpine terrain has rock about 11%, scree about 9% and heath about 24%.
- Settlement-driven land use (orchards, gardens, clearings around villages) belongs to milestones 4–5.

### 3.8 Point symbols

Church (one per village, cathedral-sized in towns), chapel, wayside cross at junctions, watermill on streams, windmill in lowland, spot heights at summits and junctions, triangulation point on major summits, viewpoints, and power lines with pylons connecting towns via substations.

## 4. Rendering (IGN Top25 adapted to 1:10k)

- **Where it runs.** Chunks are rendered **inside workers** with `OffscreenCanvas` and transferred as `ImageBitmap`. The main thread only composites and draws the kilometre grid.
- **Resolution.** Rasters are drawn at DPR, capped at 2. During a zoom gesture the bitmaps are scaled; when the gesture ends, chunks are re-rendered for the new zoom bucket.
- **Pixel pass.** Paper or land-cover fill (with anti-aliased edges), multiplied by the hillshade (light from the NW), then lake fill.
- **Contours.**
  - Adaptive interval: 5 m, dropping to 10 m where slopes are over 0.5, then index lines only, and none on cliffs (slope over 2.5).
  - Drawn at 40% opacity. On glaciers they're blue.
- **Symbols** sit on a world-aligned jittered grid, so neighbouring chunks place and classify them identically:
  - rock hachures along the fall line
  - scree stipple
  - vine dots
  - broadleaf (circle) and conifer (fir) symbols every ~40 m
  - heath circles
  - marsh tufts
- **Water.** Lake shorelines, then streams. Streams are Gaussian-smoothed polylines; wide rivers get a blue casing with a pale fill.
- **Style.** The palette lives in `src/render/style.ts`.

## 5. Performance budgets

| | Desktop | Mobile |
|---|---|---|
| Frame (pan) | 60 fps, < 4 ms main-thread | 60 fps, < 8 ms main-thread |
| Chunk, all stages, per worker | < 60 ms | < 150 ms |
| Memory (retention set) | < 400 MB | < 200 MB |

- The retention set is about 350 chunks on a phone and about 550 on a desktop. The 4 m DEM takes 64 KB per chunk as Float32. Rasters are re-rendered on demand rather than all kept: only visible chunks plus one ring keep their bitmaps.
- Heavy arrays use transferable buffers. Workers keep their own copies of neighbouring data so it isn't copied back and forth.

## 6. Code layout (planned)

```
src/
  main.ts            viewport, input, pan clamp, compositor, km grid
  chunks/            ChunkManager, scheduler, retention, stage graph
  worker/            worker entry, message protocol
  gen/region.ts      gen/terrain.ts  gen/hydro.ts  gen/landuse.ts
  gen/settle.ts      gen/network.ts  gen/builtup.ts gen/symbols.ts
  render/            per-layer chunk renderers, style.ts
  lib/               rng, noise, poisson, astar, marching squares, geometry
test/                invariant tests (Vitest)
```

## 7. Verification

- **Vitest invariant tests** on generated patches:
  - rivers are monotonic downhill
  - gradient limits hold per road class
  - no N or D dead-ends inside the finished set
  - every settlement is connected
  - no building overlaps a road or water
  - chunk borders join (height and polyline continuity)
- **Visual checks** in the browser at phone and desktop sizes. A hidden `?debug` flag shows chunk stages and timings for development (not a user-facing panel).

## 8. Resolved questions

1. Seas and coastlines: **no**. Everything is inland.
2. Glaciers in the alpine region: **yes**, above about 2,800 m (adjusted for aspect).
3. Delivery: milestone by milestone, with a check-in after each one.

## 9. Milestones

1. Scaffold, pan and zoom with clamping, ChunkManager and worker pool, region and macro/detail terrain, hillshade, adaptive contours, km grid.
2. Hydrology: rivers, streams, lakes.
3. Land use, rock and scree.
4. Settlements and road network (switchbacks, bridges, stubs).
5. Town streets and buildings.
6. Railways, parcels and hedges, point symbols, power lines.
7. Mobile performance pass and visual polish.
