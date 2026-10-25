import { CHUNK, DPR_MAX } from './lib/constants';
import { ChunkManager, forChunksIn } from './chunks/manager';
import { STYLE } from './render/style';
import { drawFrame, MARGIN } from './view/frame';
import { Input } from './view/input';
import { clampZoom, Viewport, zoomBucket, type ViewState } from './view/viewport';
import { WorkerPool } from './worker/pool';
import { parseSnapshot, type Snapshot } from './snapshot';
import { InfoPanel } from './view/info';
import { Legend } from './view/legend';
import { pickLang } from './view/lang';
import { Welcome } from './view/welcome';
import './style.css';

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const loading = document.getElementById('loading')!;
const params = new URLSearchParams(location.search);
const debug = params.has('debug');
const num = (k: string) => (params.get(k) ? Number(params.get(k)) : undefined);

// Debug: `?snap=/dev/snaps/file.json` replays a snapshot saved from the info panel (key i):
// its seeds, view, region and world seed. Explicit parameters below still win.
// Only from this site: a link must not be able to feed the page someone else's file.
const snapPath = params.get('snap');
let snap: Snapshot | undefined;
if (snapPath) {
  try {
    const url = new URL(snapPath, location.href);
    if (url.origin !== location.origin) throw new Error('snapshots load from this site only');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    snap = parseSnapshot(await r.json());
  } catch (e) {
    loading.textContent = `Couldn’t load snapshot ${snapPath}: ${(e as Error).message}`;
    throw e;
  }
}

const vp = new Viewport();
// Start somewhere arbitrary: lattice points (like the origin) are where noise is flattest.
// `?at=x,y` (world metres) and `?z=zoom` are handy for debugging.
const at = params.get('at')?.split(',').map(Number) ?? snap?.at;
const actual: ViewState = {
  x: at?.[0] ?? Math.round((Math.random() - 0.5) * 2e6),
  y: at?.[1] ?? Math.round((Math.random() - 0.5) * 2e6),
  zoom: clampZoom((num('z') ?? snap?.z ?? 1) || 1),
};
const desired: ViewState = { ...actual };

let dirty = true;
// Debug: `?workers=n` sets the pool size.
const workers = num('workers') ?? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
// Debug: `?R=0.1` forces the region (0 lowland … 1 alpine) everywhere.
const region = num('R') ?? snap?.R ?? null;
const pool = new WorkerPool(workers, () => manager.schedule(), { regionOverride: region ?? NaN });
// Debug: `?seed=n` makes the world reproducible (the same place, the same land).
const seedParam = num('seed') ?? snap?.seed ?? null;
const worldSeed = seedParam === null ? null : seedParam >>> 0;
const manager = new ChunkManager(pool, () => (dirty = true), worldSeed ?? undefined);
if (snap) manager.seeds.load(snap);
const info = new InfoPanel({
  view: actual,
  seeds: manager.seeds,
  R: region,
  seed: worldSeed,
  snap: snap && snapPath ? { path: snapPath, commit: snap.commit } : undefined,
});
if (params.has('info')) info.toggle(true);
// `?lang=nl` (en, nl, fr, de) overrides the browser's language for the legend and welcome sheet.
const lang = pickLang(params.get('lang'), navigator.languages ?? [navigator.language]);
// No keyboard or mouse to speak of (a phone or tablet): the sheets leave out the keys.
const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
const legend = new Legend(lang, touch);
if (params.has('legend')) legend.toggle(true);
const welcome = new Welcome(lang, touch);
if (params.has('welcome') || Welcome.firstVisit()) welcome.show();
const input = new Input(canvas, vp, actual, desired);

function resize(): void {
  vp.w = window.innerWidth;
  vp.h = window.innerHeight;
  vp.dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
  canvas.width = Math.round(vp.w * vp.dpr);
  canvas.height = Math.round(vp.h * vp.dpr);
  canvas.style.width = `${vp.w}px`;
  canvas.style.height = `${vp.h}px`;
  manager.dpr = vp.dpr;
  dirty = true;
}
window.addEventListener('resize', resize);
resize();

// --- Moving the actual view toward the desired one, clamped to generated land ---

const lerpState = (a: ViewState, b: ViewState, t: number): ViewState => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  zoom: a.zoom * Math.pow(b.zoom / a.zoom, t),
});
const ok = (s: ViewState) => manager.covered(vp.rect(s));
const same = (a: ViewState, b: ViewState) =>
  Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.zoom - b.zoom) < 1e-6;

