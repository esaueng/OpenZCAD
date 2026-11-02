# STEP and geometry regression corpus

The corpus checks the production Remus adapter against committed measurements
and independent construction arithmetic. `pnpm test:parity-corpus` runs it in a
serial Vitest project, separate from the root `*.test.ts` suites.

## Inputs and checks

`manifest.ts` lists each STEP input, its purpose and its analytic reference
volume when known. `../scenarios.ts` defines modeling operations on imported
bodies with hand-derived nominal volumes and explained tolerances.

- `../corpus-metrics.ts` measures import diagnostics, body/face/edge counts,
  surface types, topology witnesses, lineage/hash digests and STEP roundtrips.
- `../baselines/corpus.json` and `../baselines/import-modeling.json` retain the
  recorded Remus results. Every remaining value is unchanged by removal of the
  comparison kernel.
- `../corpus-pins.ts` records known deviations from analytic expectations.
  Repairs must retire the pin; regressions must be fixed, not rebaselined.

Categories cover primitives and exports (`a-`), units (`b-`), cavities (`c-`),
multiple solids (`d-`), curved surfaces (`e-`) and malformed or independent
exporter encodings (`f-`). `modeling-base-plate.step` is the shared modeling
input.

## Reproducing and extending the corpus

Inputs are committed, never regenerated during measurement. `generate.spec.ts`
byte-verifies hand-authored and derived files on each run. Its Remus export
producers run only with `OPENZCAD_WRITE_PARITY_CORPUS=1`. The independent
`e-analytic-fillet-plate` and `f-hostile-occt-authored-box` inputs are frozen and
SHA-256 checked; their OCCT exporter provenance is retained in the manifest and
STEP headers. They contain geometry data, not the exporter implementation, and
require no OCCT dependency.

Add a manifest entry with a descriptive purpose and reference volume where
known. Add deterministic authoring/derivation to the generator, or commit a
separately documented frozen interchange fixture. New modeling scenarios need
an independently derived `nominalVolumeMm3` and an explained `nominalRtol`.

Record intended baseline changes explicitly:

```bash
OPENZCAD_WRITE_PARITY_CORPUS=1 pnpm test:parity-corpus
OPENZCAD_WRITE_PARITY_BASELINES=1 pnpm test:parity-corpus
pnpm test:parity-corpus
```

Review every changed measurement against the intended geometry change. Recording
baselines does not update pins. Commit fixtures, manifest entries and reviewed
baselines together. The original command name is retained for CI compatibility.
