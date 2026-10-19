/** IGN Top25-inspired palette, adapted to 1:10,000. Widths are CSS px. */
export const STYLE = {
  paper: [252, 250, 243] as const,
  /** Multiply colour for full hillshade shadow. */
  shadow: [118, 112, 132] as const,
  shadeStrength: 0.48,
  /** Light from the north-west, 45° above the horizon. */
  lightAzimuthDeg: 315,
  lightAltitudeDeg: 45,

  contour: 'rgb(206, 140, 78)',
  contourIndex: 'rgb(184, 108, 48)',
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

  grid: 'rgba(30, 110, 210, 0.55)',
  gridLabel: 'rgb(30, 100, 200)',
  gridWidth: 0.8,
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
