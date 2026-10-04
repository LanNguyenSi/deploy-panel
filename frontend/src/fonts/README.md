# Vendored fonts

Self-hosted so `next build` never fetches from fonts.googleapis.com or
fonts.gstatic.com (a malformed Google response failed the build before).
Loaded in `src/app/layout.tsx` through `next/font/local`.

| File | Family | Weights used | Subset |
| --- | --- | --- | --- |
| `sora-latin-wght-normal.woff2` | Sora | 500, 700 | latin |
| `inter-latin-wght-normal.woff2` | Inter | 400, 500, 600 | latin |
| `jetbrains-mono-latin-wght-normal.woff2` | JetBrains Mono | 400, 500 | latin |

All three are variable fonts (wght axis, normal style). Source: the
`@fontsource-variable/sora`, `@fontsource-variable/inter` and
`@fontsource-variable/jetbrains-mono` npm packages, version 5.3.0 each, files
under `files/<family>-latin-wght-normal.woff2` (fontsource repackages the
upstream OFL fonts: the same font versions and latin glyph coverage as
Google Fonts, though not byte-identical files).

## Licenses

All three fonts are licensed under the SIL Open Font License 1.1. The license
texts (with each project's copyright line) are in `OFL-Sora.txt`,
`OFL-Inter.txt` and `OFL-JetBrains-Mono.txt`, copied verbatim from the
fontsource packages.

## Updating

Fetch the new `files/*-latin-wght-normal.woff2` from the same packages
(`npm pack @fontsource-variable/<family>`), replace the files here, and update
the version above.
