import type { SeedStore } from '../gen/seeds';
import { BUILD_COMMIT, snapshotName, takeSnapshot } from '../snapshot';
import type { ViewState } from './viewport';

export interface InfoConfig {
  view: ViewState;
  seeds: SeedStore;
  /** Forced region (`?R`), or null. */
  R: number | null;
  /** World seed (`?seed`), or null: the land is emergent. */
  seed: number | null;
  /** The snapshot this land was replayed from (`?snap`), and the commit it was made with. */
  snap?: { path: string; commit: string };
}

/**
 * Reproduction panel (key `i`, or `?info`): what it takes to build the land on screen
 * again, in the browser and in the dev tools. With a world seed a link is enough;
 * emergent land needs its seeds, saved as a snapshot file.
 */
export class InfoPanel {
  private readonly el = document.createElement('div');
  private readonly fields = new Map<string, HTMLElement>();
  private timer = 0;

  constructor(private readonly cfg: InfoConfig) {
    const { el } = this;
    el.id = 'info';
    el.hidden = true;
    const land = cfg.snap ? `snapshot ${cfg.snap.path}` : cfg.seed !== null ? `hashed from seed ${cfg.seed}` : 'emergent (fresh seeds)';
    const warn =
      cfg.snap && cfg.snap.commit !== BUILD_COMMIT
        ? `<p class="warn">The snapshot was made at ${esc(cfg.snap.commit)}. This code is ${esc(BUILD_COMMIT)}, so the land may differ.</p>`
        : '';
    el.innerHTML = `
      <header><b>Reproduce this view</b><button data-act="close" aria-label="Close">×</button></header>
      <dl>
        <dt>Position</dt><dd data-f="pos"></dd>
        <dt>Land</dt><dd>${esc(land)}</dd>
        <dt>Region</dt><dd>${cfg.R === null ? 'natural' : `forced, R=${cfg.R}`}</dd>
        <dt>Code</dt><dd>${esc(BUILD_COMMIT)}</dd>
      </dl>
      ${warn}
      <label>Browser</label>
      <div class="copy"><code data-f="link"></code><button data-act="copy" data-src="link">Copy</button></div>
      <label>Dev tool</label>
      <div class="copy"><code data-f="cmd"></code><button data-act="copy" data-src="cmd">Copy</button></div>
      <button data-act="snap" class="snap">Download snapshot</button>
      <p class="note" data-f="note"></p>`;
    for (const f of el.querySelectorAll<HTMLElement>('[data-f]')) this.fields.set(f.dataset.f!, f);
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.act === 'close') this.toggle(false);
      else if (b.dataset.act === 'copy') void this.copy(b, this.fields.get(b.dataset.src!)!.textContent ?? '');
      else if (b.dataset.act === 'snap') void this.download(b);
    });
    document.body.append(el);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'i' && !e.metaKey && !e.ctrlKey && !e.altKey) this.toggle();
      else if (e.key === 'Escape') this.toggle(false);
    });
  }

  toggle(show = this.el.hidden): void {
    this.el.hidden = !show;
    clearInterval(this.timer);
    if (show) {
      this.refresh();
      this.timer = window.setInterval(() => this.refresh(), 250);
    }
  }

  /** Seed mode: a link. Otherwise: the snapshot file, expected in dev/snaps/. */
  private refresh(): void {
    const { view, R, seed } = this.cfg;
    const x = Math.round(view.x);
    const y = Math.round(view.y);
    const base = location.origin + location.pathname;
    const file = `dev/snaps/${snapshotName(x, y)}`;
    let link: string;
    let cmd: string;
    let note: string;
    if (seed !== null) {
      link = `${base}?seed=${seed}&at=${x},${y}&z=${view.zoom.toFixed(2)}${R === null ? '' : `&R=${R}`}`;
      cmd = `SEED=${seed} npx vite-node dev/spot.ts ${x} ${y}${R === null ? '' : ` ${R}`}`;
      note = 'With a world seed the link and command are enough; a snapshot isn’t needed.';
    } else {
      link = `${base}?snap=/${file}`;
      cmd = `SNAP=${file} npx vite-node dev/spot.ts`;
      const n = this.cfg.seeds.chunk.size + this.cfg.seeds.coarse.size;
      note = `Emergent land: save the snapshot as ${file}, which the link and command read. It holds every seed in memory (${n.toLocaleString('en')} now).`;
    }
    this.set('pos', `${x}, ${y}   zoom ${view.zoom.toFixed(2)}`);
    this.set('link', link);
    this.set('cmd', cmd);
    this.set('note', note);
  }

  private set(f: string, text: string): void {
    const e = this.fields.get(f)!;
    if (e.textContent !== text) e.textContent = text;
  }

  private async copy(b: HTMLButtonElement, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      flash(b, 'Copied');
    } catch {
      flash(b, 'Failed');
    }
  }

  private async download(b: HTMLButtonElement): Promise<void> {
    const { view, seeds, R, seed } = this.cfg;
    const snap = takeSnapshot(seeds, view, R, seed, await liveCommit());
    const url = URL.createObjectURL(new Blob([JSON.stringify(snap)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = snapshotName(snap.at[0], snap.at[1]);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(b, 'Saved');
  }
}

/** The dev server knows about edits made since it started; a build only has its own commit. */
async function liveCommit(): Promise<string> {
  if (import.meta.env.DEV) {
    try {
      const r = await fetch('/__commit');
      if (r.ok) return (await r.text()).trim();
    } catch {
      /* fall through */
    }
  }
  return BUILD_COMMIT;
}

function flash(b: HTMLButtonElement, text: string): void {
  const was = b.dataset.label ?? b.textContent ?? '';
  b.dataset.label = was;
  b.textContent = text;
  setTimeout(() => (b.textContent = was), 1200);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
