import { EASTING0, NORTHING0 } from '../lib/constants';
import { STYLE } from '../render/style';
import type { Viewport, ViewState } from './viewport';

/** Width of the paper margin round the map (CSS px). */
export const MARGIN = 22;

/** Insets of the map face from the window edges (CSS px): the paper margin, wider on the right while the legend is out. */
export interface Insets {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** A span of the right margin (CSS px from the top) where no northing is printed. */
export type Gap = [number, number];

/**
 * Kilometre grid over the map face, then the paper margin round it: a neatline,
 * ticks where the grid lines meet it, and the kilometre numbers in the margin
 * (those on the left and right turned a quarter, their tops outward). Drawn in
 * CSS px (ctx already scaled by dpr).
 */
export function drawFrame(ctx: CanvasRenderingContext2D, vp: Viewport, s: ViewState, f: Insets, gap?: Gap): void {
  const r = vp.rect(s);
  const m = vp.mPerPx(s.zoom);
  const sx = (x: number) => (x - r.x0) / m;
  const sy = (y: number) => (y - r.y0) / m;
  const x0 = f.l;
  const y0 = f.t;
  const x1 = vp.w - f.r;
  const y1 = vp.h - f.b;
  const eastings: number[] = [];
  const northings: number[] = [];
  for (let x = Math.ceil(r.x0 / 1000) * 1000; x <= r.x1; x += 1000) {
    const px = Math.round(sx(x)) + 0.5;
    if (px > x0 && px < x1) eastings.push(x);
  }
  for (let y = Math.ceil(r.y0 / 1000) * 1000; y <= r.y1; y += 1000) {
    const py = Math.round(sy(y)) + 0.5;
    if (py > y0 && py < y1) northings.push(y);
  }

  ctx.save();
  ctx.strokeStyle = STYLE.grid;
  ctx.lineWidth = STYLE.gridWidth;
  ctx.beginPath();
  for (const x of eastings) {
    const px = Math.round(sx(x)) + 0.5;
    ctx.moveTo(px, y0);
    ctx.lineTo(px, y1);
  }
  for (const y of northings) {
    const py = Math.round(sy(y)) + 0.5;
    ctx.moveTo(x0, py);
    ctx.lineTo(x1, py);
  }
  ctx.stroke();

  // The margin: paper over everything outside the map face.
  const [pr, pg, pb] = STYLE.paper;
  ctx.fillStyle = `rgb(${pr},${pg},${pb})`;
  ctx.beginPath();
  ctx.rect(0, 0, vp.w, vp.h);
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.fill('evenodd');

  ctx.strokeStyle = STYLE.frame.neatline;
  ctx.lineWidth = STYLE.frame.neatlineWidth;
  const h = STYLE.frame.neatlineWidth / 2;
  ctx.strokeRect(x0 - h, y0 - h, x1 - x0 + 2 * h, y1 - y0 + 2 * h);

  // Ticks: the grid lines carried a little way into the margin.
  const tick = STYLE.frame.tick;
  ctx.strokeStyle = STYLE.gridLabel;
  ctx.lineWidth = STYLE.gridWidth;
  ctx.beginPath();
  for (const x of eastings) {
    const px = Math.round(sx(x)) + 0.5;
    ctx.moveTo(px, y0 - tick);
    ctx.lineTo(px, y0);
    ctx.moveTo(px, y1);
    ctx.lineTo(px, y1 + tick);
  }
  for (const y of northings) {
    const py = Math.round(sy(y)) + 0.5;
    ctx.moveTo(x0 - tick, py);
    ctx.lineTo(x0, py);
    ctx.moveTo(x1, py);
    ctx.lineTo(x1 + tick, py);
  }
  ctx.stroke();

  // Numbers centred on their lines, in the outer part of the margin; any that would
  // run past the neatline's ends (or into the gap) are left out.
  ctx.font = STYLE.frame.font;
  ctx.fillStyle = STYLE.gridLabel;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const mid = (MARGIN - tick) / 2;
  const fits = (c: number, half: number, lo: number, hi: number) => c - half >= lo && c + half <= hi;
  const turned = (t: string, x: number, y: number, a: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillText(t, 0, 0);
    ctx.restore();
  };
  for (const x of eastings) {
    const t = String(Math.round((EASTING0 + x) / 1000));
    const c = sx(x);
    if (!fits(c, ctx.measureText(t).width / 2, x0, x1)) continue;
    ctx.fillText(t, c, y0 - MARGIN + mid);
    ctx.fillText(t, c, y1 + MARGIN - mid);
  }
  for (const y of northings) {
    const t = String(Math.round((NORTHING0 - y) / 1000));
    const c = sy(y);
    const half = ctx.measureText(t).width / 2;
    if (!fits(c, half, y0, y1)) continue;
    // Left: reading up the page; right: reading down it.
    turned(t, x0 - MARGIN + mid, c, -Math.PI / 2);
    if (gap && c + half > gap[0] && c - half < gap[1]) continue;
    turned(t, x1 + MARGIN - mid, c, Math.PI / 2);
  }
  ctx.restore();
}
