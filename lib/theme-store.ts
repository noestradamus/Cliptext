import { ApiError, dateNow, db } from './server';
import { checkedActiveThemeId, checkedThemeColors, checkedThemeName, MAX_THEMES, themeNameKey } from './theme-contract';
import type { SavedTheme, ThemeLibrary } from './theme-contract';
import { checkedThemeFont, DEFAULT_FONT } from './theme-fonts';
import { checkedPresetId } from './theme-presets';
import type { ThemePresetId } from './theme-presets';

const fields = 'id,name,accent,background,foreground,font';
function savedTheme(row: Record<string, unknown>): SavedTheme {
  return { id: String(row.id), name: String(row.name), accent: String(row.accent), background: String(row.background), foreground: String(row.foreground), font: checkedThemeFont(row.font) };
}

function storedPreset(value: unknown): ThemePresetId {
  try { return checkedPresetId(value); }
  catch { return 'glacial'; }
}

function checked<T>(action: () => T): T {
  try { return action(); }
  catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Check your theme.'); }
}

export async function themeLibrary(ownerId: string): Promise<ThemeLibrary> {
  const [themes, settings] = await db().batch<Record<string, unknown>>([
    db().prepare(`SELECT ${fields} FROM appearance_themes WHERE owner_id=? ORDER BY name_key,id`).bind(ownerId),
    db().prepare('SELECT active_theme_id,active_preset_id FROM appearance_settings WHERE owner_id=?').bind(ownerId),
  ]);
  const activeThemeId = settings.results[0]?.active_theme_id;
  return { themes: themes.results.map(savedTheme), activeThemeId: typeof activeThemeId === 'string' ? activeThemeId : null, activePresetId: storedPreset(settings.results[0]?.active_preset_id) };
}

export async function createTheme(ownerId: string, input: Record<string, unknown>) {
  const name = checked(() => checkedThemeName(input.name));
  const colors = checked(() => checkedThemeColors(input));
  const font = checked(() => checkedThemeFont('font' in input ? input.font : DEFAULT_FONT));
  const id = crypto.randomUUID();
  const now = dateNow();
  const [inserted] = await db().batch<Record<string, unknown>>([
    db().prepare(`INSERT INTO appearance_themes(id,owner_id,name,name_key,accent,background,foreground,font,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM appearance_themes WHERE owner_id=?)<?
      ON CONFLICT(owner_id,name_key) DO NOTHING RETURNING ${fields}`)
      .bind(id, ownerId, name, themeNameKey(name), colors.accent, colors.background, colors.foreground, font, now, now, ownerId, MAX_THEMES),
    db().prepare(`INSERT INTO appearance_settings(owner_id,active_theme_id,active_preset_id)
      SELECT ?,id,'glacial' FROM appearance_themes WHERE id=? AND owner_id=?
      ON CONFLICT(owner_id) DO UPDATE SET active_theme_id=excluded.active_theme_id,active_preset_id=excluded.active_preset_id`).bind(ownerId, id, ownerId),
  ]);
  if (!inserted.results[0]) {
    const duplicate = await db().prepare('SELECT id FROM appearance_themes WHERE owner_id=? AND name_key=?').bind(ownerId, themeNameKey(name)).first();
    if (duplicate) throw new ApiError(409, 'A theme already has this name.');
    throw new ApiError(429, 'You have 30 saved themes. Update or remove one first.');
  }
  return { theme: savedTheme(inserted.results[0]), activeThemeId: id, activePresetId: 'glacial' as const };
}

export async function activateTheme(ownerId: string, value: unknown, presetValue?: unknown) {
  if (presetValue !== undefined && value !== undefined && value !== null) throw new ApiError(400, 'Choose one theme.');
  const activePresetId = presetValue === undefined ? 'glacial' : checked(() => checkedPresetId(presetValue));
  const id = presetValue === undefined ? checked(() => checkedActiveThemeId(value)) : null;
  const row = id === null
    ? await db().prepare(`INSERT INTO appearance_settings(owner_id,active_theme_id,active_preset_id) VALUES(?,NULL,?)
        ON CONFLICT(owner_id) DO UPDATE SET active_theme_id=NULL,active_preset_id=excluded.active_preset_id RETURNING active_theme_id`).bind(ownerId, activePresetId).first()
    : await db().prepare(`INSERT INTO appearance_settings(owner_id,active_theme_id,active_preset_id)
        SELECT ?,id,'glacial' FROM appearance_themes WHERE id=? AND owner_id=?
        ON CONFLICT(owner_id) DO UPDATE SET active_theme_id=excluded.active_theme_id,active_preset_id=excluded.active_preset_id RETURNING active_theme_id`).bind(ownerId, id, ownerId).first();
  if (!row) throw new ApiError(404, 'Theme not found.');
  return { activeThemeId: id, activePresetId };
}

export async function updateTheme(ownerId: string, id: string, input: Record<string, unknown>) {
  const prior = await db().prepare(`SELECT ${fields} FROM appearance_themes WHERE id=? AND owner_id=?`).bind(id, ownerId).first();
  if (!prior) throw new ApiError(404, 'Theme not found.');
  if (!['name', 'accent', 'background', 'foreground', 'font'].some(field => field in input)) throw new ApiError(400, 'Choose something to update.');
  const name = checked(() => checkedThemeName('name' in input ? input.name : prior.name));
  const colors = checked(() => checkedThemeColors({ ...prior, ...input }));
  const font = checked(() => checkedThemeFont('font' in input ? input.font : prior.font));
  // The unique index also protects simultaneous renames from another tab.
  let row;
  try {
    row = await db().prepare(`UPDATE appearance_themes SET name=?,name_key=?,accent=?,background=?,foreground=?,font=?,updated_at=?
      WHERE id=? AND owner_id=? RETURNING ${fields}`)
      .bind(name, themeNameKey(name), colors.accent, colors.background, colors.foreground, font, dateNow(), id, ownerId).first();
  } catch (error) {
    const duplicate = await db().prepare('SELECT id FROM appearance_themes WHERE owner_id=? AND name_key=? AND id<>?').bind(ownerId, themeNameKey(name), id).first();
    if (duplicate) throw new ApiError(409, 'A theme already has this name.');
    throw error;
  }
  if (!row) throw new ApiError(404, 'Theme not found.');
  return { theme: savedTheme(row) };
}

export async function deleteTheme(ownerId: string, id: string) {
  const [deleted, settings] = await db().batch<Record<string, unknown>>([
    db().prepare('DELETE FROM appearance_themes WHERE id=? AND owner_id=? RETURNING id').bind(id, ownerId),
    db().prepare('SELECT active_theme_id,active_preset_id FROM appearance_settings WHERE owner_id=?').bind(ownerId),
  ]);
  if (!deleted.results.length) throw new ApiError(404, 'Theme not found.');
  const activeThemeId = settings.results[0]?.active_theme_id;
  return { activeThemeId: typeof activeThemeId === 'string' ? activeThemeId : null, activePresetId: storedPreset(settings.results[0]?.active_preset_id) };
}
