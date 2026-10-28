"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import ColorSquare from './color-square';
import { CliptextIcon } from './library-controls';
import { useTheme } from './theme-provider';
import { THEME_PRESETS, checkedPresetId } from '../lib/theme-presets';
import { THEME_FONTS, checkedThemeFont } from '../lib/theme-fonts';
import type { ThemeAppearance, ThemeColors } from '../lib/theme-contract';

const fields = [
  ['accent', 'Accent color'], ['background', 'Background color'], ['foreground', 'Foreground color'],
] as const;

function appearance({ accent, background, foreground, font }: ThemeAppearance): ThemeAppearance {
  return { accent, background, foreground, font };
}

export default function ThemePanel() {
  const { library, loading, error, reload, preview, clearPreview, activate, activatePreset, save, remove } = useTheme();
  const current = library.themes.find(theme => theme.id === library.activeThemeId);
  const preset = THEME_PRESETS.find(theme => theme.id === library.activePresetId) ?? THEME_PRESETS[0];
  const [selectedId, setSelectedId] = useState<string | null>(library.activeThemeId);
  const [name, setName] = useState(current?.name ?? '');
  const [colors, setColors] = useState<ThemeAppearance>(() => appearance(current ?? preset));
  const [field, setField] = useState<keyof ThemeColors>('accent');
  const [newDraft, setNewDraft] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = useRef(false);

  const reset = useCallback(() => {
    const theme = library.themes.find(item => item.id === library.activeThemeId);
    const activePreset = THEME_PRESETS.find(item => item.id === library.activePresetId) ?? THEME_PRESETS[0];
    dirty.current = false; setSelectedId(theme?.id ?? null); setName(theme?.name ?? '');
    setColors(appearance(theme ?? activePreset)); setNewDraft(false); setConfirmDelete(false); setMessage('');
  }, [library]);
  useEffect(() => { if (!dirty.current) reset(); }, [reset]);
  useEffect(() => () => clearPreview(), [clearPreview]);

  function changeColor(key: keyof ThemeColors, value: string) {
    const next = { ...colors, [key]: value };
    dirty.current = true; setColors(next); if (!selectedId) setNewDraft(true);
    setMessage(''); preview(next);
  }
  async function choose(value: string) {
    const wasDirty = dirty.current;
    setPending(true); setMessage('');
    try {
      dirty.current = false;
      if (value.startsWith('preset:')) await activatePreset(checkedPresetId(value.slice(7)));
      else await activate(value.slice(6));
    }
    catch (failure) { dirty.current = wasDirty; setMessage(failure instanceof Error ? failure.message : 'The theme couldn’t be changed.'); }
    finally { setPending(false); }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault(); if (pending) return;
    setPending(true); setMessage('');
    try {
      const theme = await save(selectedId, { ...colors, name });
      dirty.current = false; setSelectedId(theme.id); setName(theme.name); setColors(appearance(theme));
      setNewDraft(false); setMessage('Saved.');
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : 'The theme couldn’t be saved.'); }
    finally { setPending(false); }
  }
  async function deleteTheme() {
    if (!selectedId || pending) return;
    const wasDirty = dirty.current;
    setPending(true); setMessage('');
    try { dirty.current = false; await remove(selectedId); setConfirmDelete(false); }
    catch (failure) { dirty.current = wasDirty; setMessage(failure instanceof Error ? failure.message : 'The theme couldn’t be deleted.'); }
    finally { setPending(false); }
  }

  if (loading && !pending) return <p className="theme-feedback" role="status">Loading themes…</p>;
  return <form className="theme-editor" onSubmit={saveDraft}>
    {error && !message && <div className="theme-feedback" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={() => void reload().catch(() => undefined)}>Try again</button></div>}
    <label className="theme-field-label" htmlFor="saved-themes">Themes</label>
    <div className="theme-saved-row">
      <select id="saved-themes" value={newDraft ? 'new' : selectedId ? `saved:${selectedId}` : `preset:${library.activePresetId}`} disabled={pending} onChange={event => void choose(event.target.value)}>
        {newDraft && <option value="new" disabled>New theme</option>}
        <optgroup label="Presets">{THEME_PRESETS.map(theme => <option key={theme.id} value={`preset:${theme.id}`}>{theme.name}</option>)}</optgroup>
        {library.themes.length > 0 && <optgroup label="Saved themes">{library.themes.map(theme => <option key={theme.id} value={`saved:${theme.id}`}>{theme.name}</option>)}</optgroup>}
      </select>
      <button type="button" className="icon-button" aria-label="New theme" title="New theme" disabled={pending} onClick={() => { dirty.current = true; setSelectedId(null); setName(''); setNewDraft(true); setConfirmDelete(false); setMessage(''); }}><CliptextIcon name="plus" size={18} /></button>
      {selectedId && <button type="button" className="theme-delete" aria-label="Delete theme" title="Delete theme" disabled={pending} onClick={() => setConfirmDelete(true)}><CliptextIcon name="trash" size={17} /></button>}
    </div>
    <div className="theme-font-row"><label htmlFor="theme-font">Font</label><select id="theme-font" value={colors.font} disabled={pending} onChange={event => {
      const next = { ...colors, font: checkedThemeFont(event.target.value) };
      dirty.current = true; setColors(next); if (!selectedId) setNewDraft(true);
      setMessage(''); preview(next);
    }}>{THEME_FONTS.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}</select></div>
    {confirmDelete && <div className="theme-delete-confirm"><span>Delete this theme?</span><button type="button" className="text-button" disabled={pending} onClick={() => void deleteTheme()}>Delete</button><button type="button" className="text-button" disabled={pending} onClick={() => setConfirmDelete(false)}>Cancel</button></div>}
    <div className="theme-color-fields" role="group" aria-label="Theme colors">
      {fields.map(([key, label]) => <button key={key} type="button" className={`theme-color-field ${field === key ? 'is-active' : ''}`} aria-label={`${label} ${colors[key].toUpperCase()}`} aria-pressed={field === key} disabled={pending} onClick={() => setField(key)}><span className="theme-color-chip" style={{ background: colors[key] }} aria-hidden="true" /><span>{label.replace(' color', '')}</span><small>{colors[key].toUpperCase()}</small></button>)}
    </div>
    <div inert={pending}><ColorSquare key={field} label={fields.find(item => item[0] === field)![1]} value={colors[field]} onChange={value => changeColor(field, value)} /></div>
    {(newDraft || selectedId) && <><label className="theme-field-label" htmlFor="theme-name">Theme name</label>
    <input id="theme-name" className="theme-name" value={name} maxLength={48} placeholder="Name your theme" disabled={pending} onChange={event => { dirty.current = true; setName(event.target.value); if (!selectedId) setNewDraft(true); setMessage(''); }} />
    <div className="theme-form-actions"><button className="button-primary" disabled={pending || !name.trim()}>{pending ? 'Saving…' : selectedId ? 'Save changes' : 'Save theme'}</button><button type="button" className="text-button" disabled={pending} onClick={() => { reset(); clearPreview(); }}>Cancel</button></div></>}
    <p className="theme-feedback" role="status" aria-live="polite">{message}</p>
  </form>;
}