function approach(): boolean {
  if (same(actual, desired)) return false;
  // Nothing on screen to protect (start-up, resize): go straight there.
  if (ok(desired) || !ok(actual)) {
    Object.assign(actual, desired);
    return true;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (ok(lerpState(actual, desired, mid))) lo = mid;
    else hi = mid;
  }
  let next = lerpState(actual, desired, lo);
  // Slide along whichever axis is still free.
  for (const axis of ['x', 'y'] as const) {
    const trial = { ...next, [axis]: desired[axis] };
    if (ok(trial)) next = trial;
  }
  if (same(next, actual)) return false;
  Object.assign(actual, next);
  return true;
}

/** Keep the desired view within about one screen of the actual one. */
function leash(): void {
  const m = vp.mPerPx(actual.zoom);
  const max = Math.max(vp.w, vp.h) * m;
  const dx = desired.x - actual.x;
  const dy = desired.y - actual.y;
  const d = Math.hypot(dx, dy);
  if (d > max) {
    desired.x = actual.x + (dx / d) * max;
    desired.y = actual.y + (dy / d) * max;
  }
}

// --- Drawing ---

function draw(): void {
  const [pr, pg, pb] = STYLE.paper;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = `rgb(${pr},${pg},${pb})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const r = vp.rect(actual);
  const k = vp.dpr / vp.mPerPx(actual.zoom); // device px per metre
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  forChunksIn(r, (cx, cy) => {
    const c = manager.get(cx, cy);
    if (!c?.bitmap) return;
    const x0 = Math.round((cx * CHUNK - r.x0) * k);
    const y0 = Math.round((cy * CHUNK - r.y0) * k);
    const x1 = Math.round(((cx + 1) * CHUNK - r.x0) * k);
    const y1 = Math.round(((cy + 1) * CHUNK - r.y0) * k);
    ctx.drawImage(c.bitmap, x0, y0, x1 - x0, y1 - y0);
  });

  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  drawFrame(ctx, vp, actual, { l: MARGIN, t: MARGIN, r: legend.right(vp.w), b: MARGIN }, legend.gap(vp.h));
  legend.layout(vp.w);
  if (debug) drawDebug(r, k);
}

function drawDebug(r: { x0: number; y0: number }, k: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1;
  for (const c of manager.chunks.values()) {
    const x = (c.cx * CHUNK - r.x0) * k;
    const y = (c.cy * CHUNK - r.y0) * k;
    const s = CHUNK * k;
    if (x > canvas.width || y > canvas.height || x + s < 0 || y + s < 0) continue;
    ctx.strokeStyle = c.failed
      ? 'red'
      : c.bitmap
        ? 'rgba(0,150,0,0.4)'
        : c.dem
          ? 'orange'
          : c.hydro
            ? 'purple'
            : c.pre
              ? 'rgba(0,0,255,0.3)'
              : 'rgba(0,0,0,0.2)';
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    if (c.busy) {
      ctx.fillStyle = 'rgba(255,0,0,0.12)';
      ctx.fillRect(x, y, s, s);
    }
  }
  const st = manager.stats;
  const avg = (k: 'pre' | 'hydro' | 'dem' | 'render') => `${k} ${(st[k].ms / Math.max(1, st[k].n)).toFixed(1)}ms×${st[k].n}`;
  const lines = [
    `chunks ${manager.chunks.size}  seeds ${manager.seeds.chunk.size}+${manager.seeds.coarse.size}  errors ${st.errors}`,
    `${avg('pre')}  ${avg('hydro')}`,
    `${avg('dem')}  ${avg('render')}`,
    `zoom ${actual.zoom.toFixed(2)} bucket ${manager.renderBucket} px ${manager.pxSize} workers ${pool.size}`,
  ];
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(MARGIN + 8, MARGIN + 8, 380, lines.length * 16 + 8);
  ctx.fillStyle = '#000';
  lines.forEach((l, i) => ctx.fillText(l, MARGIN + 14, MARGIN + 24 + i * 16));
}

// --- Frame loop ---

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  input.tick(dt);
  leash();
  if (approach()) dirty = true;
  if (legend.tick(dt)) dirty = true;

  const b = zoomBucket(actual.zoom);
  if (b !== manager.renderBucket && now - input.lastZoomAt > 250 && !input.dragging) manager.renderBucket = b;

  manager.update(vp.rect(actual), vp.rect(desired), [desired.x, desired.y]);
  loading.hidden = ok(actual);
  if (dirty || debug) {
    draw();
    dirty = false;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window, { topo: { manager, actual, desired, vp } });
