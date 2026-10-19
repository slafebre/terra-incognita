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

Controls: drag or arrow keys/WASD to pan, pinch, ctrl/⌘+wheel, trackpad pinch or +/- to zoom (0.5×–2×).
