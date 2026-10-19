# Topo

An infinite, emergent topographic map at 1:10,000 in the style of IGN Top25. Land that scrolls more than about 4 km out of view is forgotten and regenerates differently when you come back. See [SPEC.md](SPEC.md).

```
npm install
npm run dev        # http://localhost:5173  (add ?debug for chunk/timing overlay, ?at=x,y to jump)
npm test
```

Dev tool: `/dev/overview.html?size=24000` renders a 24 km overview tinted by region type, for tuning terrain.

Controls: drag or arrow keys/WASD to pan, pinch, ctrl/⌘+wheel, trackpad pinch or +/- to zoom (0.5×–2×).
