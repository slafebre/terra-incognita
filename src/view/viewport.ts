import { M_PER_CSS_PX, ZOOM_MAX, ZOOM_MIN } from '../lib/constants';
import { clamp } from '../lib/noise';
import type { Rect } from '../gen/seeds';

/** Map view: centre in world metres (x east, y south) and zoom (1 = 1:10,000). */
export interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

export const clampZoom = (z: number) => clamp(z, ZOOM_MIN, ZOOM_MAX);

/** Zoom bucket used for chunk rasters: half-octave steps between 0.5 and 2. */
export const zoomBucket = (z: number) => Math.pow(2, Math.round(Math.log2(z) * 2) / 2);

export class Viewport {
  /** CSS pixels. */
  w = 1;
  h = 1;
  /** Backing-store pixels per CSS pixel. */
  dpr = 1;

  mPerPx(zoom: number): number {
    return M_PER_CSS_PX / zoom;
  }

  rect(s: ViewState): Rect {
    const m = this.mPerPx(s.zoom);
    const hw = (this.w / 2) * m;
    const hh = (this.h / 2) * m;
    return { x0: s.x - hw, y0: s.y - hh, x1: s.x + hw, y1: s.y + hh };
  }

  /** World point under CSS pixel (sx, sy). */
  toWorld(s: ViewState, sx: number, sy: number): [number, number] {
    const m = this.mPerPx(s.zoom);
    return [s.x + (sx - this.w / 2) * m, s.y + (sy - this.h / 2) * m];
  }

  /** View centre that puts world point (wx, wy) under CSS pixel (sx, sy) at `zoom`. */
  centreFor(wx: number, wy: number, sx: number, sy: number, zoom: number): [number, number] {
    const m = this.mPerPx(zoom);
    return [wx - (sx - this.w / 2) * m, wy - (sy - this.h / 2) * m];
  }
}
