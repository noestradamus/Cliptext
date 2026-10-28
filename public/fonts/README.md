# Cliptext fonts

DM Sans is the existing default, provided by `dm-sans.css` and `OFL.txt`.
`theme-fonts.css` adds 19 optional families. These are self-hosted WOFF2 Latin
subsets downloaded from the official Google Fonts CSS API and font CDN.
No Google-hosted stylesheet or font URL is requested by the application at runtime.
The browser loads a font face only when that family and its covered characters
are used.

`theme-fonts-provenance.json` records each original URL, file size, SHA-256 hash,
supported weight range, and upstream project. Per-family licenses and copyright
notices are retained in `licenses/`. All 19 additions use the SIL Open Font License.

The optional assets include normal styles at weights 400–700; static-only
families provide regular and bold, with intermediate CSS weights matched by the
browser. Unsupported characters use the configured platform fallback. The Latin
subsets cover common Western European accents and typographic punctuation;
they do not replace the platform's CJK, Arabic, or Cyrillic fonts.
