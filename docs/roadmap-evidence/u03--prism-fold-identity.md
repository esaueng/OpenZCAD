---
row: U03
---
Prism Fold identity slice: the app mark, compact favicon, outlined wordmark
and desktop icon share one geometric source, with flat blue face shading and
a solid monochrome fallback (see `docs/brand.md`, PR #964).
`test/brand-assets.test.ts` checks SVG drift and declared raster sizes. Local
lint, typecheck, both test projects, parity corpus and production build pass;
four browser smoke cases cover top-bar behavior, themes and the mobile launcher.
