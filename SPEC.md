# Topo — infinite generated topographic map

Status: milestones 1 (terrain & viewer) and 2 (hydrology & erosion) implemented, 2026-10-19.

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
| `dem` | 4 m DEM, lake depth field, stream polylines, built from a blend of the 3×3 surrounding solves. | The chunk and its 8 neighbours have `hydro`. |
| `render` | Raster (hillshade, lakes, contours, shorelines, streams). | DEM exists. Re-run when the zoom bucket changes. |

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

- Sites are suitability-weighted Poisson-disc samples. Suitability favours flat land, nearby water, ground outside the floodplain, and in alpine areas sunny valley floors. Spacing depends on the region type.
- Hierarchy: town (rare, about one per 10–15 km), village (2–4 km apart in lowland), hamlet, isolated farm.
- Patterns by region: nucleated villages in lowland, scattered hamlets in bocage, linear villages along valley roads in mountains.

### 3.5 Road and rail networks

| Class | IGN symbol | Max gradient | Min radius | Connects |
|---|---|---|---|---|
| N (national) | red/orange, cased | 7 % | 120 m | towns |
| D (departmental) | yellow, cased | 10 % | 40 m | villages to towns |
| C (local) | white, cased | 15 % | 15 m | hamlets, farms |
| Track | dashed double line | 20 % | — | fields, forest |
| Path | thin dashed | — | — | anywhere |
| Railway | black/white hatched | 2.5 % | 300 m | towns, with stations |

- **Topology.** Sites plus pending stubs are joined in a relative-neighbourhood graph, with extra edges added for redundancy. Each edge gets a class from the classes of the sites it connects.
- **Routing.** A\* runs on an 8 m cost grid with **state = (cell, heading)**. Each move's cost includes the gradient (impassable above the class limit), curvature, water crossings (bridges are costly, must be roughly perpendicular, and get longer on wide rivers), forest, and existing roads (reusing them is cheap). Switchbacks *emerge* on steep slopes because the gradient limit plus a turning radius forces hairpins. Results are smoothed with clothoid/spline fitting.
- **Tunnels and viaducts** are only allowed for N roads and railways, when they are cheaper than going around.
- **Frontier stubs.** Any road leaving the generated area is stored as a stub (class, heading, position). The next networks stage has to connect every stub to a site or to a road of equal or higher class. When land is forgotten, the cut roads turn back into stubs.
- **Invariants:**
  - N and D roads never dead-end except at the retention boundary.
  - Every village connects to the network.
  - No road exceeds its class gradient except on bridges and in tunnels.

### 3.6 Built-up areas

- **Streets** grow from the roads entering the settlement. Old cores get an organic street pattern around a church square. Towns also get grid or cul-de-sac suburbs and an industrial zone near rail or the N road.
- **Buildings** are footprint polygons aligned to the street, with setbacks. Farmyards in villages are L- or U-shaped. Industrial halls are larger. Building density and size depend on settlement rank and distance from the centre.
- **Parcels** subdivide farmland bounded by roads and tracks. Shapes depend on the region: strip fields in lowland, small irregular fields with **hedges** in bocage, terraces on steep slopes. Vineyards go on south-facing slopes at roughly 150–500 m, orchards around villages.

### 3.7 Land use

Rules use slope, aspect, elevation, region, distance to settlement and wetness: forest (deciduous, conifer, mixed), meadow, cropland, vineyard, orchard, heath, wetland, rock, scree, alpine grass, and glaciers above about 2,800 m (see §8).

### 3.8 Point symbols

Church (one per village, cathedral-sized in towns), chapel, wayside cross at junctions, watermill on streams, windmill in lowland, spot heights at summits and junctions, triangulation point on major summits, viewpoints, and power lines with pylons connecting towns via substations.

## 4. Rendering (IGN Top25 adapted to 1:10k)

- Chunks are rendered **inside workers** with `OffscreenCanvas` and transferred as `ImageBitmap`. The main thread only composites and draws the grid.
- Rasters are drawn at DPR, capped at 2. During a zoom gesture the bitmaps are scaled. When the gesture ends, chunks are re-rendered for the new zoom bucket.
- Layer order: paper → hillshade (NW light, warm grey multiply) → land use fills → parcels and hedges → contours → rock hatching and scree → water → tracks and paths → road casings → road fills → railways → buildings → symbols. The km grid is drawn on the main thread.
- Adaptive contours come from marching squares on the 4 m DEM, per chunk with a one-cell overlap so lines join at borders. The interval switches per chunk-region by local slope percentile, blended so index lines stay continuous.
- The palette (contour brown, water blue, forest green, road red/yellow/white, black buildings, blue km grid) goes into a single `style.ts` token file.

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
