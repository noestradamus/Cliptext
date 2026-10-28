'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { checkedThemeColors, checkedThemeName } from '../lib/theme-contract';
import type { SavedTheme, ThemeAppearance, ThemeLibrary } from '../lib/theme-contract';
import { checkedThemeFont } from '../lib/theme-fonts';
import { checkedPresetId } from '../lib/theme-presets';
import type { ThemePresetId } from '../lib/theme-presets';
import { cachedThemeColors, paintTheme, resolvedThemeAppearance, THEME_CACHE_KEY } from '../lib/theme-appearance';

type ThemeDraft = ThemeAppearance & { name: string };
type ThemeSelection = Pick<ThemeLibrary, 'activeThemeId' | 'activePresetId'>;
type ThemeContextValue = {
  library: ThemeLibrary;
  loading: boolean;
  error: string;
  reload(): Promise<ThemeLibrary>;
  preview(colors: ThemeAppearance): void;
  clearPreview(): void;
  activate(id: string | null): Promise<void>;
  activatePreset(id: ThemePresetId): Promise<void>;
  save(id: string | null, draft: ThemeDraft): Promise<SavedTheme>;
  remove(id: string): Promise<void>;
};

const emptyLibrary: ThemeLibrary = { themes: [], activeThemeId: null, activePresetId: 'glacial' };
const ThemeContext = createContext<ThemeContextValue | null>(null);

async function themeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' });
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('Cliptext couldn’t connect. Reload and try again.');
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'Your theme could not be saved. Try again.');
  return result as T;
}

function cacheColors(colors: ThemeAppearance | null) {
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(colors ? { accent: colors.accent, background: colors.background, foreground: colors.foreground, font: colors.font } : null));
  } catch { /* The server still saves themes if browser storage is unavailable. */ }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [library, setLibrary] = useState<ThemeLibrary>(emptyLibrary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const currentLibrary = useRef<ThemeLibrary>(emptyLibrary);
  const committed = useRef<ThemeAppearance | null>(null);
  const previewing = useRef(false);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const mutating = useRef(false);
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());

  const commit = useCallback((next: ThemeLibrary) => {
    currentLibrary.current = next;
    committed.current = resolvedThemeAppearance(next);
    cacheColors(committed.current);
    setLibrary(next);
    if (!previewing.current) paintTheme(committed.current);
  }, []);

  const reload = useCallback(async (): Promise<ThemeLibrary> => {
    const sequence = ++requestSequence.current;
    try {
      const next = await themeRequest<ThemeLibrary>('/api/themes');
      if (mounted.current && sequence === requestSequence.current && !mutating.current) {
        commit(next);
        setError('');
      }
      return next;
    } catch (failure) {
      if (mounted.current && sequence === requestSequence.current && !mutating.current) setError(failure instanceof Error ? failure.message : 'Themes could not be loaded. Try again.');
      throw failure;
    } finally {
      if (mounted.current && sequence === requestSequence.current && !mutating.current) setLoading(false);
    }
  }, [commit]);

  // Serialize explicit changes; older GET responses can never overwrite a save.
  const mutate = useCallback(<T,>(action: () => Promise<T>, update: (result: T, previous: ThemeLibrary) => ThemeLibrary): Promise<T> => {
    const operation = mutationQueue.current.catch(() => undefined).then(async () => {
      mutating.current = true;
      ++requestSequence.current;
      if (mounted.current) { setLoading(true); setError(''); }
      try {
        const result = await action();
        // The write response already confirms the saved state. Retain it even if
        // the follow-up connection fails, so closing a draft cannot restore stale colors.
        if (mounted.current) {
          previewing.current = false;
          commit(update(result, currentLibrary.current));
        }
        let next: ThemeLibrary | null = null;
        try { next = await themeRequest<ThemeLibrary>('/api/themes'); }
        catch (failure) {
          if (mounted.current) setError(failure instanceof Error ? failure.message : 'Themes could not be refreshed. Try again.');
        }
        ++requestSequence.current;
        if (mounted.current && next) {
          commit(next);
          setError('');
        }
        return result;
      } catch (failure) {
        if (mounted.current) setError(failure instanceof Error ? failure.message : 'Your theme could not be saved. Try again.');
        throw failure;
      } finally {
        mutating.current = false;
        if (mounted.current) setLoading(false);
      }
    });
    mutationQueue.current = operation;
    return operation;
  }, [commit]);

  const preview = useCallback((colors: ThemeAppearance) => {
    const checked = { ...checkedThemeColors(colors), font: checkedThemeFont(colors.font) };
    previewing.current = true;
    paintTheme(checked);
  }, []);

  const clearPreview = useCallback(() => {
    previewing.current = false;
    paintTheme(committed.current);
  }, []);

  const activate = useCallback(async (id: string | null) => {
    await mutate(() => themeRequest<ThemeSelection>('/api/themes', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activeThemeId: id }) }),
      (result, previous) => ({ ...previous, ...result }));
  }, [mutate]);

  const activatePreset = useCallback(async (id: ThemePresetId) => {
    const activePresetId = checkedPresetId(id);
    await mutate(() => themeRequest<ThemeSelection>('/api/themes', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activePresetId }) }),
      (result, previous) => ({ ...previous, ...result }));
  }, [mutate]);

  const save = useCallback(async (id: string | null, draft: ThemeDraft): Promise<SavedTheme> => {
    const input = { name: checkedThemeName(draft.name), ...checkedThemeColors(draft), font: checkedThemeFont(draft.font) };
    const result = await mutate(() => themeRequest<{ theme: SavedTheme; activeThemeId?: string | null; activePresetId?: ThemePresetId }>(id ? `/api/themes/${encodeURIComponent(id)}` : '/api/themes', {
      method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }), (saved, previous) => ({
      themes: [...previous.themes.filter(theme => theme.id !== saved.theme.id), saved.theme].sort((a, b) => a.name.localeCompare(b.name)),
      activeThemeId: id ? previous.activeThemeId : saved.activeThemeId ?? saved.theme.id,
      activePresetId: id ? previous.activePresetId : saved.activePresetId ?? 'glacial',
    }));
    return result.theme;
  }, [mutate]);

  const remove = useCallback(async (id: string) => {
    await mutate(() => themeRequest<ThemeSelection>(`/api/themes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      (result, previous) => ({ themes: previous.themes.filter(theme => theme.id !== id), ...result }));
  }, [mutate]);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    try { committed.current = cachedThemeColors(JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null')); }
    catch { committed.current = null; }
    if (!previewing.current) paintTheme(committed.current);
    void Promise.resolve().then(() => { if (active) return reload(); }).catch(() => undefined);
    const refresh = () => {
      if (document.visibilityState === 'visible' && !mutating.current) void reload().catch(() => undefined);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const invalidateReads = () => { ++requestSequence.current; };
    return () => {
      active = false;
      mounted.current = false;
      invalidateReads();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);

  const value = useMemo(() => ({ library, loading, error, reload, preview, clearPreview, activate, activatePreset, save, remove }), [library, loading, error, reload, preview, clearPreview, activate, activatePreset, save, remove]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('Theme controls need ThemeProvider.');
  return context;
}

export default ThemeProvider;
