import { clampZoom, type Viewport, type ViewState } from './viewport';

interface Anchor {
  wx: number;
  wy: number;
  zoom: number;
  dist: number;
}

/**
 * Pointer, wheel and keyboard input. Input only moves the *desired* view; the
 * frame loop moves the actual view toward it as far as generated land allows.
 */
export class Input {
  dragging = false;
  /** Fling velocity in world m/s. */
  vx = 0;
  vy = 0;
  /** Set whenever the zoom was changed by the user (for render-bucket settling). */
  lastZoomAt = 0;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private anchor: Anchor | null = null;
  private samples: { t: number; x: number; y: number }[] = [];
  private readonly keys = new Set<string>();

  constructor(
    el: HTMLElement,
    private readonly vp: Viewport,
    private readonly actual: ViewState,
    private readonly desired: ViewState,
  ) {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.vx = this.vy = 0;
      this.reanchor();
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.follow();
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (this.pointers.size === 0) this.release();
      else this.reanchor();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.vp.h : 1;
        if (e.ctrlKey || e.metaKey) {
          this.zoomAt(e.clientX, e.clientY, Math.exp((-e.deltaY * unit) / 150));
        } else {
          const m = this.vp.mPerPx(this.desired.zoom);
          this.desired.x += e.deltaX * unit * m;
          this.desired.y += e.deltaY * unit * m;
        }
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this.zoomAt(this.vp.w / 2, this.vp.h / 2, 1.25);
      else if (e.key === '-' || e.key === '_') this.zoomAt(this.vp.w / 2, this.vp.h / 2, 0.8);
      else this.keys.add(e.key);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Per-frame: keyboard panning and fling inertia. */
  tick(dt: number): void {
    const m = this.vp.mPerPx(this.desired.zoom);
    const speed = Math.max(this.vp.w, this.vp.h) * 0.7 * m;
    let kx = 0;
    let ky = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('a')) kx -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('d')) kx += 1;
    if (this.keys.has('ArrowUp') || this.keys.has('w')) ky -= 1;
    if (this.keys.has('ArrowDown') || this.keys.has('s')) ky += 1;
    this.desired.x += kx * speed * dt;
    this.desired.y += ky * speed * dt;

    if (!this.dragging && (this.vx || this.vy)) {
      this.desired.x += this.vx * dt;
      this.desired.y += this.vy * dt;
      const decay = Math.exp(-dt * 3.5);
      this.vx *= decay;
      this.vy *= decay;
      if (Math.hypot(this.vx, this.vy) < 2 * m) this.vx = this.vy = 0;
    }
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.vp.toWorld(this.desired, sx, sy);
    const z = clampZoom(this.desired.zoom * factor);
    const [x, y] = this.vp.centreFor(wx, wy, sx, sy, z);
    Object.assign(this.desired, { x, y, zoom: z });
    this.lastZoomAt = performance.now();
  }

  private mid(): { x: number; y: number; dist: number } {
    const ps = [...this.pointers.values()];
    if (ps.length === 1) return { ...ps[0], dist: 1 };
    const [a, b] = ps;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)) };
  }

  /** Restart the gesture from the actual view so the desired view can't run away. */
  private reanchor(): void {
    Object.assign(this.desired, this.actual);
    const m = this.mid();
    const [wx, wy] = this.vp.toWorld(this.actual, m.x, m.y);
    this.anchor = { wx, wy, zoom: this.actual.zoom, dist: m.dist };
    this.dragging = true;
    this.samples = [];
  }

  private follow(): void {
    const a = this.anchor;
    if (!a) return;
    const m = this.mid();
    const zoom = this.pointers.size > 1 ? clampZoom((a.zoom * m.dist) / a.dist) : a.zoom;
    if (zoom !== this.desired.zoom) this.lastZoomAt = performance.now();
    const [x, y] = this.vp.centreFor(a.wx, a.wy, m.x, m.y, zoom);
    Object.assign(this.desired, { x, y, zoom });
    const t = performance.now();
    this.samples.push({ t, x, y });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }

  private release(): void {
    this.dragging = false;
    this.anchor = null;
    const s = this.samples;
    const t = performance.now();
    if (s.length >= 2 && t - s[s.length - 1].t < 60) {
      const a = s[0];
      const b = s[s.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0.01) {
        this.vx = (b.x - a.x) / dt;
        this.vy = (b.y - a.y) / dt;
        // Cap at ~2 screens per second so a fling can't outrun generation by kilometres.
        const max = 2 * Math.max(this.vp.w, this.vp.h) * this.vp.mPerPx(this.actual.zoom);
        const v = Math.hypot(this.vx, this.vy);
        if (v > max) {
          this.vx *= max / v;
          this.vy *= max / v;
        }
      }
    }
    // Continue from where the map actually is, not where the finger was.
    this.desired.x = this.actual.x;
    this.desired.y = this.actual.y;
    this.desired.zoom = this.actual.zoom;
  }
}
