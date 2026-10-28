import type { FontId } from './theme-fonts';
import type { ThemePresetId } from './theme-presets';

export type ThemeColors = { accent: string; background: string; foreground: string };
export type ThemeAppearance = ThemeColors & { font: FontId };
export type SavedTheme = ThemeAppearance & { id: string; name: string };
export type ThemeLibrary = { themes: SavedTheme[]; activeThemeId: string | null; activePresetId: ThemePresetId };

export const MAX_THEMES = 30;
export const MAX_THEME_NAME_LENGTH = 48;

export function checkedThemeName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Name your theme.');
  const name = value.trim();
  if (!name || [...name].length > MAX_THEME_NAME_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw new Error('Use a theme name with 1–48 characters.');
  }
  return name;
}

export function themeNameKey(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase();
}

export function checkedThemeColor(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error('Choose a color in #RRGGBB format.');
  }
  return value.toUpperCase();
}

export function checkedThemeColors(value: Record<string, unknown>): ThemeColors {
  return {
    accent: checkedThemeColor(value.accent),
    background: checkedThemeColor(value.background),
    foreground: checkedThemeColor(value.foreground),
  };
}

export function checkedActiveThemeId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('Choose a saved theme.');
  return value;
}
