import { DPR_MAX, M_PER_CSS_PX } from '../lib/constants';
import { CHAPEL, CROSS, RESERVOIR, SPRING, TOWER, TRIG, type PoiKind } from '../gen/poi';
import { ROAD_C, ROAD_D, ROAD_N, ROAD_P, ROAD_T } from '../gen/roads';
import { MIN_PX, STREET_M, STREET_PX, WIDTH_M } from '../render/roads';
import { drawPois } from '../render/symbols';
import { STYLE } from '../render/style';
import { MARGIN, type Gap } from './frame';
import type { Lang } from './lang';
import { TEXT, type TextKey } from './legendText';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Width of the legend pane beside the right margin (CSS px), at most. */
const PANE_W = 224;
/** The map face keeps at least this much width while the legend is out. */
const FACE_MIN = 96;
/** The "Legend" tab in the right margin: its height and distance above the bottom margin. */
const TAB_H = 58;
const TAB_GAP = 12;
const SLIDE_S = 0.22;
/** Swatch size (CSS px); symbols are drawn at their size at zoom 1. */
const SW = 34;
const SH = 14;
const PX_PER_M = 1 / M_PER_CSS_PX;

/**
 * Legend (key `l`, `?legend`, or the tab in the right margin): it slides out as a
 * widening of the paper margin on the right, with a swatch for each thing the map
 * draws, drawn with the map's own styles. Written in `lang` (English, Dutch, French or German).
 */
export class Legend {
  open = false;
  /** How far out it is, 0…1. */
  private p = 0;
  private readonly el = document.createElement('aside');
  private readonly tab = document.createElement('button');
  private readonly still = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(lang: Lang) {
    const { el, tab } = this;
    const t = TEXT[lang];
    el.id = 'legend';
    el.lang = tab.lang = lang;
    el.setAttribute('aria-label', t.title);
    el.innerHTML = `<header><b>${t.title}</b><button data-act="close" aria-label="${t.close}">×</button></header>`;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
    for (const [title, entries] of SECTIONS) {
      const sec = document.createElement('section');
      sec.innerHTML = `<h3>${t[title]}</h3>`;
      for (const [label, draw] of entries) {
        const row = document.createElement('div');
        row.className = 'row';
        const c = document.createElement('canvas');
        c.width = Math.round(SW * dpr);
        c.height = Math.round(SH * dpr);
        const off = new OffscreenCanvas(c.width, c.height);
        const o = off.getContext('2d')!;
        o.scale(dpr, dpr);
        draw(o);
        c.getContext('2d')!.drawImage(off, 0, 0);
        const span = document.createElement('span');
        span.textContent = t[label];
        row.append(c, span);
        sec.append(row);
      }
      el.append(sec);
    }
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = t.note;
    el.append(note);
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act="close"]')) this.toggle(false);
    });

    tab.id = 'legend-tab';
    tab.textContent = t.title;
    tab.style.height = `${TAB_H}px`;
    // The column the numbers are centred in: the margin outside the grid ticks.
    tab.style.width = `${MARGIN - STYLE.frame.tick}px`;
    tab.style.bottom = `${MARGIN + TAB_GAP}px`;
    tab.addEventListener('click', () => this.toggle());
    document.body.append(el, tab);
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'l' || e.key === 'L') this.toggle();
      else if (e.key === 'Escape') this.toggle(false);
    });
  }

  toggle(show = !this.open): void {
    this.open = show;
    this.tab.setAttribute('aria-expanded', String(show));
  }

  /** Per frame: slides toward open or closed; true while it moves. */
  tick(dt: number): boolean {
    const goal = this.open ? 1 : 0;
    if (this.p === goal) return false;
    const step = this.still.matches ? 1 : dt / SLIDE_S;
    this.p = goal > this.p ? Math.min(goal, this.p + step) : Math.max(goal, this.p - step);
    return true;
  }

  /** Width of the right margin (CSS px) in a window `w` wide. */
  right(w: number): number {
    const e = this.p * this.p * (3 - 2 * this.p);
    return MARGIN + e * this.paneW(w);
  }

  /** The span of the right margin the tab covers, in a window `h` high. */
  gap(h: number): Gap {
    const y1 = h - MARGIN - TAB_GAP;
    return [y1 - TAB_H - 6, y1 + 6];
  }

  /** Places the pane and the tab to match the margin drawn on the canvas. */
  layout(w: number): void {
    const W = this.paneW(w);
    const R = this.right(w);
    this.el.style.width = `${W}px`;
    this.el.style.transform = `translateX(${MARGIN + W - R}px)`;
    this.el.style.visibility = this.p > 0 ? 'visible' : 'hidden';
    this.tab.style.right = `${R - MARGIN}px`;
    document.documentElement.style.setProperty('--frame-right', `${R}px`);
  }

  private paneW(w: number): number {
    return Math.max(0, Math.min(PANE_W, w - 2 * MARGIN - FACE_MIN));
  }
}

