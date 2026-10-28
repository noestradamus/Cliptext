import type { ThemeAppearance } from './theme-contract';

// Keep stored IDs stable when a preset is renamed, so existing choices still resolve.
export const THEME_PRESETS = [
  { id: 'glacial', name: 'Glacier', accent: '#40A5DB', background: '#FFFFFF', foreground: '#2A497B', font: 'dm-sans' },
  { id: 'midnight', name: 'Midnight', accent: '#8294E3', background: '#10151B', foreground: '#FFFFFF', font: 'dm-sans' },
  { id: 'sand', name: 'Latte', accent: '#FF8E3C', background: '#FFFAEE', foreground: '#502E1A', font: 'dm-sans' },
  { id: 'sage', name: 'Sage', accent: '#3C745D', background: '#E8F0E9', foreground: '#243D34', font: 'dm-sans' },
  { id: 'lavender', name: 'Lavender', accent: '#7755A0', background: '#F0EAF7', foreground: '#392D4B', font: 'dm-sans' },
] as const satisfies readonly (ThemeAppearance & { id: string; name: string })[];

export type ThemePresetId = typeof THEME_PRESETS[number]['id'];

export function checkedPresetId(value: unknown): ThemePresetId {
  if (typeof value !== 'string' || !THEME_PRESETS.some(preset => preset.id === value)) throw new Error('Choose a preset theme.');
  return value as ThemePresetId;
}
