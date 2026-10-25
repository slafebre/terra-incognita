/** IGN Top25-inspired palette, adapted to 1:10,000. Widths are CSS px. */
export const STYLE = {
  paper: [252, 250, 243] as const,
  /** Multiply colour for full hillshade shadow. */
  shadow: [118, 112, 132] as const,
  shadeStrength: 0.48,
  /** Light from the north-west, 45° above the horizon. */
  lightAzimuthDeg: 315,
  lightAltitudeDeg: 45,

  contour: 'rgba(206, 140, 78, 0.4)',
  contourIndex: 'rgba(184, 108, 48, 0.4)',
  contourWidth: 0.55,
  contourIndexWidth: 1.15,

  /** Water: IGN blue line work and pale blue fill. */
  waterLine: 'rgb(28, 130, 210)',
  waterFill: [190, 225, 247] as const,
  waterFillCss: 'rgb(190, 225, 247)',
  shoreWidth: 0.8,
  /** Narrow streams: min width (CSS px); wider rivers get casings. */
  streamMinWidth: 0.85,
  streamCasedFrom: 2.4,

  /** Land cover (IGN-like): fills under the hillshade, then symbols. */
  cover: {
    glacier: [236, 245, 251] as const,
    rock: [229, 227, 223] as const,
    scree: [240, 238, 233] as const,
    forest: [205, 229, 176] as const,
    vineyard: [234, 236, 206] as const,
    rockLine: 'rgba(70, 68, 66, 0.45)',
    screeDot: 'rgba(105, 102, 98, 0.65)',
    vineDot: 'rgba(96, 120, 64, 0.75)',
    tree: 'rgba(72, 122, 52, 0.55)',
    heath: 'rgba(80, 130, 60, 0.6)',
    marsh: 'rgba(28, 130, 210, 0.75)',
    glacierContour: 'rgba(70, 145, 205, 0.55)',
  },

  /** Roads (IGN-like): N red, D yellow, C white; all cased. */
  roads: {
    fill: ['rgb(226, 74, 50)', 'rgb(250, 206, 72)', 'rgb(255, 255, 255)'],
    casing: 'rgb(70, 58, 52)',
    casingWidth: 0.65,
    track: 'rgb(70, 58, 52)',
    path: 'rgb(70, 58, 52)',
    /** Bridges: parapet lines (CSS px) a gap away from the way's edge. */
    bridge: { color: 'rgb(40, 34, 30)', deck: 'rgb(255, 255, 255)', gap: 0.8, line: 0.7 },
  },
  church: 'rgb(45, 40, 38)',
  /** Field parcels: unhedged edges faint and thin; hedges as rows of green dots (CSS px). */
  fields: {
    edge: 'rgba(120, 104, 80, 0.32)',
    edgeWidth: 0.5,
    hedge: 'rgb(70, 125, 55)',
    hedgeDot: 0.8,
    hedgeSpacing: 2.4,
  },
  /** Building footprints: solid dark red (hsl 2.3°, 60.5 %, 33.7 %), no outline. */
  building: 'rgb(138, 38, 34)',
  /** …large ones (from `buildingLargeFrom` m²: halls, sheds, stores), lighter: the same hue and saturation at 62 % lightness, edged in `building` as wide as a road casing. */
  buildingLarge: 'hsl(2.3, 60.5%, 62%)',
  buildingLargeFrom: 300,

  grid: 'rgba(30, 110, 210, 0.55)',
  gridLabel: 'rgb(30, 100, 200)',
  gridWidth: 0.8,
  /** Paper margin round the map face (CSS px): neatline, grid ticks and kilometre numbers. */
  frame: {
    neatline: 'rgb(40, 34, 30)',
    neatlineWidth: 1,
    tick: 4,
    font: '600 10.5px ui-sans-serif, system-ui, sans-serif',
  },
};

/** Adaptive contour rules. */
export const CONTOURS = {
  /** Base equidistance (m). */
  interval: 5,
  /** Above this slope (m/m), 5 m intermediates are dropped (10 m equidistance). */
  slopeDrop5: 0.5,
  /** Above this slope, 10 m lines are dropped too (only 50 m index lines remain). */
  slopeDrop10: 1.25,
  /** Above this slope (cliffs) no contours are drawn; rock symbols take over (milestone 3). */
  slopeDropAll: 2.5,
};
