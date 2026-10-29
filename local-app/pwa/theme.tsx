import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ThemeContext, type ThemeContextValue } from '../../app/theme-provider';
import { checkedThemeColors, checkedThemeName, themeNameKey, MAX_THEMES, type ThemeLibrary, type SavedTheme } from '../../lib/theme-contract';
import { checkedThemeFont } from '../../lib/theme-fonts';
import { checkedPresetId } from '../../lib/theme-presets';
import { paintTheme, resolvedThemeAppearance, THEME_CACHE_KEY } from '../../lib/theme-appearance';

const KEY = 'cliptext.phone.themes.v1';
const initial: ThemeLibrary = { themes: [], activeThemeId: null, activePresetId: 'glacial' };
function load(): ThemeLibrary {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!value || !Array.isArray(value.themes) || value.themes.length > MAX_THEMES) return initial;
    const themes: SavedTheme[] = value.themes.map((theme: SavedTheme) => ({ id: String(theme.id), name: checkedThemeName(theme.name), ...checkedThemeColors(theme), font: checkedThemeFont(theme.font) }));
    return { themes, activeThemeId: themes.some(theme => theme.id === value.activeThemeId) ? value.activeThemeId : null, activePresetId: checkedPresetId(value.activePresetId) };
  } catch { return initial; }
}

/** Appearance is device-local; reading and styling work without the Mac. */
export default function PhoneThemeProvider({ children }: { children: ReactNode }) {
  const [library, setLibrary] = useState<ThemeLibrary>(load);
  const current = useRef(library); current.current = library;
  const [error, setError] = useState('');
  function commit(next: ThemeLibrary) {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(resolvedThemeAppearance(next)));
      current.current = next; setLibrary(next); paintTheme(resolvedThemeAppearance(next)); setError('');
    } catch { const message = 'This phone could not save the theme. Free some storage and try again.'; setError(message); throw new Error(message); }
  }
  useEffect(() => { paintTheme(resolvedThemeAppearance(library)); }, [library]);
  const value: ThemeContextValue = {
    library, loading: false, error,
    reload: async () => current.current,
    preview: paintTheme,
    clearPreview: () => paintTheme(resolvedThemeAppearance(current.current)),
    activate: async id => commit({ ...current.current, activeThemeId: id }),
    activatePreset: async id => commit({ ...current.current, activeThemeId: null, activePresetId: checkedPresetId(id) }),
    save: async (id, draft) => {
      const previous = current.current;
      const theme: SavedTheme = { id: id ?? crypto.randomUUID(), name: checkedThemeName(draft.name), ...checkedThemeColors(draft), font: checkedThemeFont(draft.font) };
      if (!id && previous.themes.length >= MAX_THEMES) throw new Error('Remove an old theme before saving another.');
      if (previous.themes.some(saved => saved.id !== id && themeNameKey(saved.name) === themeNameKey(theme.name))) throw new Error('A theme already has that name.');
      commit({ ...previous, themes: [...previous.themes.filter(saved => saved.id !== id), theme].sort((a, b) => a.name.localeCompare(b.name)), activeThemeId: theme.id });
      return theme;
    },
    remove: async id => commit({ ...current.current, themes: current.current.themes.filter(theme => theme.id !== id), activeThemeId: current.current.activeThemeId === id ? null : current.current.activeThemeId }),
  };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
