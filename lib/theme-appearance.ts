import type { ThemeAppearance, ThemeColors, ThemeLibrary } from './theme-contract';
import { checkedThemeFont, DEFAULT_FONT, fontFamily, THEME_FONTS } from './theme-fonts';
import type { FontId } from './theme-fonts';
import { THEME_PRESETS } from './theme-presets';

// Retain the internal export name for existing consumers; the default preset is Glacier.
export const GLACIAL_COLORS: ThemeColors = {
  accent: THEME_PRESETS[0].accent, background: THEME_PRESETS[0].background, foreground: THEME_PRESETS[0].foreground,
};
export const THEME_CACHE_KEY = 'cliptext.theme.v1';

const customProperties = ['--theme-accent', '--theme-background', '--theme-foreground', '--on-accent', '--control-thumb', '--app-font-family'];

function luminance(hex: string) {
  const channels = [1, 3, 5].map(index => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrastColor(hex: string): '#000000' | '#FFFFFF' {
  const brightness = luminance(hex);
  return (brightness + 0.05) / 0.05 >= 1.05 / (brightness + 0.05) ? '#000000' : '#FFFFFF';
}

/** Old colors-only caches retain DM Sans; only known font IDs enter CSS. */
export function cachedThemeColors(value: unknown): ThemeAppearance | null {
  if (!value || typeof value !== 'object') return null;
  const colors = value as Record<string, unknown>;
  if (![colors.accent, colors.background, colors.foreground].every(color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) return null;
  let font: FontId;
  try { font = checkedThemeFont(colors.font === undefined ? DEFAULT_FONT : colors.font); }
  catch { return null; }
  return { accent: colors.accent as string, background: colors.background as string, foreground: colors.foreground as string, font };
}

/** Saved custom colors win; every preset, including the default Glacier, paints its exact palette. */
export function resolvedThemeAppearance(library: ThemeLibrary): ThemeAppearance {
  const saved = library.themes.find(theme => theme.id === library.activeThemeId);
  if (saved) return saved;
  return THEME_PRESETS.find(theme => theme.id === library.activePresetId) ?? THEME_PRESETS[0];
}

export function paintTheme(colors: (ThemeColors & { font?: FontId }) | null): void {
  if (typeof document === 'undefined') return;
  const checked = colors === null ? null : cachedThemeColors(colors);
  if (colors !== null && !checked) throw new Error('Choose valid colors in #RRGGBB format and a listed font.');
  const root = document.documentElement;
  if (checked) {
    root.setAttribute('data-custom-theme', '');
    root.style.setProperty('--theme-accent', checked.accent);
    root.style.setProperty('--theme-background', checked.background);
    root.style.setProperty('--theme-foreground', checked.foreground);
    const ink = contrastColor(checked.accent);
    root.style.setProperty('--on-accent', ink);
    root.style.setProperty('--control-thumb', ink);
    root.style.setProperty('--app-font-family', fontFamily(checked.font));
    root.dataset.themeMode = contrastColor(checked.background) === '#FFFFFF' ? 'dark' : 'light';
    root.dataset.themeFont = checked.font;
  } else {
    root.removeAttribute('data-custom-theme');
    delete root.dataset.themeMode;
    delete root.dataset.themeFont;
    customProperties.forEach(property => root.style.removeProperty(property));
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', checked?.background ?? GLACIAL_COLORS.background);
}

const bootstrapFontFamilies = JSON.stringify(Object.fromEntries(THEME_FONTS.map(font => [font.id, font.family]))).replace(/</g, '\\u003c');

// Runs before hydration. Cache data contains only colors and an allowlisted font ID.
// Validation and contrast stay aligned with paintTheme; font stacks come from one catalogue.
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var v=JSON.parse(localStorage.getItem(${JSON.stringify(THEME_CACHE_KEY)})||'null'),f=${bootstrapFontFamilies};if(!v||typeof v!=='object'||![v.accent,v.background,v.foreground].every(function(c){return typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c)}))return;var k=v.font===undefined?${JSON.stringify(DEFAULT_FONT)}:v.font;if(typeof k!=='string'||!Object.prototype.hasOwnProperty.call(f,k))return;var r=document.documentElement;function c(h){var a=[1,3,5].map(function(i){var n=parseInt(h.slice(i,i+2),16)/255;return n<=.04045?n/12.92:Math.pow((n+.055)/1.055,2.4)}),l=a[0]*.2126+a[1]*.7152+a[2]*.0722;return(l+.05)/.05>=1.05/(l+.05)?'#000000':'#FFFFFF'}r.setAttribute('data-custom-theme','');r.style.setProperty('--theme-accent',v.accent);r.style.setProperty('--theme-background',v.background);r.style.setProperty('--theme-foreground',v.foreground);r.style.setProperty('--on-accent',c(v.accent));r.style.setProperty('--control-thumb',c(v.accent));r.style.setProperty('--app-font-family',f[k]);r.dataset.themeMode=c(v.background)==='#FFFFFF'?'dark':'light';r.dataset.themeFont=k;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',v.background)}catch(e){}})();`;
