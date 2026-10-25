# Terra Incognita — infinite generated topographic map

Status: milestones 1–3 implemented; milestone 4 (settlements & roads) in progress, 2026-10-24.

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
| Overlays | Kilometre grid; a paper margin round the map face carrying the kilometre numbers (those on the sides turned a quarter); a legend that slides out of the right margin (key `l`). |
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
| `pre` | The surface window solves erode (`zPre`: the coarse eroded surface plus terrain detail from 64 to 512 m, §3.3) and region R, on a 16 m node grid. Batched 8 chunks per task. | Chunk is within generation rectangle + 1 chunk + 3 chunks. |
| `hydro` | Window solve centred on the chunk (§3.3). Keeps the chunk ± 16 nodes. | Every chunk within ±3 chunks has `pre`. Solves are independent, so they run fully in parallel. |
| `net` | Per 8.2 km net cell: settlement sites, and the lattice edges carrying roads, tracks and footpaths (§3.4–3.5). | Cell is within 1 km of the roads rectangle. |
| `roads` | Drawn curves for the lattice edges whose midpoint lies in the chunk, fitted to the fine terrain. | The chunk and its 8 neighbours have `hydro`, and the net cells within 1 km exist. |
| `plan` | Per village or town: its street plan (§3.6). | Every chunk within the plan's extent (+ one lattice edge) has `roads`. Plans whose drawing reaches the generation rectangle pull those roads (and their solves) in, beyond the roads rectangle where needed. |
| `dem` | 4 m DEM, lake depth field, land cover, stream polylines, built from a blend of the 3×3 surrounding solves. | The chunk and its 8 neighbours have `hydro`, and the nearby net cells exist. |
| `render` | Raster (land cover, hillshade, contours, water, settlements, roads). | DEM exists, the 3×3 chunks have `roads`, and every plan drawing into the chunk is done. Re-run when the zoom bucket changes. |

- Every stage is a **pure function of the seeds**; nothing depends on the order in which chunks are generated.
- The **finished set** contains chunks with a bitmap. The viewport must always lie inside it.
- Chunks outside viewport + 4.5 km + 1 chunk are forgotten. When a chunk is forgotten, its neighbours drop their DEM and bitmap, because those blended its solve. A plan reading roads that are dropped goes too, with the bitmaps that drew it.

### 3.2 Emergent generation (no global seed)

*(Revised during milestone 1. The first draft proposed conditional extrapolation plus membrane correction along borders. Forgettable lattice seeds turned out simpler and give exact continuity.)*

- All terrain noise is gradient noise on lattices from 16 km down to 8 m. A lattice point's random gradient comes from a **seed created lazily the first time land needs it**, using `Math.random`. There is no world seed.
  - Fine lattices (spacing ≤ 512 m) use one seed per chunk: a lattice point takes its randomness from the chunk it lies in. The 512 m terrain octave is the exception (below).
  - Each fine terrain octave's lattice is **offset** by its own fraction of its spacing (golden-ratio steps). Gradient noise has different curvature along its lattice lines, and ridged noise most of all. Lattices aligned with the chunk grid showed every chunk border at up to 2.4× the curvature of elsewhere (1.4× through chunk middles). A shifted lattice point still lies within one spacing of every sample that uses it, so the seed dependency stays within ±1 chunk.
  - Coarse lattices (512 m–16 km for the terrain; 32 and 64 km for the motorways, §3.5.1) store one seed per lattice point and are kept far beyond the view (64 km, plus two spacings: a lattice shifted by up to a spacing reads one point further, so payloads hold one more point past their far edge). The 512 m terrain octave uses its coarse lattice, so the coarse surface (§3.3) can resolve it anywhere; per-chunk randomness at 512 m (lakes, land cover) still uses the fine one.
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

**Coarse surface** (what roads and settlements plan on)
- Coarse solves (128 m nodes, same erosion law) run on a **fixed lattice of overlapping 20 km tiles** at a 10 km stride, blended bilinearly between tile centres and read through a cubic B-spline (bilinear left the D8 valleys as straight creases that the fine solves then followed).
- Each tile erodes the terrain with octaves down to 512 m plus regional **uplift** (0 m in lowland, 120 m in hills, 450 m in low mountains, up to 1,600 m in alpine areas), so it approaches the steady state of its drainage network.
  - Tile edges drain at `max(min(zPre, base level), zPre − maxIncision(R))`.
  - Routing as in window solves: priority-flood, then a lower neighbour weighted by slope², with randomness bound to the node's position.
  - Filled depressions become floors graded at min(S, 0.3 %) rather than dead flats.
  - The same hillslope limiter as window solves (no node more than 1.15·Smax·d above any neighbour), as raster sweeps; without it window solves cut 40–50 m off the coarse surface.
- This makes the coarse surface a pure function of the coarse seeds. Each worker caches tiles, keyed by tile and a hash of the seeds they depend on.
- **Known limitation.** Every tile drains to its own edges, so overlapping tiles disagree (~50 m in lowlands, 120–190 m in hills and mountains, `dev/tilespread.ts`). Where they disagree along a valley floor, the blend can hold a closed basin, which window solves breach, turn into lakes or fill (Window solve, step 2). Tried without success: tile edges from a 1 km regional solve, with a second local pass (tiles agree much better, but the land drains through too few outlets: plateaus, half the relief, at ~5× the cost); a second pass with edges from the first's blend (worse); tiles solved 5–10 km beyond their blended part (barely better); edges at the base level without the incision clamp (no better).

**Fine surface**
- Nodes are 16 m apart. `zPre` = the coarse surface + the terrain detail between 64 and 512 m (terrain with octaves ≥ 64 m minus terrain with octaves ≥ 512 m). Window solves thus refine the coarse valley network instead of growing their own, and the map agrees with the coarse surface: slopes over 512 m correlate 0.92–0.94 (the best a 256 m sampling of the map could do is 0.95–0.98), heights within ~5–20 m on average (`dev/terraincmp.ts`). Before, window solves eroded the uplifted terrain themselves and the correlation was ~0.5.

**Window solve (one per chunk, ±3 chunks, 224² nodes)**
1. **Outlets.**
   - Window-edge nodes drain at `max(min(zPre, coarse base), zPre − maxIncision(R))`.
   - Big coarse rivers entering the window are injected as inflows.
2. **Closed coarse basins** (`coarseBasins`). Where overlapping coarse tiles disagree, the blended coarse surface can hold closed basins. Each window fills the coarse surface on a world-aligned 128 m grid reaching 6 km beyond it; basins clear of that grid's edge (a pure function of the coarse surface, so every window blending a node near one treats it alike):
   - at least 10 m deep and at most 3 km across become **lakes** at their spill level (after erosion; a node is lake where a lake cell at or next to it lies above both its surface and, by 0.5 m, the coarse surface). They are never drained.
   - the others, if basin and channel span at most 6 km, are **breached**: a channel from the lowest cell to the saddle over the lowest ground and on downhill (edge-sharing cells only, falling 2 cm per cell), and every pocket carved to drain into it; the cut is interpolated into this window's surface.
   - bigger basins (about 1 % of mountain land) stay filled: flats that streams cross in straight lines.
