export function formatKg(value: number): string {
  if (value >= 100) return `${value.toFixed(0)} kg`;
  if (value >= 1) return `${value.toFixed(2)} kg`;
  return `${(value * 1000).toFixed(0)} g`;
}

export function formatMm(value: number): string {
  if (value === 0) return '0 mm';
  if (value < 0.001) return '<0.001 mm';
  return `${value.toFixed(3)} mm`;
}

export function formatN(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kN` : `${value.toFixed(0)} N`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
