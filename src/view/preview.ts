import type { Chunk } from '../chunks/manager';
import { NODE, NODES } from '../gen/hydro';
import { STYLE } from '../render/style';

/**
 * Placeholders for chunks not drawn yet: a soft shaded relief of the chunk's `pre`
 * surface, which the manager makes first for the chunks to draw (within a second or
 * so, nearest first), so the land shows from the centre out while the map is being
 * made; the drawn chunks then fade in over it. (The eroded solves came later and, unblended,
 * showed each solve's D8 stripes and seams between chunks.)
 */

/** Nodes kept beyond the chunk, so the upscaled sketch runs on into its neighbours. */
export const PREVIEW_PAD = 1;
const W = NODES + 2 * PREVIEW_PAD;
/** How dark the shade gets. */
const DEPTH = 0.3;
/** Fade-in time (ms) of a sketch, and of the drawn chunk over it. */
export const FADE_MS = 350;

const az = (STYLE.lightAzimuthDeg * Math.PI) / 180;
const alt = (STYLE.lightAltitudeDeg * Math.PI) / 180;
const LX = Math.cos(alt) * Math.sin(az);
const LY = -Math.cos(alt) * Math.cos(az);
const LZ = Math.sin(alt);

export interface Preview {
  /** W × W pixels, one per node; the chunk is the inner NODES × NODES. */
  img: OffscreenCanvas;
  /** When it was first shown (ms), for its fade-in. */
  shown: number;
}

/** Sketches, and which of the chunk's 8 neighbours had their surface when made (bit mask). */
const previews = new WeakMap<Chunk, Preview & { around: number }>();

/** The chunk's sketch, made (or remade as its neighbours' surfaces come) as needed; undefined until it has its surface. */
export function chunkPreview(c: Chunk, get: (cx: number, cy: number) => Chunk | undefined, now: number): Preview | undefined {
  if (!c.pre) return undefined;
  let around = 0;
  let bit = 1;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (get(c.cx + dx, c.cy + dy)?.pre) around |= bit;
      bit <<= 1;
    }
  const old = previews.get(c);
  if (old?.around === around) return old;
  const p = { around, img: sketch(c, get), shown: old?.shown ?? now };
  previews.set(c, p);
  return p;
}

function sketch(c: Chunk, get: (cx: number, cy: number) => Chunk | undefined): OffscreenCanvas {
  // Height at node (i, j) of the chunk, i and j from −PAD − 1 to NODES + PAD: from the
  // neighbour holding the node, else the chunk's nearest node.
  const z = (i: number, j: number): number => {
    const di = Math.floor(i / NODES);
    const dj = Math.floor(j / NODES);
    const n = di || dj ? get(c.cx + di, c.cy + dj) : c;
    if (n?.pre) return n.pre.zPre[(j - dj * NODES) * NODES + i - di * NODES];
    const ci = Math.min(NODES - 1, Math.max(0, i));
    const cj = Math.min(NODES - 1, Math.max(0, j));
    return c.pre!.zPre[cj * NODES + ci];
  };
  const [pr, pg, pb] = STYLE.paper;
  const img = new ImageData(W, W);
  const d = img.data;
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = x - PREVIEW_PAD;
      const j = y - PREVIEW_PAD;
      // As the map's hillshade (render/chunkRender.ts), on the 16 m nodes.
      const gx = (z(i + 1, j) - z(i - 1, j)) / (2 * NODE);
      const gy = (z(i, j + 1) - z(i, j - 1)) / (2 * NODE);
      const dot = (-gx * LX - gy * LY + LZ) / Math.sqrt(gx * gx + gy * gy + 1);
      const s = Math.min(1, Math.max(0, 1 - dot / LZ));
      const f = 1 - DEPTH * s;
      const o = 4 * (y * W + x);
      d[o] = pr * f;
      d[o + 1] = pg * f;
      d[o + 2] = pb * f;
      d[o + 3] = 255;
    }
  const canvas = new OffscreenCanvas(W, W);
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return canvas;
}
