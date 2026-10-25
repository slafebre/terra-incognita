# Developing Terra Incognita

Notes for working on the generator: debugging parameters, reproducing a view, and the command-line dev tools. For how the generator works, see [SPEC.md](../SPEC.md).

## Debugging parameters

`?debug` shows chunk stages and timings, `?at=x,y` sets the start position (world metres), `?z=0.5` sets the start zoom, `?R=0.9` forces the region everywhere (0 = lowland … 1 = alpine), `?seed=7` makes the world reproducible (seeds hashed from position instead of fresh), for comparing changes on the same land, and `?workers=n` sets the worker pool size.

## Reproducing a view

Press `i` (or add `?info`) for the reproduction panel: everything needed to rebuild the land on screen in the browser and in the dev tools. With `?seed=n` that is a link and a `SEED=n` command line. Emergent land needs its seeds: **Download snapshot** saves every seed held (about 0.6 MB) with the view, the forced region and the commit. Put the file in `dev/snaps/`, then `?snap=/dev/snaps/<file>` replays it in the browser (other parameters still win) and `SNAP=dev/snaps/<file>` replays it in `dev/spot.ts` (position defaults to the snapshot's) and `dev/towns.ts` (plans the settlement nearest the view). The same seeds only give the same land on the same code, so a snapshot made at another commit warns.

## Tests

```
npm test
```

## Dev tools

- `/dev/overview.html?size=24000` renders a 24 km overview of the un-eroded terrain, tinted by region type.
- `npx vite-node dev/probe.ts` drives the whole pipeline in-process (no workers) and prints per-task timings.
- `npx vite-node dev/coverstats.ts [areas] [R,R,…]` reports land cover percentages per region type (for calibration).
- `npx vite-node dev/netstats.ts [cells] [R,R,…]` reports way density per class (N, D, C, track, footpath) and site density from net cells alone (fast, no fine terrain). `SEED=n` picks the cells and seeds the world reproducibly, to compare changes.
- `SEED=n npx vite-node dev/spot.ts x y [R or -] [radius]` builds the pipeline around one place, seeded as the app's `?seed=n`, and lists the ways drawn near it. `SNAP=<file>` replays a snapshot instead (x y optional). `SVG=<file>` draws the land within the radius (5 m contours, streams, lakes, every way; routed tracks and footpaths in red); `GRADES=1` reports each class's mean grade and share over its limit, measured on the DEM.
- `OUT=<file> npx vite-node dev/golden.ts` runs the pipeline in-process around five seeded places (the region field, and lowland to alpine forced) and saves every task's output; `GOLD=<file> npx vite-node dev/golden.ts` compares with such a file, field by field (identical, or how many elements differ and by how much), and with its per-stage timings. For changes that should leave the land as it is (optimisations); `PLACES=n` uses the first n places, `SEED=n` another world seed.
- `npx vite-node dev/netbench.ts [block] [R]` times a block of neighbouring net cells built in turn, as a worker does (the first cold, then warm).
- `npx vite-node dev/seams.ts [firstSeed] [runs] [R]` runs the pipeline test's seam check with seeded `Math.random` (optionally with the region forced to R), so a bad run can be reproduced; prints the worst chunk border lines of runs above 1.3×.
- `npx vite-node dev/roadstats.ts [areas] [R,R,…]` runs the whole pipeline on seeded, reproducible areas (`SEED=n`) and reports per region type: small closed loops, crossings away from junctions, length running alongside another road, dead ends, unreached settlements, and the share of each class steeper than its limit on the fine terrain. Options: `SHEET=<prefix>` (SVG contact sheet of the loops), `DUMP=<prefix>` (SVG of each area), `DEAD=<prefix>` (sheet of dead ends), `DETOURS=1` (main-road detours with coarse vs fine gradient), `GRADECMP=1` (coarse vs fine heights and gradients), `HAIRPINS=<prefix>` (sheet of hairpins over 5 m contours; their apex radius, leg spacing and length are always reported), `PINLOG=1` (hairpin positions), `LOOPZOOM=<prefix>` (close-ups of small loops with every vertex), `LOOPLOG=1` (each small loop's position and the ways around it), `LOOP_HA` (loop size threshold, ha). It also reports road in lakes per class (crossings vs shore clips), way vertices under water, ways ending in or within 24 m of a lake, and lattice edges no chunk draws (paths are sampled every 8 m); `WET=<prefix>` (sheet of the crossings, lakes shaded), `WETLOG=1` (their positions as `?at=`), `LAKECMP=1` (lakes roads see vs lakes drawn), `HASHSEED=n` (seeds hashed from position, as the app's `?seed=n`, to look at a place in the browser), `COARSELOG=1` (positions of coarse-basin lakes); the `COARSE LAKES` line says how much of the lake area, wet road and wet vertices lie in the lakes of closed coarse basins.
- `npx vite-node dev/detours.ts [R] [cells]` finds main-road detours in net cells alone and compares the direct lattice edge's cost with the detour's.
- `npx vite-node dev/terraincmp.ts [areas] [R,R,…]` runs the pipeline on seeded areas and compares the coarse surface (what roads and settlements plan on) with the map's: heights and slopes over 256/512 m (with the best a 256 m sampling could do), height differences by drainage area, and the share of filled flats.
- `npx vite-node dev/towns.ts [per region] [R,R,…]` runs the pipeline around villages (`TOWNS=1`: towns, `HAMLETS=1`: hamlets, `FARMS=1`: farmsteads, framed 260 m round each, with counts of the forms chosen and why buildings were refused) found with a world seed (`SEED=n`, same as `?seed=n`) and writes each one's street plan as SVG over the fine terrain, plus a sheet of all (`OUT=<prefix>`). `INPUTS=<file>` caches the plans' inputs, so the plans can be tuned without rerunning the pipeline.
- `npx vite-node dev/fields.ts [km] [R,R,…]` runs the pipeline over a km × km area per region (`SEED=n`), lays out each chunk's field parcels as its render would and writes `<OUT>-R<r>.svg` (`OUT=fields`): woods, water, ways, buildings, field edges and hedges (`LATTICE=1` adds the lattice edges carrying ways, as the blocks see them). It reports field-edge and hedge length per km², blocks cut, blocks too large and furlong pieces, and the layout time per chunk.
- `npx vite-node dev/pois.ts [km] [R,R,…]` runs the pipeline over a km × km area per region (`SEED=n`) and counts the points of interest each chunk draws (hilltop chapels and crosses, triangulation points, wayside crosses, springs, water towers, reservoirs) per km²; `LOG=1` lists them as `?at=` positions.
- `npx vite-node dev/tilespread.ts [R,R,…]` measures how much overlapping coarse tiles disagree, by drainage area.
- `/dev/motorways.html?size=128000&x=..&y=..&seed=n&R=..&raw=1` draws the motorways (experimental, SPEC §3.5.1) over the coarse surface of a large area, with their noise line dashed, ends, towns and villages; `raw=1` also draws the dropped line, coloured by why (gate, alpine, sharp, loop, saddle, stub), and curves tighter than the minimum are ringed (listed in the console).
- `SEED=n npx vite-node dev/mwstats.ts [areas] [km] [R]` measures motorways on seeded areas: length per 100 km², ends per 100 km, tight curves, the share of their profile that is too steep and of their length where the ground lies far off it, and time.

