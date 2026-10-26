import type { Lang } from './lang';

/**
 * Loading progress as a paper map's scale bar: a true scale bar for the zoom (a left
 * part of one unit cut into SUB blocks, then two whole units, numbered in metres or
 * kilometres), whose blocks fill in from the left, dark and light in turn, as the land
 * the view needs is made, captioned "Loading…". Full, it is an ordinary scale bar; then
 * it fades out.
 */

const WORD: Record<Lang, string> = { en: 'Scale', nl: 'Schaal', fr: 'Échelle', de: 'Maßstab' };
/** Caption under the bar, saying what its filling means. */
const LOADING: Record<Lang, string> = { en: 'Loading…', nl: 'Laden…', fr: 'Chargement…', de: 'Wird geladen…' };
/** Units the bar may count in (m): the largest whose bar fits is used. */
const UNITS = [50, 100, 200, 250, 500, 1000, 2000, 5000];
/** Blocks the left unit is cut into. */
const SUB = 4;
const INK = 'rgb(40, 34, 30)';
const LIGHT = 'rgb(196, 186, 168)';
const BLUE = 'rgb(30, 100, 200)';
/** Room round the bar for its end numbers (CSS px), and the least width (for the title). */
const SIDE = 20;
const MIN_WIDTH = 170;
/** Least width of the left unit (px) for its half-way number. */
const MID_LABEL_MIN = 60;
const BAR_H = 6;
const TITLE_Y = 9;
const NUM_Y = 23;
const BAR_Y = 27;
const CAPTION_Y = BAR_Y + BAR_H + 13;
const HEIGHT = CAPTION_Y + 3;

/** "1:10,000" as the language writes it (French: 1/10 000). */
function ratio(lang: Lang, n: number): string {
  const sep = lang === 'en' ? ',' : lang === 'fr' ? ' ' : '.';
  const digits = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return lang === 'fr' ? `1/${digits}` : `1:${digits}`;
}

const svgNs = 'http://www.w3.org/2000/svg';

export class ScaleBar {
  private layoutKey = '';
  /** Fill rectangles of the blocks, left to right, and each block's [x0, x1] (px). */
  private fills: { rect: SVGRectElement; x0: number; x1: number }[] = [];
  private width = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly lang: Lang,
  ) {}

  /**
   * Draws the bar for the zoom (CSS px per metre, and the nominal scale 1:10,000 / zoom),
   * at most `maxWidth` px wide, filled to `progress` (0..1).
   */
  draw(pxPerM: number, zoom: number, maxWidth: number, progress: number): void {
    let unit = UNITS[0];
    for (const u of UNITS) if (3 * u * pxPerM <= maxWidth - 2 * SIDE) unit = u;
    const scale = Math.round(10000 / zoom / 100) * 100;
    const key = `${unit}:${pxPerM.toFixed(4)}:${scale}`;
    if (key !== this.layoutKey) this.layout(unit, pxPerM, scale, key);
    const x = progress * this.width;
    for (const f of this.fills) f.rect.setAttribute('width', String(Math.max(0, Math.min(f.x1, x) - f.x0)));
  }

  private layout(unit: number, pxPerM: number, scale: number, key: string): void {
    this.layoutKey = key;
    const u = unit * pxPerM;
    this.width = 3 * u;
    // Block edges from the left end: SUB small ones over the first unit, then two units.
    const edges = [...Array.from({ length: SUB + 1 }, (_, i) => (i * u) / SUB), 2 * u, 3 * u];
    const km = unit >= 1000;
    const num = (m: number) => String(km ? m / 1000 : m);
    const labels: [number, string][] = [
      [0, num(unit)],
      // (Not where the left unit is too short for three numbers: a phone's.)
      ...(u >= MID_LABEL_MIN ? [[u / 2, num(unit / 2)] as [number, string]] : []),
      [u, '0'],
      [2 * u, num(unit)],
      [3 * u, `${num(2 * unit)} ${km ? 'km' : 'm'}`],
    ];
    const W = Math.max(MIN_WIDTH, this.width + 2 * SIDE);
    const left = (W - this.width) / 2; // the bar's left end
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(HEIGHT));
    svg.setAttribute('viewBox', `0 0 ${W} ${HEIGHT}`);
    const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
      const e = document.createElementNS(svgNs, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      if (text !== undefined) e.textContent = text;
      svg.appendChild(e);
      return e;
    };
    add('text', { x: W / 2, y: TITLE_Y, 'text-anchor': 'middle', fill: BLUE, class: 'title' }, `${WORD[this.lang]} ${ratio(this.lang, scale)}`);
    for (const [x, t] of labels) add('text', { x: left + x, y: NUM_Y, 'text-anchor': 'middle', fill: INK }, t);
    this.fills = [];
    for (let b = 0; b < edges.length - 1; b++) {
      const x0 = edges[b];
      const x1 = edges[b + 1];
      const rect = add('rect', { x: left + x0, y: BAR_Y, width: 0, height: BAR_H, fill: b % 2 ? LIGHT : INK }) as SVGRectElement;
      this.fills.push({ rect, x0, x1 });
    }
    // The outline and block divisions, over the fill.
    add('rect', { x: left + 0.5, y: BAR_Y + 0.5, width: this.width - 1, height: BAR_H - 1, fill: 'none', stroke: INK, 'stroke-width': 1 });
    for (const x of edges.slice(1, -1)) add('line', { x1: left + x, x2: left + x, y1: BAR_Y, y2: BAR_Y + BAR_H, stroke: INK, 'stroke-width': 1 });
    add('text', { x: W / 2, y: CAPTION_Y, 'text-anchor': 'middle', fill: INK, class: 'caption' }, LOADING[this.lang]);
    this.el.replaceChildren(svg);
  }
}
