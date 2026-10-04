# Vendored fonts

Self-hosted so `next build` never fetches from fonts.googleapis.com or
fonts.gstatic.com (a malformed Google response failed the build before).
The latin subset of each family is loaded in `src/app/layout.tsx` through
`next/font/local` (and is the only subset preloaded). The other subsets are
plain `@font-face` rules in `src/app/fonts-extra.css`, because `next/font/local`
cannot express `unicode-range`.

| File | Family | Weights used | Subset |
| --- | --- | --- | --- |
| `sora-latin-wght-normal.woff2` | Sora | 500, 700 | latin |
| `inter-latin-wght-normal.woff2` | Inter | 400, 500, 600 | latin |
| `jetbrains-mono-latin-wght-normal.woff2` | JetBrains Mono | 400, 500 | latin |

### Extra subsets (decision)

Vendored: exactly the subsets the old `next/font/google` CSS served per
family, where fontsource ships them. The files add about 230 KB to the repo
but a browser only fetches a face when a rendered glyph falls in its
`unicode-range`, so a latin-only page transfers none of them.

| Family | Extra subsets vendored |
| --- | --- |
| Sora | latin-ext |
| Inter | latin-ext, cyrillic, cyrillic-ext, greek, greek-ext, vietnamese |
| JetBrains Mono | latin-ext, cyrillic, cyrillic-ext, greek, vietnamese |

Files are named `<family>-<subset>-wght-normal.woff2`. fontsource ships no
Sora cyrillic/greek/vietnamese or JetBrains Mono greek-ext files, so those
glyphs stay on the fallback font.

`fonts-extra.css` is generated from the `@font-face` rules of the fontsource
5.3.0 `wght.css` files: `unicode-range` and `font-weight` are copied verbatim
and only the family name (`Sora Extra`, `Inter Extra`, `JetBrains Mono Extra`)
and the `url()` path are rewritten. They are separate family names because
`next/font/local` registers its own hashed family. In `globals.css` the
`--font-display-stack`, `--font-sans-stack` and `--font-mono-stack` variables
put the extra family first, then the next/font variable. The extra family has
to come first: the next/font variable ends in a metric-matched local fallback
(Arial) that would otherwise claim the non-latin glyphs before the vendored
face is consulted. Use the `-stack` variables in `font-family` declarations
(`src/fonts/fonts.test.ts` fails on a raw `var(--font-sans|display|mono)`).

Because the extra family comes first, the few combining marks that fontsource
lists in both the latin range and an extra range (U+0301, U+0304, U+0308,
U+0329) resolve to the extra face, so decomposed (NFD) latin text with such a
mark loads that subset file. Base glyph and mark come from the same font, so
rendering is unaffected; the ranges are kept verbatim to stay regenerable.

All three are variable fonts (wght axis, normal style). Source: the
`@fontsource-variable/sora`, `@fontsource-variable/inter` and
`@fontsource-variable/jetbrains-mono` npm packages, version 5.3.0 each, files
under `files/<family>-<subset>-wght-normal.woff2` (fontsource repackages the
upstream OFL fonts: the same font versions and latin glyph coverage as
Google Fonts, though not byte-identical files).

## Licenses

All three fonts are licensed under the SIL Open Font License 1.1. The license
texts (with each project's copyright line) are in `OFL-Sora.txt`,
`OFL-Inter.txt` and `OFL-JetBrains-Mono.txt`, copied verbatim from the
fontsource packages.

## Updating

Fetch the new `files/*-wght-normal.woff2` from the same packages
(`npm pack @fontsource-variable/<family>`), replace the files here, regenerate
`src/app/fonts-extra.css` from the package's `wght.css` (skip the latin rule),
and update the version above.
