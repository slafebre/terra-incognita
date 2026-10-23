# Topo

An infinite, emergent topographic map at 1:10,000 in the style of IGN Top25. Land that scrolls more than about 4 km out of view is forgotten and regenerates differently when you come back. See [SPEC.md](SPEC.md).

```
npm install
npm run dev        # http://localhost:5173
```

URL parameters (debugging): `?debug` shows chunk stages and timings, `?at=x,y` sets the start position (world metres), `?z=0.5` sets the start zoom, and `?R=0.9` forces the region everywhere (0 = lowland … 1 = alpine).

```
npm test
```

Dev tools:
- `/dev/overview.html?size=24000` renders a 24 km overview of the un-eroded terrain, tinted by region type.
- `npx vite-node dev/probe.ts` drives the whole pipeline in-process (no workers) and prints per-task timings.
- `npx vite-node dev/coverstats.ts [areas] [R,R,…]` reports land cover percentages per region type (for calibration).
- `npx vite-node dev/netstats.ts [cells] [R,R,…]` reports way density per class (N, D, C, track, footpath) and site density from net cells alone (fast, no fine terrain).
- `npx vite-node dev/roadstats.ts [areas] [R,R,…]` runs the whole pipeline on seeded, reproducible areas (`SEED=n`) and reports per region type: small closed loops, crossings away from junctions, length running alongside another road, dead ends, unreached settlements, and the share of each class steeper than its limit on the fine terrain. Options: `SHEET=<prefix>` (SVG contact sheet of the loops), `DUMP=<prefix>` (SVG of each area), `DEAD=<prefix>` (sheet of dead ends), `DETOURS=1` (main-road detours with coarse vs fine gradient), `GRADECMP=1` (coarse vs fine heights and gradients), `LOOP_HA` (loop size threshold, ha).
- `npx vite-node dev/detours.ts [R] [cells]` finds main-road detours in net cells alone and compares the direct lattice edge's cost with the detour's.

Controls: drag or arrow keys/WASD to pan, pinch, ctrl/⌘+wheel, trackpad pinch or +/- to zoom (0.5×–2×).