3. **Routing.**
   - Priority-flood, **breaching** depressions where that cuts at most 4 m (the fine detail leaves dams of a metre or two along valleys) and filling deeper ones; then stochastic routing: a lower neighbour weighted by slope².
   - Crossing filled ground costs a smoothly varying amount (exp(3·noise) over 32–128 m, at least 0.25), in the flood, in carving and in the final pass alike. At uniform cost every stream entering a flat crossed it along the same shortest line to the spill: parallel straight streams. Now they wander and gather into the cheap corridors.
   - The randomness is **tied to place**: a hash of the node and its chunk's seed. Overlapping solves therefore agree on routing.
4. **Four erosion passes** of route → accumulate → carve:
   - Later passes use steepest descent on the carved surface, keeping the current receiver unless another neighbour is more than 1.5× steeper.
   - Carving: `zE = max(zE(rec) + ε·d, min(zPre, zE(rec) + S·d))`, with `S = clamp(k(R)·A^-½, 3e-4, Smax(R))`.
   - `k` ranges from 0.012 (lowland) to 0.15 (alpine). `Smax` ranges from 0.18 to 0.75.
5. **Lakes.**
   - *Dammed lakes:* every chunk has a seeded 5–12% chance of a dam (1.5–25 m by region) at a place-bound site. The lake floods upstream unless it would leak.
   - *Natural lakes:* filled depressions of the uneroded surface of at least 25 nodes and 1.5 m deep, clear of the window edge. (On the eroded surface they depended on how deep each window, with its own truncated catchments, cut the outflow notch, and lakes ended at chunk lines.)
6. **Valley floors** around channels with A ≥ 0.5 km² (floodplains, glacial U-floors). Half-width is `k·√A`, capped at 180 m.
7. **Hillslope limiter.** Lower envelope: no node sits more than 1.15·Smax·d above any neighbour, which removes cliffs. Channels are included and re-routed into the lower ground; otherwise a small side stream left above a freshly carved valley floor stands as a one-node wall up to ~190 m high. Only channels beside a lake keep their course, so its inflows and outflow stay intact.
   - *Breached lakes:* floors and the limiter lower the land around lakes, never the lakes. A lake whose rim ends up more than 1 m below its level along at least 3 shore nodes and 10 % of its shore (one or two low nodes are just its outflow notch; the old single-node rule drained 70 % of lakes) is drained, its bed returned to the eroded ground (left at the level it stood as a dead-flat plateau), and the limiter runs again to lower its bed towards the breach. Otherwise it hangs above its surroundings: in hills and mountains most natural lakes did, by 8–360 m.
8. **Final drainage guarantee.** Nodes whose receivers fall strictly (or across one lake) to an outlet keep them; a priority-flood from the outlets fills any remaining pit by a hair and routes it on. (Keeping only receivers the flood had already reached re-routed whole flats into straight lines from the outlet.) Every receiver points at an earlier-settled node, so there are no dead ends and no cycles. Accumulation is then recomputed.
9. **Output.** Only the core is kept: the chunk ± 16 nodes, i.e. the support of its blend weight.

**Blending**
- A node's elevation is the blend of the four solves whose centres surround it.
- Weights are `cos²(π/2 · distance / chunk)` per axis. They sum to 1 and have zero slope at both ends, so the blend has no creases. A weight is zero one chunk from its centre, far from any window edge.
- Lakes blend by majority (weight ≥ 0.5), with a weighted level. A node stays lake only if the solves without the lake there have ground at most 1 m (weighted) below that level. Where a solve has carved the ground well below a lake that another solve keeps, the lake then ends where the blended ground can hold it. Without this rule it ended at the majority line, against a wall up to ~25 m high (from the DEM's raise of dry ground beside lakes).
- Receivers and drainage area come from the solve of the node's own chunk. A stream crossing into a chunk whose solve has a smaller catchment there is carried on downstream by the renderer.

**DEM (4 m)**
- Cubic B-spline of the blended eroded nodes.
- Plus fine terrain detail (below 64 m) where the land wasn't carved, and up to 35% of it on steep eroded slopes.
- Lakes are flat at their level. Shorelines come from `min(level − ground, splined lake mask)`.

**Streams**
- Channels with A ≥ 0.07–0.3 km² become polylines split at heads and confluences. The threshold is continuous in R, and everything downstream of a stream head stays a stream until it reaches a lake.
- **Meanders.** On flat ground (eroded slope below 1 %, fading out by 4 %) a stream drawn through 16 m nodes is straight, so each vertex is displaced sideways to the flow (taken over 4 nodes downstream) by `a·sin(2π·s/λ + drift)`: `s` the position along the flow, wavelength λ = max(70 m, 12 river widths), amplitude a = min(60 m, 12 m + 8 widths), and a phase drift from 256 m noise so loops vary. Only place, flow direction and the shared patch go in, so chunks agree.
- They're Gaussian-smoothed over ±3 vertices and stroked per segment with width `1.1·A^0.55` m. Wider rivers get a casing.

**Invariants (tested)**
- DEM edges and aprons are identical between neighbouring chunks.
- DEM curvature at chunk borders and through chunk middles is within 1.3× of elsewhere (no seams).
- No stream node without a receiver (no dead ends).

### 3.4 Settlements

*(Milestone 4, as implemented in `src/gen/settle.ts`. Everything is a pure function of the long-lived coarse seeds.)*

**Suitability.** Computed from the coarse eroded surface, using the nearest 128 m tile:
- Flatness relative to the region (tolerance 0.08 in lowland up to 0.3 in alpine terrain).
- Valley position: hilltops and ridges are penalised.
- River proximity: towns want real rivers, villages and hamlets are happy with streams; farms don't care.
- Altitude: nothing above about 1,850 m.
- Not in a lake: villages, hamlets and farms that would qualify keep their built-up area, and at least 120 m (their nearest lattice vertex), clear of the coarse basins' lakes (§3.5). Towns don't look: they are decided up to ~36 km from a net cell, beyond the lakes' reach, and a lake (at most 3 km across) rarely takes one.

**Candidates.** Each rank has candidates on a seeded, jittered lattice:

| Rank | Lattice | Spacing | Keep-out from higher ranks | Min suitability |
|---|---|---|---|---|
| Town | 3 km | 6.5 km | – | 0.30 |
| Village | 0.9 km | 1.9–3.4 km (by region) | 1.7 km | 0.15 |
| Hamlet | 0.35 km | 0.65–1.1 km | 0.55 km | 0.06 |
| Farm | 0.2 km | 0.28–0.6 km | built-up radius + 250 m | 0.08 |

- A candidate becomes a site if its score (suitability × seeded random) beats every same-rank candidate within its spacing, and no higher-ranked site is within the keep-out distance.
- These rules are local, so every worker agrees.
- Measured density: villages about 0.065 per km² (France averages about 1 commune per 16 km²), hamlets about 0.5 per km², farms about 2.5 per km² in the lowlands.
- Settlements clear the land around them of forest for fields and pasture: out to 1,300 m from a town's centre, 560 m for a village, 200 m for a hamlet, 80 m for a farm (all centred on the crossroads or the farm road's end); fully within 45 % of that, the edge made ragged by noise (±50 % of the distance), and not on locally steep ground (relative to the region), which keeps its woods. Built-up land itself (§3.6) clears woods, vines, marsh and heath exactly when drawn.
- **Farmsteads** *(as implemented in `src/gen/farm.ts`)*: each farm gets a small plan, made like a street plan (§3.6) from the drawn roads and the fine terrain, so every chunk draws it alike. It stands at the farm's vertex as the drawn roads have it (snapped up to 45 m to gentler ground; ways end there, or a steep piece drawn as one passes through it), in the widest open wedge between the ways meeting there (past the end of a road that ends there, beside one that runs on; other wedges at least 100° wide, or 75 % of the widest, are tried next). Its form follows the mean slope where it will stand:
  - *steep* (over 16 % in the lowlands, falling to 11 % in the mountains; and 15–50 % of the rest, more in the mountains): one or two small buildings (8–11 × 6–8 m, a 6–10 × 5–7 m shed 3–8 m beside it 60 % of the time), long sides along the contour;
  - *middling*: a 10–13 × 7–9 m house across the wedge and a 15–22 × 9–11 m barn joined to one end in an L; 35 % a small shed beside them;
  - *flat* (under 7 %; 85 % of such farms in the lowlands, 15 % from the hills up): a **court** (60 %) — 24–36 × 26–38 m, the house at a back corner facing it, a barn along the rest of the back, stables or barns down one or (80 %) both sides, 30 % closed by a front range with a 4.5–7 m gateway; 65 % a 22–36 × 12–18 m machine shed beside it, 60 % a small outbuilding apart — or a **loose group** (40 %): the house near the road and two to four barns, stables, sheds and machine sheds about a yard, 4–9 m apart.

  Each building must stand on dry ground (6 m from lake nodes, off stream channels), no steeper than village buildings may (55–80 %; large ones 20 %), clear of every way as village buildings are, within 300 m of the site. The frame is mirrored, turned ±17° in wide wedges and set back 7–41 m from the vertex until the whole form fits; otherwise the frame placing most of it wins, and a form whose house finds no place gives way to the L, then to the small form. A farm whose lattice vertex lies in a lake (the fine solves' lakes, which the network can't see: its roads stop at the shore, and the drowned vertex is snapped onto it) is left out, as is one whose house fits nowhere.
