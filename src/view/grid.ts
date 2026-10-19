import { EASTING0, NORTHING0 } from '../lib/constants';
import { STYLE } from '../render/style';
import type { Viewport, ViewState } from './viewport';

/** Kilometre grid with edge labels, drawn in CSS px (ctx already scaled by dpr). */
export function drawGrid(ctx: CanvasRenderingContext2D, vp: Viewport, s: ViewState): void {
  const r = vp.rect(s);
  const m = vp.mPerPx(s.zoom);
  const sx = (x: number) => (x - r.x0) / m;
  const sy = (y: number) => (y - r.y0) / m;

  ctx.save();
  ctx.strokeStyle = STYLE.grid;
  ctx.lineWidth = STYLE.gridWidth;
  ctx.beginPath();
  for (let x = Math.ceil(r.x0 / 1000) * 1000; x <= r.x1; x += 1000) {
    const px = Math.round(sx(x)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, vp.h);
  }
  for (let y = Math.ceil(r.y0 / 1000) * 1000; y <= r.y1; y += 1000) {
    const py = Math.round(sy(y)) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(vp.w, py);
  }
  ctx.stroke();

  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = STYLE.gridLabel;
  ctx.strokeStyle = 'rgba(252, 250, 243, 0.9)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  const label = (t: string, x: number, y: number) => {
    ctx.strokeText(t, x, y);
    ctx.fillText(t, x, y);
  };
  ctx.textAlign = 'center';
  for (let x = Math.ceil(r.x0 / 1000) * 1000; x <= r.x1; x += 1000) {
    const t = String(Math.round((EASTING0 + x) / 1000));
    label(t, sx(x), 14);
    label(t, sx(x), vp.h - 6);
  }
  ctx.textBaseline = 'middle';
  for (let y = Math.ceil(r.y0 / 1000) * 1000; y <= r.y1; y += 1000) {
    const t = String(Math.round((NORTHING0 - y) / 1000));
    ctx.textAlign = 'left';
    label(t, 5, sy(y));
    ctx.textAlign = 'right';
    label(t, vp.w - 5, sy(y));
  }
  ctx.restore();
}
