const SMOOTH_W = [0.06, 0.12, 0.2, 0.24, 0.2, 0.12, 0.06];

/**
 * Gaussian smoothing over ±3 vertices, endpoints fixed (they're confluences or
 * patch edges). Removes the 16 m D8 zig-zag. Local, so neighbouring chunks agree.
 */
export function smoothPolyline(xs: number[], ys: number[]): void {
  const n = xs.length;
  if (n < 3) return;
  const x0 = xs.slice();
  const y0 = ys.slice();
  for (let v = 1; v < n - 1; v++) {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let d = -3; d <= 3; d++) {
      const u = v + d;
      if (u < 0 || u >= n) continue;
      const wgt = SMOOTH_W[d + 3];
      sx += x0[u] * wgt;
      sy += y0[u] * wgt;
      sw += wgt;
    }
    xs[v] = sx / sw;
    ys[v] = sy / sw;
  }
}
