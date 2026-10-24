# Topo

An infinite, emergent topographic map at 1:10,000 in the style of IGN Top25. Land that scrolls more than about 4 km out of view is forgotten and regenerates differently when you come back. See [SPEC.md](SPEC.md).

```
npm install
npm run dev        # http://localhost:5173
```

URL parameters (debugging): `?debug` shows chunk stages and timings, `?at=x,y` sets the start position (world metres), `?z=0.5` sets the start zoom, `?R=0.9` forces the region everywhere (0 = lowland … 1 = alpine), and `?seed=7` makes the world reproducible (seeds hashed from position instead of fresh), for comparing changes on the same land.

Press `i` (or add `?info`) for the reproduction panel: everything needed to rebuild the land on screen in the browser and in the dev tools. With `?seed=n` that is a link and a `SEED=n` command line. Emergent land needs its seeds: **Download snapshot** saves every seed held (about 0.6 MB) with the view, the forced region and the commit. Put the file in `dev/snaps/`, then `?snap=/dev/snaps/<file>` replays it in the browser (other parameters still win) and `SNAP=dev/snaps/<file>` replays it in `dev/spot.ts` (position defaults to the snapshot's) and `dev/towns.ts` (plans the settlement nearest the view). The same seeds only give the same land on the same code, so a snapshot made at another commit warns.

```
npm test
```

Dev tools:
- `/dev/overview.html?size=24000` renders a 24 km overview of the un-eroded terrain, tinted by region type.
- `npx vite-node dev/probe.ts` drives the whole pipeline in-process (no workers) and prints per-task timings.
- `npx vite-node dev/coverstats.ts [areas] [R,R,…]` reports land cover percentages per region type (for calibration).
- `npx vite-node dev/netstats.ts [cells] [R,R,…]` reports way density per class (N, D, C, track, footpath) and site density from net cells alone (fast, no fine terrain).
- `SEED=n npx vite-node dev/spot.ts x y [R] [radius]` builds the pipeline around one place, seeded as the app's `?seed=n`, and lists the ways drawn near it. `SNAP=<file>` replays a snapshot instead (x y optional).
- `npx vite-node dev/netbench.ts [block] [R]` times a block of neighbouring net cells built in turn, as a worker does (the first cold, then warm).
- `npx vite-node dev/seams.ts [firstSeed] [runs] [R]` runs the pipeline test's seam check with seeded `Math.random` (optionally with the region forced to R), so a bad run can be reproduced; prints the worst chunk border lines of runs above 1.3×.
- `npx vite-node dev/roadstats.ts [areas] [R,R,…]` runs the whole pipeline on seeded, reproducible areas (`SEED=n`) and reports per region type: small closed loops, crossings away from junctions, length running alongside another road, dead ends, unreached settlements, and the share of each class steeper than its limit on the fine terrain. Options: `SHEET=<prefix>` (SVG contact sheet of the loops), `DUMP=<prefix>` (SVG of each area), `DEAD=<prefix>` (sheet of dead ends), `DETOURS=1` (main-road detours with coarse vs fine gradient), `GRADECMP=1` (coarse vs fine heights and gradients), `HAIRPINS=<prefix>` (sheet of hairpins over 5 m contours; their apex radius, leg spacing and length are always reported), `PINLOG=1` (hairpin positions), `LOOPZOOM=<prefix>` (close-ups of small loops with every vertex), `LOOP_HA` (loop size threshold, ha). It also reports road in lakes per class (crossings vs shore clips), way vertices under water, ways ending in or within 24 m of a lake, and lattice edges no chunk draws (paths are sampled every 8 m); `WET=<prefix>` (sheet of the crossings, lakes shaded), `WETLOG=1` (their positions as `?at=`), `LAKECMP=1` (lakes roads see vs lakes drawn), `HASHSEED=n` (seeds hashed from position, as the app's `?seed=n`, to look at a place in the browser), `COARSELOG=1` (positions of coarse-basin lakes); the `COARSE LAKES` line says how much of the lake area, wet road and wet vertices lie in the lakes of closed coarse basins.
- `npx vite-node dev/detours.ts [R] [cells]` finds main-road detours in net cells alone and compares the direct lattice edge's cost with the detour's.
- `npx vite-node dev/terraincmp.ts [areas] [R,R,…]` runs the pipeline on seeded areas and compares the coarse surface (what roads and settlements plan on) with the map's: heights and slopes over 256/512 m (with the best a 256 m sampling could do), height differences by drainage area, and the share of filled flats.
- `npx vite-node dev/towns.ts [per region] [R,R,…]` runs the pipeline around villages (`TOWNS=1`: towns, `HAMLETS=1`: hamlets) found with a world seed (`SEED=n`, same as `?seed=n`) and writes each one's street plan as SVG over the fine terrain, plus a sheet of all (`OUT=<prefix>`). `INPUTS=<file>` caches the plans' inputs, so the plans can be tuned without rerunning the pipeline.
- `npx vite-node dev/tilespread.ts [R,R,…]` measures how much overlapping coarse tiles disagree, by drainage area.

Controls: drag or arrow keys/WASD to pan, pinch, ctrl/⌘+wheel, trackpad pinch or +/- to zoom (0.5×–2×).
