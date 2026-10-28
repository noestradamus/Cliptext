/** HSV uses degrees for hue and percentages for saturation/value. */
export type HsvColor = { h: number; s: number; v: number };

const clamp = (value: number, maximum: number) => Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));

export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (/^[\da-f]{3}$/i.test(hex)) return '#' + [...hex].map(character => character.repeat(2)).join('').toLowerCase();
  return /^[\da-f]{6}$/i.test(hex) ? '#' + hex.toLowerCase() : null;
}

export function hexToHsv(value: string): HsvColor {
  const hex = normalizeHex(value);
  if (!hex) throw new TypeError('Use a valid hex color.');
  const [red, green, blue] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = ((green - blue) / delta) % 6;
    else if (maximum === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = ((hue * 60) + 360) % 360;
  }
  return { h: hue, s: maximum === 0 ? 0 : delta / maximum * 100, v: maximum * 100 };
}

export function hsvToHex({ h, s, v }: HsvColor): string {
  const hue = Number.isFinite(h) ? ((h % 360) + 360) % 360 : 0;
  const saturation = clamp(s, 100) / 100;
  const value = clamp(v, 100) / 100;
  const chroma = value * saturation;
  const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = value - chroma;
  const channels = hue < 60 ? [chroma, secondary, 0]
    : hue < 120 ? [secondary, chroma, 0]
    : hue < 180 ? [0, chroma, secondary]
    : hue < 240 ? [0, secondary, chroma]
    : hue < 300 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  return '#' + channels.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('');
}