- **Tracks into the fields**: into a wedge at least 110° wide, 75 % of courts, 60 % of groups and 35 % of L farms get a dead-end track from the vertex, 80–300 m long by form. It leaves along the front of the farmstead and turns into the fields past its side (the other side if that gets further), in 10 m steps turning at most 20° each, weighing grade (easy at 8 %, never over the track limit) against its heading; it keeps to its wedge, off water, 4 m from the buildings, 20 m from other ways (those meeting at the vertex only after 40 m) and 80 m from their dead ends (other farms), and is dropped under 50 m.
- Hamlets, villages and towns get street plans (§3.6); villages and towns have a church at their centre.

### 3.5 Road network

*(Milestone 4, as implemented in `src/gen/lattice.ts`; shared classes and types in `src/gen/roads.ts`. Two earlier designs — waypoint routes with a fine A* per segment, and a mesh of independently routed links — produced loops, braids and junction-less crossings, and were replaced.)*

**One shared graph.** Every road, track and footpath is made of edges of one lattice: a vertex near each point of a triangular lattice every 150 m, jittered by up to 60 m (0.4 × spacing) from a hash of its position, joined by their Delaunay triangulation. With the lattice's own six neighbours and a 33 m jitter (all a fixed triangulation allows before triangles flip), roads on open ground kept to its three directions and closed into hexagons; the Delaunay edges prefer none. A vertex's neighbours are decided from the vertices within 2 × the longest possible edge (2 × (spacing / √3 + jitter) ≈ 293 m), which hold both ends of any edge crossing a candidate, so both ends of an edge agree on it. Edges never cross, so ways can only meet at vertices: they cannot overlap, braid, or cross without a junction. Each net cell (8.2 km) decides which edges carry which kind of way; an edge is owned by the cell holding its midpoint.

| Class | What | Max gradient | Symbol |
|---|---|---|---|
| N | town ↔ town (relative-neighbourhood graph, ≤ 9 km) | 7 % | red, cased |
| D | village ↔ village or town (relative-neighbourhood graph, ≤ 4.5 km) | 10 % | yellow, cased |
| C | hamlet and farm roads, shortcuts | 15 % | white, cased |
| Track | farm and forest access, links between farms and hamlets | 22 % (keeps to 10 %) | thin solid line |
| Footpath | shortcuts and links too steep for a road or track | 45 % (keeps to 18 %) | thin dashed line |

