import type { Lang } from './lang';
import { WELCOME } from './welcomeText';

/** Set once the sheet has been closed, so it greets each browser only once. */
const SEEN_KEY = 'topo.welcomed';

/**
 * Welcome sheet: what the map is and how to get around, laid out like a map's
 * margin notes (paper, neatline, the margin's blue for the scale). Shown on the
 * first visit (or with `?welcome`); key `?` or the `?` in the bottom-left corner
 * of the margin brings it back. On a touch screen (`touch`) the controls are told as gestures and taps, without keys.
 */
export class Welcome {
  private readonly el = document.createElement('dialog');
  private readonly corner = document.createElement('button');

  constructor(lang: Lang, touch: boolean) {
    const t = WELCOME[lang];
    const { el, corner } = this;
    el.id = 'welcome';
    el.lang = corner.lang = lang;
    el.setAttribute('aria-labelledby', 'welcome-title');
    el.innerHTML = `
      <div class="sheet">
        <header>
          <div>
            <h1 id="welcome-title">${esc(t.title)}</h1>
            <p class="sub">${esc(t.subtitle)}</p>
          </div>
          <span class="scale">${esc(t.scale)}</span>
        </header>
        ${t.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
        <h3>${esc(t.controlsTitle)}</h3>
        <dl>${t.controls.map(([k, v, tap]) => `<dt>${esc(k)}</dt><dd>${touch ? esc(tap) : keys(v)}</dd>`).join('')}</dl>
        <footer><button data-act="close" autofocus>${esc(t.start)}</button></footer>
      </div>`;
    // A click on the dialog itself (not the sheet in it) is on the backdrop.
    // Remembered at once (the dialog's close event comes a task later); Escape closes it natively.
    el.addEventListener('click', (e) => {
      if (e.target !== el && !(e.target as HTMLElement).closest('[data-act="close"]')) return;
      remember();
      el.close();
    });
    el.addEventListener('close', remember);

    corner.id = 'welcome-corner';
    corner.textContent = '?';
    corner.title = t.reopen;
    corner.setAttribute('aria-label', t.reopen);
    corner.addEventListener('click', () => this.show());
    document.body.append(el, corner);
    window.addEventListener('keydown', (e) => {
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) this.show();
    });
  }

  show(): void {
    if (this.el.open) return;
    this.el.showModal();
    // Focus goes to the button; on a short screen, start from the top all the same.
    this.el.scrollTop = 0;
  }

  /** Not yet closed in this browser. */
  static firstVisit(): boolean {
    try {
      return localStorage.getItem(SEEN_KEY) === null;
    } catch {
      return true;
    }
  }
}

function remember(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage blocked: it greets again next time */
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** Escapes, then shows [bracketed] keys as keycaps, a run of them (`[W] [A] [S] [D]`) kept on one line. */
const keys = (s: string) =>
  esc(s).replace(/\[[^\]]+\](?: \[[^\]]+\])*/g, (run) => `<span class="keys">${run.replace(/\[(.+?)\]/g, '<kbd>$1</kbd>')}</span>`);
