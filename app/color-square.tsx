"use client";

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { hexToHsv, hsvToHex, normalizeHex } from '../lib/color';
import type { HsvColor } from '../lib/color';

const limit = (value: number) => Math.max(0, Math.min(100, value));
function retainAchromaticHue(next: HsvColor, previous: HsvColor): HsvColor {
  return {
    ...next,
    h: next.s === 0 || next.v === 0 ? previous.h : next.h,
    s: next.v === 0 ? previous.s : next.s,
  };
}

export default function ColorSquare({ label, value, onChange }: {
  label: string; value: string; onChange: (hex: string) => void;
}) {
  const normalized = normalizeHex(value) ?? '#000000';
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(normalized));
  const [hexDraft, setHexDraft] = useState(normalized);
  const hsvRef = useRef(hsv);
  const lastEmitted = useRef<string | null>(null);
  const hexFocused = useRef(false);
  const pointer = useRef<number | null>(null);
  const id = useId();

  useEffect(() => {
    if (normalized !== lastEmitted.current) {
      const next = retainAchromaticHue(hexToHsv(normalized), hsvRef.current);
      hsvRef.current = next; setHsv(next);
    }
    if (!hexFocused.current) setHexDraft(normalized);
    lastEmitted.current = null;
  }, [normalized]);

  function update(next: HsvColor) {
    hsvRef.current = next; setHsv(next);
    const hex = hsvToHex(next);
    lastEmitted.current = hex;
    if (!hexFocused.current) setHexDraft(hex);
    onChange(hex);
  }
  function point(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    update({ ...hsvRef.current, s: limit((event.clientX - rect.left) / rect.width * 100), v: limit(100 - (event.clientY - rect.top) / rect.height * 100) });
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    const current = hsvRef.current;
    const step = event.shiftKey ? 10 : 1;
    let next: HsvColor;
    switch (event.key) {
      case 'ArrowLeft': next = { ...current, s: limit(current.s - step) }; break;
      case 'ArrowRight': next = { ...current, s: limit(current.s + step) }; break;
      case 'ArrowUp': next = { ...current, v: limit(current.v + step) }; break;
      case 'ArrowDown': next = { ...current, v: limit(current.v - step) }; break;
      case 'Home': next = { ...current, s: 0 }; break;
      case 'End': next = { ...current, s: 100 }; break;
      default: return;
    }
    event.preventDefault(); update(next);
  }
  function commitHex() {
    const hex = normalizeHex(hexDraft);
    if (!hex) { setHexDraft(normalized); return; }
    setHexDraft(hex);
    update(retainAchromaticHue(hexToHsv(hex), hsvRef.current));
  }

  return <fieldset className="color-square">
    <legend>{label}</legend>
    <div className="color-sv" role="slider" tabIndex={0} aria-label={`${label} saturation and brightness`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s)} aria-valuetext={`${Math.round(hsv.s)}% saturation, ${Math.round(hsv.v)}% brightness`} aria-describedby={`${id}-keys`}
      style={{ background: `linear-gradient(to top, #000000, transparent), linear-gradient(to right, #ffffff, hsl(${hsv.h} 100% 50%))`, touchAction: 'none' }}
      onKeyDown={keyboard}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); point(event);
      }}
      onPointerMove={event => { if (pointer.current === event.pointerId) point(event); }}
      onPointerUp={event => {
        if (pointer.current !== event.pointerId) return;
        point(event); pointer.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { pointer.current = null; }} onLostPointerCapture={() => { pointer.current = null; }}>
      <span className="color-sv-thumb" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }} aria-hidden="true" />
    </div>
    <label className="color-hue"><span className="screen-reader-status">{label} hue</span><input type="range" min={0} max={359} step={1} value={Math.min(359, Math.round(hsv.h))} aria-label={`${label} hue`} onChange={event => update({ ...hsvRef.current, h: Number(event.target.value) })} /></label>
    <div className="color-hex-row"><span className="color-swatch" aria-hidden="true" style={{ background: normalized }} /><input type="text" value={hexDraft} aria-label={`${label} hex`} maxLength={7} autoCapitalize="none" autoCorrect="off" spellCheck={false} onFocus={() => { hexFocused.current = true; }} onChange={event => setHexDraft(event.target.value)} onBlur={() => { hexFocused.current = false; commitHex(); }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); commitHex(); }
      if (event.key === 'Escape') { event.preventDefault(); setHexDraft(normalized); }
    }} /></div>
    <span className="screen-reader-status" id={`${id}-keys`}>Left and right adjust saturation. Up and down adjust brightness. Hold Shift for larger steps.</span>
  </fieldset>;
}
