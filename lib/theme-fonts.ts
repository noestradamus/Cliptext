export const DEFAULT_FONT = 'dm-sans';

export const THEME_FONTS = [
  { id: 'dm-sans', label: 'DM Sans', family: '"DM Sans", sans-serif' },
  { id: 'inter', label: 'Inter', family: '"Inter", sans-serif' },
  { id: 'manrope', label: 'Manrope', family: '"Manrope", sans-serif' },
  { id: 'plus-jakarta-sans', label: 'Plus Jakarta Sans', family: '"Plus Jakarta Sans", sans-serif' },
  { id: 'lato', label: 'Lato', family: '"Lato", sans-serif' },
  { id: 'nunito-sans', label: 'Nunito Sans', family: '"Nunito Sans", sans-serif' },
  { id: 'open-sans', label: 'Open Sans', family: '"Open Sans", sans-serif' },
  { id: 'source-sans-3', label: 'Source Sans 3', family: '"Source Sans 3", sans-serif' },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', family: '"IBM Plex Sans", sans-serif' },
  { id: 'work-sans', label: 'Work Sans', family: '"Work Sans", sans-serif' },
  { id: 'roboto', label: 'Roboto', family: '"Roboto", sans-serif' },
  { id: 'noto-sans', label: 'Noto Sans', family: '"Noto Sans", sans-serif' },
  { id: 'lora', label: 'Lora', family: '"Lora", Georgia, serif' },
  { id: 'merriweather', label: 'Merriweather', family: '"Merriweather", Georgia, serif' },
  { id: 'source-serif-4', label: 'Source Serif 4', family: '"Source Serif 4", Georgia, serif' },
  { id: 'libre-baskerville', label: 'Libre Baskerville', family: '"Libre Baskerville", Georgia, serif' },
  { id: 'ibm-plex-serif', label: 'IBM Plex Serif', family: '"IBM Plex Serif", Georgia, serif' },
  { id: 'atkinson-hyperlegible', label: 'Atkinson Hyperlegible', family: '"Atkinson Hyperlegible", sans-serif' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: '"JetBrains Mono", ui-monospace, monospace' },
  { id: 'space-mono', label: 'Space Mono', family: '"Space Mono", ui-monospace, monospace' },
] as const;

export type FontId = typeof THEME_FONTS[number]['id'];

export function checkedThemeFont(value: unknown): FontId {
  if (typeof value !== 'string' || !THEME_FONTS.some(font => font.id === value)) {
    throw new Error('Choose a font from the list.');
  }
  return value as FontId;
}

export function fontFamily(id: FontId): string {
  const checked = checkedThemeFont(id);
  return THEME_FONTS.find(font => font.id === checked)!.family;
}
