/**
 * Padded y-axis bounds so real variation is visible in compliance trend charts.
 *
 * A fixed [0,100] domain flattens a series that lives in (say) 74–82% into a
 * near-flat line; this zooms to the data's actual range with ~15% headroom
 * (minimum 4 points), clamped to [0,100]. A flat series gets a small ±5 window so
 * it isn't drawn as a hairline against the axis.
 */
export function niceDomain(values: number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 100];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) {
    return [Math.max(0, Math.floor(min - 5)), Math.min(100, Math.ceil(max + 5))];
  }
  const pad = Math.max(4, (max - min) * 0.15);
  return [Math.max(0, Math.floor(min - pad)), Math.min(100, Math.ceil(max + pad))];
}
