/**
 * Marching squares over a row-major grid, emitting segments per level.
 *
 * Cells are visited once; each cell only processes the levels between its min
 * and max corner, so cost scales with the number of crossings, not levels.
 * Segments are drawn with round caps, so they don't need joining into polylines.
 */

export interface ContourSegments {
  /** Flat [x0, y0, x1, y1, ...] in grid units, per level. */
  byLevel: Map<number, number[]>;
}

/**
 * @param g grid values, row-major, width `w`
 * @param i0,j0,i1,j1 cell range to process (cell (i, j) spans vertices i..i+1, j..j+1); i1/j1 exclusive
 * @param interval level spacing
 * @param keep optional filter (level, cell i, cell j) → draw?
 */
export function marchingSquares(
  g: ArrayLike<number>,
  w: number,
  i0: number,
  j0: number,
  i1: number,
  j1: number,
  interval: number,
  keep?: (level: number, i: number, j: number) => boolean,
): ContourSegments {
  const byLevel = new Map<number, number[]>();
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const a = g[j * w + i]; // top-left
      const b = g[j * w + i + 1]; // top-right
      const c = g[(j + 1) * w + i + 1]; // bottom-right
      const d = g[(j + 1) * w + i]; // bottom-left
      const lo = Math.min(a, b, c, d);
      const hi = Math.max(a, b, c, d);
      for (let L = Math.ceil(lo / interval) * interval; L <= hi; L += interval) {
        if (keep && !keep(L, i, j)) continue;
        const code = (a >= L ? 8 : 0) | (b >= L ? 4 : 0) | (c >= L ? 2 : 0) | (d >= L ? 1 : 0);
        if (code === 0 || code === 15) continue;
        let arr = byLevel.get(L);
        if (!arr) byLevel.set(L, (arr = []));
        // Edge crossing points.
        const top = () => [i + (L - a) / (b - a), j];
        const right = () => [i + 1, j + (L - b) / (c - b)];
        const bottom = () => [i + (L - d) / (c - d), j + 1];
        const left = () => [i, j + (L - a) / (d - a)];
        const seg = (p: number[], q: number[]) => arr!.push(p[0], p[1], q[0], q[1]);
        switch (code) {
          case 1: case 14: seg(left(), bottom()); break;
          case 2: case 13: seg(bottom(), right()); break;
          case 3: case 12: seg(left(), right()); break;
          case 4: case 11: seg(top(), right()); break;
          case 6: case 9: seg(top(), bottom()); break;
          case 7: case 8: seg(left(), top()); break;
          case 5: case 10: {
            // Saddle: disambiguate by the cell-centre average.
            const centreAbove = (a + b + c + d) / 4 >= L;
            if ((code === 5) === centreAbove) {
              seg(left(), top());
              seg(bottom(), right());
            } else {
              seg(left(), bottom());
              seg(top(), right());
            }
            break;
          }
        }
      }
    }
  }
  return { byLevel };
}