**Edge costs** (per class, symmetric):
- Length, times a soft slope penalty 1 + 1.5·(g / limit)², capped at 6×. The slope g is read from the coarse surface over 500 m along the edge, not between its own two vertices: the coarse surface follows the map closely at 256–512 m, but not at the scale of one edge (150 m), where the map's finer gullies take over. Judged per edge (when the two surfaces still disagreed), it sent main roads on kilometre-long detours around slopes that are gentle on the map.
- Tracks and footpaths, driven and walked slowly, would rather traverse a slope along its contours than climb it: their penalty is against an easy grade (10 % and 18 %) and capped at 30× and 12× (under a cap of 6×, a steeper edge cost less per metre of height, and they ran straight down the fall line), and their slope is the steeper of the 500 m reading and the one between the edge's own vertices (the long baseline, reaching across a valley floor, read valley sides as gentle).
- Valley floors (draining 0.3–4 km² or more) cost up to 30 % less.
- Crossing a stream (much more drainage under the edge's middle than at its ends) adds a bridge charge of 40 m, more for a river.
- Water: the lakes of closed coarse basins (§3.3) cost 12× the length under water, sampled at 5 points, plus 150 m per crossing, as in the fine routing. The network sees them by the window solves' rule on the coarse surface alone (`src/gen/lakes.ts`): a lake cell at or next to a place, with its level more than 0.5 m above the coarse surface there. Basins come from `coarseBasins` per fixed 8 km tile, cached per worker by the coarse tiles they read; they are a pure function of the coarse surface for every lake touching the tile, so every cell agrees. Lake tests reach ~30 km from a cell (corridors, and the villages deciding its D roads) and read the surface 14 km beyond that, so net cells now take coarse seeds 65 km around them (kept to 70 km). Dammed and natural lakes come from the fine solves and remain the drawing's business (below).
- A fixed tie-break of up to 1 %, so best paths are unique.

**Stages.** Each stage grows from the previous one, so a cell needs each stage known a bit further out than the next: main roads up to ~11 km around it, hamlet roads ~7 km, farm roads ~2.4 km, tracks ~1.2 km.
1. **Main roads.** For each town pair (N) and village pair (D), the cheapest path inside a fixed corridor (|pa| + |pb| ≤ 1.3·d + 1 km), with a small cost for turning and a large one (400 m) for a sharp turn at a vertex — on steep ground, hairpins are left to the fine routing. The corridor makes the path a function of the pair alone, so every cell finds the same one.
2. **Hamlet roads.** One cheapest-path forest grown out from the main network (with the heading in the state, turns costing as on main roads); each hamlet's road follows it back, so roads from nearby hamlets merge like streams.
3. **Shortcuts.** Neighbouring settlements (Gabriel pairs, 0.4–2 km apart) that the roads so far join only by a way round longer than 2× their distance get a corridor path as a C road; where its edges would be steeper than 1.3× the road limit, a footpath instead. Decided on main and hamlet roads only, so every cell decides each pair alike.
4. **Farm roads.** Grown like hamlet roads, from all roads so far.
5. **Links.** Neighbouring settlements, farms included (Gabriel pairs, 250–1,200 m apart), that the ways so far join only by a way round longer than 1.8× their distance get a track across (a corridor path no longer than 1.5× the distance, no edge steeper than 1.3× the limit, and no steeper than tracks are kept to on average, below) — else a footpath (which may wind 1.4× more, along the contours). Farmland is crossed by a mesh of tracks between farms and hamlets, not only the trees of farm roads (lowland tracks about 2.2 km per km², from 0.4). Shortcuts' footpaths, too, may wind 1.4× more. Decided on the ways so far, never on other links, so every cell decides each pair alike.
6. **Tracks.** Scattered points not in a lake (14 % of vertices, by hash, falling by up to 85 % as the 500 m slope rises from 10 % to 35 %, and on slopes over 15 % at most one within 300 m, the lowest hash: neighbouring seeds on a slope each ran a track down it side by side) with no road within 200 m, below 2,300 m and not on a cliff, get a track back to the network (roads and track links), grown as one forest so nearby tracks merge; seeds keep 200 m from links too. A track whose way back averages a slope penalty above 6× its length is left out: on a steep slope with no gentler line to the network, it would run straight down. Mountain slopes thus carry few ways (about 2.2 km per km² against 3 in the lowlands; Alpine forest roads run at 2.5–4.5), which leaves them room to wind. Farms, too, want flatter ground than other settlements.

An edge used by several ways takes the highest class.

**Roundabouts** *(experimental)*. Decided by the net cell per vertex, from the classes of the roads (N, D, C) meeting there, so every cell agrees: at a junction of three or more main-road edges (two D roads, or an N and a D) with a chance of 35 % in the open and 85 % within 3 km of a town; where a C road joins a main road, 40 % near a town and never in the open. Never at a settlement's own vertex, within a village's or hamlet's plan extent (+40 m; they make their own crossroads), nor within 450 m of a town's centre; of two neighbouring vertices only the lower hash gets one. Radius 13–18 m where main roads meet, 3 m more near towns, 2 m more on an N road; 10–12 m where a minor road joins (an access road's); the ring carries the junction's highest class. Edges carry the roundabouts at their vertices to the chunks (`RoadEdge.rings`). The drawing builds one only where the ground takes it (`routeCurves`): round the snapped vertex, dry, off streams (under 1 km²) and level to 6 % of its outer diameter. The ring is drawn by the chunk owning the first edge there (by key), and every way meeting at the vertex is cut back to the ring. No building (plans, farmsteads) or water tower stands on its island. Measured (`netstats`-style, seed 1): 7–8 within 3 km of a lowland or hill town, 0–2 per 67 km² cell elsewhere; in one lowland sample, two of seven failed the ground test (too steep).

**Geometry** (per chunk, in the `roads` stage):
- Vertices are snapped within 32 m to gentler, dry ground on the fine terrain, off the shore; a vertex under water moves to the nearest dry ground within 128 m.
- Each edge is one cubic Hermite curve between its vertices. At each vertex its edges are paired greedily (highest class, then straightest); a pair continues smoothly with a shared Catmull–Rom direction, never shorter than a quarter of the shorter leg, so a sharp turn becomes a rounded hairpin. A side road meeting a through road arrives straight.
- The curve is then fitted to the fine terrain: samples every 10 m may move up to 32 m sideways, fading to nothing at both vertices. Dynamic programming over the offsets picks a line that is gentle, smooth, near the edge, out of lakes, off their shores and off stream beds; the chosen shifts are then smoothed.
- **Tracks and footpaths** are drawn a piece at a time (see below; an edge with no piece on its own) by the chunk owning its middle edge, as straight runs rather than curves: from end to end where that line keeps in the room the piece may use (as a steep piece's, below) and, at a junction, within 12° of its edge there; else broken at one vertex, or every one (single edges are always allowed: they keep to the lattice as a curve did). Each run is fitted to the fine terrain like a curve, but in a band of 64 m, widening over 120 m from each end, against an even, easy grade (length + 3 × (g / easy grade)² per m): on the flat they run straight, with a bend where pieces meet, and on a slope they bend in and out with the contours. A piece steeper than 1.3× its easy grade, whichever way it lies to the contours, or with water under it, is routed as a steep piece, its grade weighed 1.5× (0.5× on roads) against the easy grade, and its searched path straightened over up to 48 nodes wherever the straight line is no dearer and stays where it may go. Measured on seeded areas (`roadstats`): tracks over their limit 9 % → 5 % in the lowlands and 44 % → 21 % in the hills, footpaths 31 % → 6 %.
- **Steep pieces.** Consecutive edges of one way are grouped into pieces of at most 3 edges, between anchors (junctions, dead ends, class changes, and vertices picked by a hash of their position). A piece that climbs more than 1.3× its class limit on the fine terrain, mostly uphill, is routed on the fine terrain itself by the chunk owning its middle edge: A* over 16 m nodes with 16 headings (the 8 neighbours and knight's moves, so legs follow the contours instead of stair-stepping between two of 8 directions; up to 90° per step, so a hairpin takes two steps; turns cost 60 / 45 / 25 / 15 / 6 m per 45° from main roads to footpaths), gradient held near the limit, round lakes (below). Where it may go: within a band either side of its chord of 250 / 220 / 200 / 60 / 25 m by class (a leg spans the band, so main roads and minor roads get legs of ~150–200 m between hairpins, tracks ~75–110 m, footpaths short zig-zags); at each end vertex, within its wedge (bounded by the bisectors to the ways next to it there, narrowed to 90 %), so pieces meeting at a vertex can't run into each other; against every other way within 300 m that may be fine-routed too (the drawing chunk tests its piece's steepness and water; beyond its patch it assumes it may), only where nearer its own line than a weight × the other's (weighted Voronoi: 0.9 against the same class, 1.5 against a lower one, 0.6 against a higher one; a pair's weights multiply to under 1, so the two can't meet), and 56 m (fitted band and clearance) from a way that won't, unless nearer its own line; clear of other ways by 24 m (within 48 m of the piece's ends by 10 m, except right at the junction, so it can't wrap a hairpin round a way meeting it) and of the road's own continuation beyond either end. (A single width per side, set by the nearest way anywhere along the piece, held legs to ~90–130 m.) Loops where the path crosses its own track are cut out. The path, its stair-steps straightened, is drawn as straight legs joined by circular arcs of at most 20 / 15 / 11 / 8 / 5 m radius (N … footpath), sampled every 2 m so the renderer's smoothing barely softens them: hairpins have an apex radius of ~11 m (it was ~21 m: four 45° steps and smoothing made round loops ~50 m across). `roadstats` measures them (HAIRPINS). The others skip its edges. The steep test uses only the piece's vertices and terrain inside it, so every chunk that sees the piece decides alike.
- **Lakes.** The network can't see lakes (they come from the fine solves, which exist only near the view), so the drawing goes round them. A piece whose line between its vertices has water under it is routed on the fine terrain as a steep piece is, by the same owner rule; an edge whose fitted curve still stands in water is routed on its own (only its owner draws it). In that routing water costs 12× its length plus 150 m per crossing, and dry nodes beside a lake 3× (the map's splined shoreline reaches a few metres past the last lake node). Where the way round leaves the band, a road crosses at a narrow place: a bridge or causeway. Tracks and footpaths never cross water: they are routed with water forbidden, and any part still in a lake (a route that found no way round falls back to a straight line, sampled every 8 m like any other) is left out, so they stop at both shores. No way ends in a lake: where everything beyond an edge's (or piece's) end, up to a dead end within 4 edges, lies under water as the network placed it, that end is not snapped (snapping could move it to the far shore) and the way stops at the first water coming from its other end, off the shore; an edge wholly in that water is not drawn. The lattice tells each chunk which ends lead to such dead ends, so every chunk decides alike. Measured on seeded areas (`dev/roadstats.ts`, lakes 2.3–3.5 % of the land): road standing in water down from 18 km to 11 km per 144 km², crossings over 30 m from 150 to 69, shore clips from 30 to 8. With the coarse lakes in the network too (same areas, network blind vs aware): 10.0 km to 2.8 km, crossings 59 to 23, way vertices in a lake 109 to 34; almost none of the rest is in a coarse lake.
- All of this uses only the edge (or piece), its neighbours at both ends and the terrain near it, so every chunk draws an edge identically.

**Rendering.** Footpaths and tracks first, uncased, under the roads; then all road casings; then road fills from C up to N. Roads over water are drawn again on top as bridges: black parapets either side, square ends one sample past each shore.

**Measured** (seeded test areas): small closed loops 3–8 per 100 km of road before links, 10–26 since (the track mesh closes fields of 0.1–1.4 ha, and the measure counts the wedge where two ways fork at a shallow angle as several), junction-less crossings ≤ 0.05 per km, almost nothing running alongside another road, every settlement and farm reached. Total ways about 4.7 km per km² in the lowlands (3 before links).

**Open.**
- Steep footpaths and tracks are still drawn nearly straight or with short, jagged zig-zags: their band (25 / 60 m) leaves no room for real switchbacks.
- Links made net cells slower (farm roads are known further out): about 6 s for a cold cell in `netstats`, from 4.4 s.
- Roads in mountains are still often steeper than their class allows on the fine terrain: the network cannot see those slopes, and steep pieces rarely have the room or length for a full serpentine.
- Net cells take about 1.7 s each once a worker is warm (`dev/netbench.ts`, 1.2 s before the network knew coarse lakes; ~4.4 s for a worker's first, against 2.5 s: its coarse tiles now reach further out).
- Dammed and natural lakes are not known to the network. The drawing goes round most of them, but a junction far inside one, or a way whose ends lie on opposite shores, still crosses it (as a bridge).
- Footpaths to summits and passes, tunnels; bridges over streams and rivers.
- With the coarse surface now matching the map, a third of minor-road length in hills and half in mountains is still steeper than its limit: genuine climbs the network takes, for switchbacks to handle.

### 3.5.1 Motorways *(experimental, branch `motorways`)*

*(Phases 1–2 of 5, as implemented in `src/gen/motorway.ts`: the alignment, carried by net cells and drawn. `dev/motorways.html` and `dev/mwstats.ts` show and measure the alignment over large areas.)*

Motorways differ from the network's roads: they cross other ways without junctions (bridges), are reached only at interchanges, curve widely (radius ≥ 1.2 km), climb gently (4 %, earthworks and structures taking the rest), and pass towns by rather than through them. There are no cities to join, so they need lead nowhere in particular: a motorway is a line through a large noise field, and nothing far away is consulted.

- **The line**: the zero level of two 64 km noises on lattices offset from each other, plus 32 km (0.15) and 16 km (0.04) so it wanders. Gradient noise is zero at its lattice points, so the zero line of a single lattice threads them all and closes into rings round each; with 16 km noise the lines lay ~10 km apart, far denser than real motorways, and thinning them by a gate cut them into short stretches. At 64 km they lie some 30–40 km apart.
- **Anchors and pieces**: the line is traced per 4 km cell by marching squares over world-aligned 64 m samples. Where it crosses a cell border it has an anchor (point and heading, the field positive on its left), which both cells compute from the same samples; each cell's stretch from border to border is a piece. Loops inside a cell are dropped.
- **Where it runs**: an anchor holds the line where a 64 km gate noise is above −0.35, less a penalty for mountains (the region averaged over a 6 km ring, fading from 0.6 to 0.8) and for alpine land on the spot (0.76–0.86); and not near a saddle of the field (|∇F| under 0.004 per km). An anchor closed alone between two open neighbours is kept (the line skimming the gate's edge left short gaps). A piece is dropped where the raw line bends tighter than 700 m, where it turns more than 150° within 10 km (small closed loops round a weak extremum: ring roads round nothing; judged from the line a few cells either way), and where its run of pieces is shorter than 10 km (stubs between gaps). A motorway ends where the next piece is dropped.
- **Towns** bend the line away: within 4.5 km of a town, points of the line move across it, away from the town's side, by up to 1 km × (1 − (d/4.5 km)²)², so neighbouring anchors move alike. (Sliding single anchors out of the way, for towns and then for lakes, made the pieces between them weave: two anchors 1 km apart slid by different amounts.) Villages don't bend it: motorways pass close by them. In a lake, an anchor stays: the motorway bridges it.
- **Routing**: each piece is routed on the coarse surface within ±1.2 km of its bent line, by dynamic programming over offsets of 100 m at samples every 400 m (with 200 m samples, a change of one offset already turned tighter than the minimum, and the route never left the line), with the previous offset in the state so turns are costed: length × (1 + 3 (g / 4 %)²) capped at 30×, hillsides 1.5 × (slope / 15 %)² per m, coarse lakes 20,000 per sample, a bridge charge of 150 m where much more drains under a step's middle than its ends, settlements' centres (towns 1.5 km, villages 600 m, hamlets 250 m), a little for straying from the line, and turns 2,500 × θ² plus a heavy charge under a 1.56 km radius (aimed 30 % wider than the minimum: the curve through the points bends tighter than they do). Offsets may grow from each anchor only as fast as a 1.5 km circle leaves its tangent, and on the inside of a bend stay under 60 % of its radius. The points are smoothed (8 passes, keeping the anchors' headings) and joined by cubic Hermite curves, the anchors' headings at the ends, sampled every 25 m: pieces meet at their anchors with the same heading.
- **Measured** (`dev/mwstats.ts`, 96 km areas, seeds 1–3): with the region field, 1.15–1.6 km per 100 km² (France ~2, Germany ~3.6), 3.8–5.3 ends per 100 km, 1–8 of 130–190 pieces a little under 1.2 km in radius (one at ~870 m); forced lowland or hills, 2.0 km per 100 km², 2.2 ends per 100 km. ~4–5 s per 96 km area (~30 ms per 64 km² net cell) on top of its coarse tiles.
- **Grades**: in the lowlands the profile (the coarse surface averaged over 1 km along the motorway) is steeper than 6 % on 0–4 % of its length, and the ground lies more than 15 m above or below it on 3–10 %. In hills and mixed land, 34–43 % of the profile is too steep and the ground 15 m off it on 40–47 %: within ±1.2 km of the line hills offer no gentler way (a wider band and stronger grade weight changed nothing), so the motorway must cut through, as real ones do, with cuttings, embankments, viaducts and tunnels.

- **On the map** (phase 2): each net cell carries the pieces of the four motorway cells inside it (`NetCell.motorways`, without their raw lines), worked out in the `net` task from the same coarse surface, settlements and seeds as its lattice (motorway cells are aligned with net cells; their reach, ~25 km of line and the 64 km lattice, lies within the net cell's coarse seeds). Warm, a cell's pieces take 3 ms (none) to ~165 ms, cold ~0.85 s (mostly coarse tiles the lattice reads anyway). A piece lies at most MW_SPILL (2.5 km: town bends, the routing band) outside its own cell (measured: 152 m in a lowland sample), so the net rectangle reaches that far beyond the roads rectangle and a chunk is rendered once the net cells within 2.5 km exist; it draws the pieces whose box comes within 64 m. The centre line is the coarse alignment itself, not fitted to the fine terrain (it cuts through the fine terrain's bumps, as cuttings and embankments would). Drawn after the other roads, as a dual carriageway: 24 m wide (at least 5 CSS px), cased like the roads, crimson (rgb 214, 44, 84) with the central reservation a dark 0.7 px line down the middle; over the fine solves' lakes it is a bridge, with parapets as other roads have. For now everything else (roads, tracks, fields, woods, buildings) still runs on underneath it.

**Next phases** (planned): 3. make them a barrier: lattice edges crossing pay a charge (ways gather at bridges), vertices within ~40 m go unused, plans, buildings, farms and fields keep clear, hamlets and farms in the way are dropped; 4. interchanges where a motorway passes within ~3 km of a town and meets an N or D road (≥ 6 km apart), and junctions where one ends; 5. viaducts and tunnels where the ground lies far off the profile, embankments and cuttings, service areas, the legend.

### 3.6 Built-up areas

**Street plans** *(milestone 4, as implemented in `src/gen/town.ts`)*
- One plan per hamlet, village and town, made once from the drawn road curves within its extent (220 m for a hamlet, 380 m for a village, 900 m for a town) and the fine nodes under it, and drawn by every chunk it reaches. A pure function of those and the site.
- **Centre:** the crossroads the network's roads meet at (the site's lattice vertex, snapped), not the raw site point. The church stands there.
- **Character:** a village is clustered round its crossroads or strung out along its roads (more often in the mountains): strung-out villages build up to 1.7× further along their roads, have fewer back lanes and one generation of branches. Every settlement also leans one way, growing up to ~45 % further (and denser) in that direction.
- **Back lanes:** where neighbouring roads leave the centre, a lane from one to the next round the back of the plots between them, leaving and meeting each road square on (a cubic curve bulging outward, its ends at uneven distances from the centre, with a slow sideways sway, then drawn as straight runs between two or three points of it: crooked, like the streets). In towns, a ring near the edge of the old core (the boulevard where the walls stood) and one inside it.
- **Growth:** points along every street so far are candidate branch points, nearest the centre first. A branch leaves roughly square on (±35° in villages; not within 42 m of another junction on its side; opposite one makes a crossroads), steps 12 m at a time steering for gentle (≤ 14 % in villages, 16 % in towns, up to 6 points more in hill country; refused above 1.6× that), dry ground in straight runs broken by kinks (25–80 m runs, turns up to ~30°; suburbs 60–160 m, ~15°), is drawn in by a street close ahead, and ends on meeting one (a junction, if not shallower than 38° and not a short loop back to its parent; crossings count from the junction itself, its parent included, and the last jump onto a street close ahead meets any street it crosses first; never where that street crosses water), or alongside one, at the settlement's reach, at a river or a second stream, or at its length. Short ones are retried; dead ends are kept as lanes with some chance. Town cores keep about half their unjoined branches. When the branch points run out with street length to spare, every street is offered again at fresh places (up to three rounds): towns fill in their blocks this way. Towns grow an organic core (blocks ~55 m, four generations) and straighter suburban streets beyond (~90 m); villages a looser outer ring of lanes.
- **Old core:** round the crossroads (40–55 % of the core radius in villages, 60–75 % in towns) a tight mesh of short, crooked streets: branch points every 30–34 m, 25–90 m long, runs of 12–40 m between kinks of up to ~35°, 24 m between junctions and 17 m between streets, five generations, three in four branches that don't meet another street dropped. It adds 0.035 (village) or 0.045 (town) m of street per m² of its area to the budget. No branch starts on a bridge.
- **Pruning:** after growth, dead ends nothing hangs off are removed, leaves first and repeatedly, if shorter than 40–60 m in villages or 60–130 m in towns (longer in hill country, where slopes stop many branches early); in towns also stubs up to twice that which stopped alongside another street.
- **Hamlets:** no square, back lanes or church. Built up along their main road only (roads proper, not tracks or paths) for 80–150 m from the crossroads, leaning one way; or (half of them in the lowlands, a quarter in the mountains) one or two short residential streets (40–110 m) off it, with built-up land along those too. Tracks through a hamlet stay tracks unless they run along its main road.
- **Size:** village core 140–200 m, reach 1.7× that, 0.9–2 km of streets; town core 260–340 m, reach 650–850 m, 14–22 km of streets at most (measured: 8.5–9.5 km in lowland and hills, 3.5–5 km in the mountains, held back by lakes and slopes); both shrink by up to 40 % in the mountains.
- **Industrial estates** (towns only): grown before the town, where there is flat, dry ground at its edge beside a main road. *Flat* is a mask over the fine nodes: no lake or stream, and a node's neighbours no more than 6 % apart in height (across 32 m). Junctions are tried every 30 m along the main roads, both sides, where the road lies 0.8–1× the core radius to the reach from the centre, with no other junction within 40 m and flat ground for the first 36 m off it; each needs at least 3 ha of flat land within 260 m on its side (sampled every 24 m, out of the old core, 15 m from any way, away from another estate's land), and they are ranked by that land (up to twice the minimum), then the busier road (N, D, C), then nearness to 1.3× the core radius; the best four are tried in turn. The estate's streets step 12 m at a time across the flat only: an access street of 160–340 m leaving the road roughly square on (±9°), then branches every 55–95 m on either side (60 % chance each, not within 35 m of another junction on that side), 50–190 m long, two generations deep, 450–1,000 m of street in all. Each runs straight but drifts up to ±1.4° per step and bends (up to 17° per step) where the flat ends ahead, is drawn in by a street close ahead and meets it (a junction, not at under 38°, not back onto its parent; never onto a track or path), stops alongside another street (42 m, so blocks hold sheds), off the flat, 260 m from the access junction or at the old core. Where the access street runs less than 80 m, the next junction is tried. 60 % of gates get a roundabout (radius 10–12 m, drawn on its own random stream so the rest of the plan is unchanged) where the ground is dry, off streams and level (6 %), no other street comes within 10 m of it and no network segment ends within it: the road's segments are cut at the ring (keeping their keys and far ends), and the access street leaves from it. Streets don't leave a road within 25 m of a ring, estates keep 40 m from one, and back lanes keep out. Measured (`dev/towns.ts`, seed 1, lowland): 4 of 9 gates. Dead ends of 60 m or more end, half of them, in a turning loop of 9 m radius where it fits. The estate's land is the strip 45 m either side of its streets (not across a road), and of its main road for 110 m either way from the junction on its side, while the land beside it is flat: so its outline follows the flat land. Kept as a distance field on an 8 m grid. A town has a second estate with a chance of 30 %. The town's streets stop 30 m short of an estate's streets unless heading to meet one (so they join it in places) and its houses keep 8 m off its land. Sheds fill the land, fronting its streets and the road along its front, built before everything else: 16–42 m along the street × 14–30 m deep, now and then (15 %) a hall of 40–70 × 25–40 m, set back 4–10 m, 5–14 m apart (now and then, 15 %, a 15–30 m yard), on flat ground and no steeper than 12 % (over 8 m), trying 60 % of the width, then 10 m wide and 60 % deep, where they won't fit. Plans list which buildings are industrial (`dev/towns.ts` draws them grey). Measured (`dev/towns.ts`, seed 1): estates in 8 of 9 towns, 9–35 industrial buildings each, in hills and mountains only on valley floors; on synthetic land median footprints of 430–575 m² against 85 m² for a house. Plan times as before (70–175 ms).
- **Tracks and footpaths through built-up land** (runs of at least 30 m) become residential streets there; the plan redraws those segments (built-up runs as streets, the rest keeping its class) and chunks drop the network's.
- **Buildings** *(as implemented in `src/gen/buildings.ts`, part of the plan)*: both sides of every built-up front (streets, and the road stretches through built-up land) are walked end to end in the order they were built up — the main roads (N, D, C) first, whose rows claim the corners, then the streets off them generation by generation, then tracks taken in; each centre outward — and a rectangle square to the street tried at each step, in two densities:
  - *dense* (the old core, and along main roads out to 1.25× its radius: the faubourgs): terraced rows flush with the street (0.4 m beyond its clearance), 6–11 m along it and 9–14 m deep, wall to wall, now and then (15 %) a 3–6 m gap for an alley or a yard; a plot that won't take a full width (bends, corners) takes 55 % of it;
  - *loose* (everywhere else, and hamlets): houses 8–13 × 7–11 m set back 3–8 m, 5–16 m apart (1.8× in hamlets), now and then (12 %) a barn of 14–22 × 9–12 m; where a house won't fit (a street close behind, a junction), a small one (6–8 × 6–8 m, 1.5–3 m back) before moving on, so no stretch of street is left bare for want of room. In the outer parts (beyond 1.3× the old core's radius) a plot now and then takes a large building — a factory, a newer store — of 18–36 × 14–26 m (was 25–60 × 18–40 m, too big beside the houses), set back 6–12 m, on ground no steeper than 20 %: 7 % of plots in towns, 2.5 % in villages, 2.5× that on main roads, none in hamlets; one that won't fit tries 70 % of its size, then a house. Measured: 0–4 per village, 25 in a lowland town, 1–8 in hill and mountain towns; outside industrial estates, the largest building in a town is now 400–870 m².

  A footprint is kept only if it stays clear of every road and street by half its width and a margin (6, 5, 4, 2.5, 1.5 m from N, D, C, track and path centre lines; 3.5 and 3 m from streets and lanes), of other buildings (they may share walls), of lakes and stream channels, of ground steeper than 55 % in the lowlands rising to 80 % in the mountains (mountain villages climb their slopes; large buildings 20 %) and of the church (10 m); one clashing at full depth is tried at 62 % of it. Measured on synthetic land: 100–300 buildings per village, a quarter to a third of them in terraces; 1,000–1,700 per town. Main roads within 150 m of the centre are lined (7 m off the centre line falls in a footprint) along 30–57 % of their sides in villages (was 14–38 % with the streets built first). Bare street (sides sampled 12 m off the centre line with no building within 15 m) is 0–8 % of the built-up fronts in most villages, up to 16 % where a stream runs beside the road (was up to 39 %); in mountain villages 1–14 % (with a 55 % limit everywhere, up to 59 %: villages on steep ground had hardly any buildings). Drawn solid dark red (hsl 2.3°, 60.5 %, 33.7 %) without an outline, under the roads; footprints of 300 m² or more (halls, larger sheds, stores; not barns) in the same hue and saturation at 62 % lightness, edged in the dark red as wide as a road's casing (inside the footprint).
- **Built-up land** clears the cover under it (woods, vines, marsh, heath; 6 m soft margin) before the chunk is drawn.
- **Built-up land** is a strip 18–24 m each side of every street and of the road stretches near streets or the core. It isn't drawn (the buildings show it); it decides where buildings stand and clears the cover.
- **The crossroads** (redrawn roads: the plan lists the keys of the network's segments it replaces and draws its own pieces instead; their far ends don't move). The roads ending at the centre are cut back and joined by short curved links round it: three or more roads make a rounded triangular green or a small square (24–34 m; in towns always, a 30–45 m market square), a road passing straight through may part round a long green (35–60 m, an Anger; more often in the lowlands). Each link carries the lesser class of its two roads, so a through road keeps its class along one side. Not on slopes over 10 % or where a link would be wet.
- `dev/towns.ts` renders plans as SVG over the fine terrain.

**Planned**
- **Streets** grow from the roads entering the settlement. Old cores get an organic street pattern around a church square. Towns also get grid or cul-de-sac suburbs; industrial estates near rail.
- **Buildings:** farmyards in villages L- or U-shaped. (Isolated farms have their own forms: §3.4; industrial halls stand in towns' estates: §3.6.)
- **Parcels:** terraces on steep slopes; vineyards on south-facing slopes at roughly 150–500 m, orchards around villages (field parcels and hedges: §3.6.1).

#### 3.6.1 Field parcels and hedges

*(As implemented in `src/gen/fields.ts`, drawn by `src/render/fields.ts`; decided per chunk at render time.)*

- **Blocks.** Farmland is first divided into the land the ways enclose. Every way runs along edges of the road lattice (§3.5), so a block is the set of lattice triangles joined across edges carrying no way. The net cells know which edges carry ways well beyond the chunk (the render task gets those within 940 m), so every chunk finds the same blocks. A way with the block on both sides (a dead end) is a *crack*: cuts stop at it, and their parts beyond it are shifted sideways by up to half a field, so fields either side don't line up across it. Blocks more than 760 m across are not cut whole (no chunk is sure to see all of one).
- **Furlongs.** The land of those large blocks is divided by a jittered grid (360 m, ± 30 %) into Voronoi cells, and each cell is split by the ways into pieces (the triangles meeting the cell, joined across edges without a way); each piece of a large block is cut like a block, clipped to its cell, and the cells' edges are field edges too (drawn once, by the cell with the lower index). Every decision reads only the cell, its triangles and the ways near it.
- **Styles,** by region and 3 km value noise (hashed from position): lowland *open field* (fields 60–200 m wide, furlongs 220–450 m deep, 5 % hedged), lowland *strip fields* where their noise exceeds 0.6 (18–45 m strips, 140–300 m furlongs, 3 %), *bocage* in lowland and hills where its noise exceeds 0.62 / 0.5 (70–150 × 80–170 m, cuts leaning up to 14°, 75 % hedged, 70 % of way sides lined), *hill fields* (45–110 × 90–200 m, 35 %), *mountain meadows* from R = 0.55 (80–220 × 120–260 m, 15 %).
- **Cutting.** Strips run back from the block's longest way (square to it), or along the contours where the block slopes more than 6 % (strip fields excepted); a block deeper than a furlong is cut across into furlongs, each with its own strips at random widths. Bocage cuts lean every which way.
- **Fitting to the map.** The cuts are straight lines in the lattice's straight-edged blocks, so each end runs from 40 m inside to the first drawn way (up to 35 m beyond the lattice edge, which the drawn way may lie off). A cut is drawn only on farmland: not in forest, rock, scree, glacier, heath, marsh or water, not on slopes over 40 %, not within 10 m of a building or in a plan's built-up strips (a 4 m mask), and clear of every way's clearance (6 / 5 / 4 / 2.5 / 1.5 m by class); its pieces' ends are found to within 0.4 m, and a piece shorter than 6 m is dropped. A chunk draws within 8 m of itself, judging each run whole (sampled 6 m further out), so neighbouring chunks agree on every line along their border (`test/fields.test.ts`).
- **Way-side hedges:** each side of each drawn way (not footpaths) is lined, with its style's chance (by a hash of the way and side), by a hedge 2.5 m beyond its clearance, stopping 14 m short of its ends and clear of other ways.
- **Drawing:** unhedged field edges as faint thin lines (0.5 CSS px, brown at 32 %); hedges as rows of green dots (0.8 px, every 2.4 px), each dot where the distance along its line's direction is a multiple of the spacing, so dots on a line crossing a chunk border line up. Under the water, roads and buildings.
- **Measured** (`dev/fields.ts`, seed 1, 9.4 km² per region): field edges and hedges per km² 9.5 and 6.9 in a lowland area with bocage, 8.7 and 0.9 in open-field lowland, 5.4 and 5.6 in hills, 3.6 and 0.8 in the mountains. Layout takes 6–10 ms per chunk on average (at most 19 ms) in node.

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

*(As implemented in `src/gen/poi.ts`, drawn by `src/render/symbols.ts`.)*

- **Church** at the centre of every village and town (§3.6).
- **Decided per chunk, at render time**, from the fine nodes round the chunk (± 46 nodes, each from its own chunk's solve, with receivers and region: the values the DEM's streams read), the ways drawn in the 3 × 3 chunks round it and the plans drawing into it. A chunk decides every point within 16 m of it, each from data within 680 m of the point (nodes) or seen alike by every chunk near it (ways, the plans' buildings and streets), so a symbol straddling a border is drawn whole by both chunks (`test/poi.test.ts`). Fixed chances come from a hash of the node or place.
  - **Hilltops:** a node higher than every node within 240 m (ties by hash), dry, standing at least 15 m above the mean of the ground 240 m round it, with no building within 20 m or street within 12 m. A *major summit* is also the highest within 640 m and 40 m above the ground 480 m round. On a hilltop: a **chapel** (20 % in lowland and hills, falling to 10 % in the mountains; not in alpine country, and only where a way passes within 120 m), else a **cross** (22 %, 20 % in the mountains; 55 % on a major summit from R = 0.52: summit crosses), else on a major summit a **triangulation point** (60 %).
  - **Wayside crosses** (calvaries): at 20 % of junctions where three or more ways meet, one of them a road (N, D or C), in the widest gap between them, the ways' clearance (6 / 5 / 4 / 2.5 / 1.5 m by class) over the half-gap's sine plus 5 m out (at most 30 m), off water and built-up land (as hilltops). Crosses at village entrances are thus common.
  - **Springs:** at stream heads (a node carrying a stream, by the DEM's threshold, that no stream flows into), from the hills up (R ≥ 0.25): 25 % rising to 50 % in alpine country.
- **Decided by the plans** (§3.6): a **water tower** for every town and 75 % of villages, on the highest dry node from the old core (at least 60 m) out to the reach (and 40 m inside the extent), 15 m from every way and building and within 100 m of a way, off industrial estates; in the mountains (R ≥ 0.52) a **reservoir** (blue square) there instead, for 60 % of villages and towns.
- **Symbols** (CSS px, ink as the church's): chapel, a 1.5 px open circle under a cross; cross, a Latin cross 6 px tall; triangulation point, a 5.6 px triangle with a dot; spring, a blue ring of 1.9 px with a dot; water tower, a 2.4 px ring round a dot; reservoir, a 3.4 px blue square. Drawn last, over the roads.
- **Measured** (`dev/pois.ts`, seed 1, 9.4 km² per region): lowland 0.95 crosses, 0.11 chapels, 0.11 triangulation points, 0.21 water towers per km²; hills 0.64 crosses, 0.21 chapels, 0.53 springs; mountains 0.64 crosses, 0.21 triangulation points, 0.95 springs.

**Planned:** cemeteries beside villages, watermills on streams, windmills in the lowlands, caves at the foot of cliffs, ruins on hilltops, viewpoints, wind turbines on open ridges, spot heights (they need text, which the map doesn't draw), and power lines with pylons connecting towns via substations.

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
- Workers cache what overlapping tasks share, keyed by the seeds it depends on: coarse tiles, coarse heights on the 128 m grid, meander costs per chunk (each in 49 window solves), and the net's vertex terrain, edge costs and corridor paths (neighbouring cells read much the same land; pruned to about 16 km around the latest cell). The net caches are dropped when a tile position turns up with other seeds (land forgotten and made anew; `test/netcache.test.ts`).

## 6. Code layout (planned)

```
src/
  main.ts            viewport, input, pan clamp, compositor, km grid and margin
  chunks/            ChunkManager, scheduler, retention, stage graph
  worker/            worker entry, message protocol
  gen/region.ts      gen/terrain.ts  gen/hydro.ts  gen/landuse.ts
  gen/settle.ts      gen/lattice.ts  gen/builtup.ts gen/symbols.ts
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
  - street plans (synthetic villages and towns): buildings clear of ways, water and each other, both densities present; industrial estates in towns on flat land (sheds and halls, on flat ground) and none on a steady 13 % slope; the same plan whatever order the roads come in, streets meet roads and each other only at junctions, every street connected, off water, within the plan's extent, redrawn roads keep their far ends, tracks through built-up land become streets, woods cleared under built-up land
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
