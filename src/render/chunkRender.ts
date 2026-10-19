import { APRON, CELL, CELLS, CHUNK, DEM_W } from '../lib/constants';
import { marchingSquares } from '../lib/contours';
import { CONTOURS, STYLE } from './style';

export interface RenderInput {
  dem: Float32Array;
  /** Raster edge length in device pixels. */
  pxSize: number;
  /** Device pixels per CSS pixel (line widths are specified in CSS px). */
  dpr: number;
}

const az = (STYLE.lightAzimuthDeg * Math.PI) / 180;
const alt = (STYLE.lightAltitudeDeg * Math.PI) / 180;
// World axes: x east, y south. Azimuth is clockwise from north.
const LX = Math.cos(alt) * Math.sin(az);
const LY = -Math.cos(alt) * Math.cos(az);
const LZ = Math.sin(alt);

/** Per-vertex shadow amount (0 = none, 1 = full) and slope (m/m). */
function shadeAndSlope(dem: Float32Array): { shade: Float32Array; slope: Float32Array } {
  const shade = new Float32Array(DEM_W * DEM_W);
  const slope = new Float32Array(DEM_W * DEM_W);
  for (let j = 1; j < DEM_W - 1; j++) {
    for (let i = 1; i < DEM_W - 1; i++) {
      const k = j * DEM_W + i;
      const gx = (dem[k + 1] - dem[k - 1]) / (2 * CELL);
      const gy = (dem[k + DEM_W] - dem[k - DEM_W]) / (2 * CELL);
      const dot = (-gx * LX - gy * LY + LZ) / Math.sqrt(gx * gx + gy * gy + 1);
      const s = 1 - dot / LZ;
      shade[k] = s < 0 ? 0 : s > 1 ? 1 : s;
      slope[k] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return { shade, slope };
}

export function renderChunk({ dem, pxSize, dpr }: RenderInput): OffscreenCanvas {
  const canvas = new OffscreenCanvas(pxSize, pxSize);
  const ctx = canvas.getContext('2d')!;
  const pxPerM = pxSize / CHUNK;
  const { shade, slope } = shadeAndSlope(dem);

  // --- Hillshade over paper ---------------------------------------------
  const img = ctx.createImageData(pxSize, pxSize);
  const data = img.data;
  const [pr, pg, pb] = STYLE.paper;
  const k = STYLE.shadeStrength;
  const sr = 1 - STYLE.shadow[0] / 255;
  const sg = 1 - STYLE.shadow[1] / 255;
  const sb = 1 - STYLE.shadow[2] / 255;
  const col0 = new Int32Array(pxSize);
  const colF = new Float32Array(pxSize);
  for (let p = 0; p < pxSize; p++) {
    const u = APRON + (p + 0.5) / pxPerM / CELL;
    col0[p] = Math.floor(u);
    colF[p] = u - col0[p];
  }
  let o = 0;
  for (let py = 0; py < pxSize; py++) {
    const j = col0[py];
    const fy = colF[py];
    const r0 = j * DEM_W;
    const r1 = r0 + DEM_W;
    for (let px = 0; px < pxSize; px++) {
      const i = col0[px];
      const fx = colF[px];
      const top = shade[r0 + i] + (shade[r0 + i + 1] - shade[r0 + i]) * fx;
      const bot = shade[r1 + i] + (shade[r1 + i + 1] - shade[r1 + i]) * fx;
      const s = (top + (bot - top) * fy) * k;
      data[o++] = pr * (1 - s * sr);
      data[o++] = pg * (1 - s * sg);
      data[o++] = pb * (1 - s * sb);
      data[o++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // --- Adaptive contours ------------------------------------------------
  // Process one cell beyond the chunk on each side so strokes overlap the border.
  const cellSlope = (i: number, j: number) => {
    const a = j * DEM_W + i;
    return (slope[a] + slope[a + 1] + slope[a + DEM_W] + slope[a + DEM_W + 1]) / 4;
  };
  const { byLevel } = marchingSquares(
    dem,
    DEM_W,
    APRON - 1,
    APRON - 1,
    APRON + CELLS + 1,
    APRON + CELLS + 1,
    CONTOURS.interval,
    (L, i, j) => {
      if (L % 50 === 0) return true;
      const s = cellSlope(i, j);
      return L % 10 === 0 ? s <= CONTOURS.slopeDrop10 : s <= CONTOURS.slopeDrop5;
    },
  );

  const scale = CELL * pxPerM;
  const normal = new Path2D();
  const index = new Path2D();
  for (const [L, segs] of byLevel) {
    const path = L % 25 === 0 ? index : normal;
    for (let n = 0; n < segs.length; n += 4) {
      path.moveTo((segs[n] - APRON) * scale, (segs[n + 1] - APRON) * scale);
      path.lineTo((segs[n + 2] - APRON) * scale, (segs[n + 3] - APRON) * scale);
    }
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = STYLE.contour;
  ctx.lineWidth = STYLE.contourWidth * dpr;
  ctx.stroke(normal);
  ctx.strokeStyle = STYLE.contourIndex;
  ctx.lineWidth = STYLE.contourIndexWidth * dpr;
  ctx.stroke(index);

  return canvas;
}
