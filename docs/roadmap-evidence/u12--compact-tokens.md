---
row: U12
---

Slice 3 (visual tokens): `theme/tokens.css` re-declares radius (8/12/16/24 px), type (17/15/13 px, weights 400/600, sentence-case eyebrows), warm near-neutral colour, tinted-selection and soft-shadow tokens under `[data-shell='compact']` for dark, light and system-light; the regular workspace keeps its values, with `--radius-xl`, `--tt-eyebrow` and `--ls-eyebrow-scale` added at their regular equivalents. Literal 2/3/4 px radii and tracked eyebrow capitals now draw from the tokens. `theme/contrast.test.ts` measures every compact text and UI pair in both themes, `theme/tokens-defined.test.ts` checks the compact blocks only use and re-declare regular tokens, and `theme/compactTokens.test.ts` keeps every override scoped to the compact shell.