// --- Swatches -----------------------------------------------------------

type Draw = (c: Ctx) => void;

const roadW = (cls: number) => Math.max(WIDTH_M[cls] * PX_PER_M, MIN_PX[cls]);
const casing = STYLE.roads.casingWidth;
const rgb = (c: readonly [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

function across(c: Ctx, style: string, width: number, dash: number[] = []): void {
  c.strokeStyle = style;
  c.lineWidth = width;
  c.lineCap = 'butt';
  c.setLineDash(dash);
  c.beginPath();
  c.moveTo(3, SH / 2);
  c.lineTo(SW - 3, SH / 2);
  c.stroke();
  c.setLineDash([]);
}

const road = (cls: number): Draw => (c) => {
  across(c, STYLE.roads.casing, roadW(cls) + 2 * casing);
  across(c, STYLE.roads.fill[cls], roadW(cls));
};

const street: Draw = (c) => {
  const w = Math.max(STREET_M[0] * PX_PER_M, STREET_PX[0]);
  across(c, STYLE.roads.casing, w + 2 * casing);
  across(c, STYLE.roads.fill[ROAD_C], w);
};

const bridge: Draw = (c) => {
  const { gap, line, color, deck } = STYLE.roads.bridge;
  const W = roadW(ROAD_C) + 2 * casing;
  across(c, STYLE.roads.casing, W);
  across(c, STYLE.roads.fill[ROAD_C], roadW(ROAD_C));
  c.save();
  c.beginPath();
  c.rect(10, 0, SW - 20, SH);
  c.clip();
  across(c, color, W + 2 * (gap + line));
  across(c, deck, W + 2 * gap);
  across(c, STYLE.roads.casing, W);
  across(c, STYLE.roads.fill[ROAD_C], roadW(ROAD_C));
  c.restore();
};

/** A patch of ground: its fill (or bare paper), a faint edge, then its symbols. */
const area = (fill: readonly [number, number, number] | null, symbols?: Draw): Draw => (c) => {
  c.fillStyle = rgb(fill ?? STYLE.paper);
  c.fillRect(1, 1, SW - 2, SH - 2);
  if (symbols) {
    c.save();
    c.beginPath();
    c.rect(1, 1, SW - 2, SH - 2);
    c.clip();
    symbols(c);
    c.restore();
  }
  c.strokeStyle = 'rgba(107, 90, 68, 0.35)';
  c.lineWidth = 0.5;
  c.strokeRect(1.25, 1.25, SW - 2.5, SH - 2.5);
};

/** Sites on a jittered grid of spacing `s` px (fixed, so the swatches don't change). */
function sites(s: number, f: (x: number, y: number, h: number) => void): void {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let y = s / 2; y < SH; y += s) for (let x = s / 2; x < SW; x += s) f(x + (rnd() - 0.5) * s * 0.8, y + (rnd() - 0.5) * s * 0.8, rnd());
}

const dots = (s: number, r: (h: number) => number, style: string): Draw => (c) => {
  c.fillStyle = style;
  c.beginPath();
  sites(s, (x, y, h) => {
    c.moveTo(x + r(h), y);
    c.arc(x, y, r(h), 0, 2 * Math.PI);
  });
  c.fill();
};

const trees = (conifer: boolean): Draw => (c) => {
  c.strokeStyle = STYLE.cover.tree;
  c.lineWidth = 0.6;
  c.lineJoin = 'round';
  c.beginPath();
  for (const [x, y] of [
    [8, 5.5],
    [18, 9],
    [27, 5],
  ]) {
    if (conifer) {
      c.moveTo(x, y - 2.2);
      c.lineTo(x + 1.5, y + 1.2);
      c.lineTo(x - 1.5, y + 1.2);
      c.closePath();
    } else {
      c.moveTo(x + 1.6, y);
      c.arc(x, y, 1.6, 0, 2 * Math.PI);
    }
  }
  c.stroke();
};

const heath: Draw = (c) => {
  c.strokeStyle = STYLE.cover.heath;
  c.lineWidth = 0.55;
  c.beginPath();
  sites(4.2, (x, y) => {
    c.moveTo(x + 0.9, y);
    c.arc(x, y, 0.9, 0, 2 * Math.PI);
  });
  c.stroke();
};

const marsh: Draw = (c) => {
  c.strokeStyle = STYLE.cover.marsh;
  c.lineWidth = 0.6;
  c.lineCap = 'round';
  c.beginPath();
  for (const [px, py] of [
    [8, 6],
    [24, 5.5],
    [16, 11],
  ]) {
    c.moveTo(px - 2.2, py);
    c.lineTo(px + 2.2, py);
    for (const dx of [-1.3, 0, 1.3]) {
      c.moveTo(px + dx, py);
      c.lineTo(px + dx * 1.3, py - (dx === 0 ? 2.2 : 1.6));
    }
  }
  c.stroke();
};

const rock: Draw = (c) => {
  c.strokeStyle = STYLE.cover.rockLine;
  c.lineWidth = 0.55;
  c.lineCap = 'round';
  c.beginPath();
  // Hachures down the fall line, every 8 m and 4–9 m long, as on the map.
  sites(8 * PX_PER_M, (x, y, h) => {
    c.moveTo(x, y);
    c.lineTo(x + 0.6, y + (4 + 5 * h) * PX_PER_M);
  });
  c.stroke();
};

/** A gently waving line across the swatch. */
function wave(c: Ctx, style: string, width: number, dy = 0, amp = 2.2): void {
  c.strokeStyle = style;
  c.lineWidth = width;
  c.lineCap = 'round';
  c.beginPath();
  for (let x = 3; x <= SW - 3; x += 1) {
    const y = SH / 2 + dy + amp * Math.sin(((x - 3) / (SW - 6)) * 2 * Math.PI);
    if (x === 3) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.stroke();
}

const glacier: Draw = (c) => {
  wave(c, STYLE.cover.glacierContour, STYLE.contourWidth, -2.5, 1.5);
  wave(c, STYLE.cover.glacierContour, STYLE.contourWidth, 2.5, 1.5);
};

const lake: Draw = (c) => {
  c.beginPath();
  c.ellipse(SW / 2, SH / 2, SW / 2 - 3, SH / 2 - 2.5, 0, 0, 2 * Math.PI);
  c.fillStyle = STYLE.waterFillCss;
  c.fill();
  c.strokeStyle = STYLE.waterLine;
  c.lineWidth = STYLE.shoreWidth;
  c.stroke();
};

const river: Draw = (c) => {
  const w = 4;
  wave(c, STYLE.waterLine, w + 1.1);
  wave(c, STYLE.waterFillCss, w - 0.2);
};

const box = (w: number, h: number, large: boolean): Draw => (c) => {
  const x = (SW - w) / 2;
  const y = (SH - h) / 2;
  c.fillStyle = large ? STYLE.buildingLarge : STYLE.building;
  c.fillRect(x, y, w, h);
  if (large) {
    const e = casing;
    c.strokeStyle = STYLE.building;
    c.lineWidth = 2 * e;
    c.strokeRect(x + e, y + e, w - 2 * e, h - 2 * e);
  }
};

const buildings: Draw = (c) => {
  c.fillStyle = STYLE.building;
  c.fillRect(9, 4, 5, 4);
  c.fillRect(14.5, 4, 4, 4);
  c.fillRect(21, 6, 4, 5);
};

const church: Draw = (c) => {
  const x = SW / 2;
  const y = SH / 2 + 2;
  const r = 2.2;
  c.fillStyle = STYLE.church;
  c.strokeStyle = STYLE.church;
  c.lineWidth = 0.9;
  c.beginPath();
  c.arc(x, y, r, 0, 2 * Math.PI);
  c.fill();
  c.beginPath();
  c.moveTo(x, y - r - 3.5);
  c.lineTo(x, y - r);
  c.moveTo(x - 1.6, y - r - 2.2);
  c.lineTo(x + 1.6, y - r - 2.2);
  c.stroke();
};

/** A point of interest as the map draws it, `dy` below the swatch's middle (to centre its height). */
const poi = (kind: PoiKind, dy = 0): Draw => (c) => drawPois(c, [{ kind, x: SW / 2, y: SH / 2 + dy }], 0, 0, 1, 1);

const hedge: Draw = (c) => {
  c.fillStyle = STYLE.fields.hedge;
  c.beginPath();
  for (let x = 4; x <= SW - 4; x += STYLE.fields.hedgeSpacing) {
    c.moveTo(x + STYLE.fields.hedgeDot, SH / 2);
    c.arc(x, SH / 2, STYLE.fields.hedgeDot, 0, 2 * Math.PI);
  }
  c.fill();
};

const fieldEdges: Draw = (c) => {
  c.strokeStyle = STYLE.fields.edge;
  c.lineWidth = STYLE.fields.edgeWidth;
  c.beginPath();
  c.moveTo(2, 3);
  c.lineTo(SW - 2, 5);
  c.moveTo(14, 4);
  c.lineTo(12, SH - 2);
  c.moveTo(25, 4.6);
  c.lineTo(27, SH - 2);
  c.stroke();
};

const gridLine: Draw = (c) => {
  c.strokeStyle = STYLE.grid;
  c.lineWidth = STYLE.gridWidth;
  c.beginPath();
  c.moveTo(3, SH / 2 + 0.5);
  c.lineTo(SW - 3, SH / 2 + 0.5);
  c.moveTo(SW / 2 + 0.5, 1);
  c.lineTo(SW / 2 + 0.5, SH - 1);
  c.stroke();
};

const SECTIONS: [TextKey, [TextKey, Draw][]][] = [
  [
    'roads',
    [
      ['main', road(ROAD_N)],
      ['secondary', road(ROAD_D)],
      ['minor', road(ROAD_C)],
      ['street', street],
      ['track', (c) => across(c, STYLE.roads.track, roadW(ROAD_T))],
      ['footpath', (c) => across(c, STYLE.roads.path, roadW(ROAD_P), [4, 3])],
      ['bridge', bridge],
    ],
  ],
  [
    'buildings',
    [
      ['building', buildings],
      ['large', box(16, 8, true)],
      ['church', church],
    ],
  ],
  [
    'water',
    [
      ['lake', lake],
      ['stream', (c) => wave(c, STYLE.waterLine, STYLE.streamMinWidth)],
      ['river', river],
      ['spring', poi(SPRING)],
      ['reservoir', poi(RESERVOIR)],
    ],
  ],
  [
    'land',
    [
      ['broadleaf', area(STYLE.cover.forest, trees(false))],
      ['conifer', area(STYLE.cover.forest, trees(true))],
      ['vineyard', area(STYLE.cover.vineyard, dots(2.6, () => 0.6, STYLE.cover.vineDot))],
      ['heath', area(null, heath)],
      ['marsh', area(null, marsh)],
      ['rock', area(STYLE.cover.rock, rock)],
      ['scree', area(STYLE.cover.scree, dots(2.3, (h) => 0.35 + 0.5 * h, STYLE.cover.screeDot))],
      ['glacier', area(STYLE.cover.glacier, glacier)],
      ['field', fieldEdges],
      ['hedge', hedge],
    ],
  ],
  [
    'relief',
    [
      ['contour', (c) => wave(c, STYLE.contour, STYLE.contourWidth)],
      ['index', (c) => wave(c, STYLE.contourIndex, STYLE.contourIndexWidth)],
    ],
  ],
  [
    'landmarks',
    [
      ['chapel', poi(CHAPEL, 1.7)],
      ['cross', poi(CROSS, 0.4)],
      ['trig', poi(TRIG, 0.8)],
      ['tower', poi(TOWER)],
    ],
  ],
  ['gridTitle', [['grid', gridLine]]],
];
