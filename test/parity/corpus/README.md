# STEP + geometry parity corpus

Categorized STEP files measured through **both** kernel adapters — BrepKit and
OpenCascade — so the deltas between them are recorded rather than argued about.
Once OCCT is deleted (Z5) there is no fallback kernel, and this corpus becomes
the regression harness for STEP import/export and for modeling on imported
bodies. It exists while both kernels are still present precisely so the
baselines can be cross-checked against a second implementation.

It is an explicit hard gate: the STEP routing flip (Z3) and the OCCT deletion
(Z5) are blocked until this corpus records green baselines through both
kernels.

```bash
# Run the corpus (its own vitest project, NOT part of the root suite)
pnpm test:parity-corpus

# Rerecord baselines after an intentional kernel or geometry change
OPENZCAD_WRITE_PARITY_BASELINES=1 pnpm test:parity-corpus

# Regenerate the corpus .step files themselves (rare — see below)
OPENZCAD_WRITE_PARITY_CORPUS=1 pnpm test:parity-corpus

# Run against a local brepkit build without touching the lockfile
BREPKIT_WASM_PKG=/abs/path/to/brepkit/crates/wasm/pkg pnpm test:parity-corpus
```

## Why it is a separate vitest project

Every file is imported through two WASM kernels, re-exported, and re-imported.
That is seconds of geometry per file, and the root suite already had to bound
its worker count to stop kernel startup from turning into unrelated timeouts.

The mechanism is the file suffix: corpus suites are named **`*.spec.ts`**, and
the root `vitest.config.ts` `include` only matches `*.test.ts`. So the root run
never picks them up and `vitest.corpus.config.ts` includes nothing else.
**Keep that invariant** — a corpus suite named `.test.ts` silently rejoins the
default pool. CI runs it as its own job (`corpus` in `.github/workflows/ci.yml`).

## Layout

| File | What it is |
| --- | --- |
| `manifest.ts` | The corpus: id, category, purpose, path, and the closed-form reference volume where one exists |
| `step-authoring.ts` | A tiny AP214 writer for the cases no exporter can produce (inch units, degree angles, missing unit context, `BREP_WITH_VOIDS`) |
| `generate.spec.ts` | Regenerates the files; without `OPENZCAD_WRITE_PARITY_CORPUS=1` it byte-verifies the committed ones |
| `*.step` | The corpus itself. Committed on purpose (see below) |
| `../corpus.spec.ts` | The measurement suite: baselines, reference volumes, kernel parity |
| `../corpus-metrics.ts` | What gets measured and how |
| `../corpus-pins.ts` | **The pin list** — every recorded BrepKit/OCCT delta, with owning plan item |
| `../baselines/corpus.json` | Full per-file, per-kernel record |
| `../baselines/import-modeling.json` | Same for the import-modeling scenarios |

The corpus files are **committed, not generated at measurement time**. If they
were produced during the run, a kernel regression would silently rewrite the
very inputs meant to detect it.

## Categories

| Prefix | Category | What it stresses |
| --- | --- | --- |
| `a-` | Exports | The `samples/` files plus adapter exports of primitives and a boolean result — the all-planar and analytic-surface baselines |
| `b-` | Units | mm, inch via `CONVERSION_BASED_UNIT`, degree plane angles, and a file with no `GLOBAL_UNIT_ASSIGNED_CONTEXT` at all |
| `c-` | Voids | `BREP_WITH_VOIDS` cavities, one and two |
| `d-` | Multi-solid | Several `MANIFOLD_SOLID_BREP`s in one representation, including one mixed with a voided solid |
| `e-` | NURBS-heavy | A blended plate written as B-splines, paired with the *same nominal shape* written analytically |
| `f-` | Known-hostile | OCCT-authored encoding, an open shell, a dangling reference, and a file with no shape representation |

`modeling-base-plate.step` sits outside the categories: it is the shared base
body the import-modeling scenarios (`fillet-on-import`, `boolean-with-import`,
`shell-on-import`, …) are layered on.

## What gets recorded

Per file, per kernel, in `../baselines/corpus.json`:

- **import warnings** — the full list, verbatim, not a count. The warning text
  is the import taxonomy K0.6 has to reproduce.
- **body count**, **volume**, **face count**, **edge count**, **seam edge
  count**.
- **topology witness sets** — surface-type histogram, count of faces and edges
  publishing a schema-v5 reference, the distinct lineage names, and an FNV-1a
  digest of the sorted face and edge hash sets. Hashes are the identity
  substrate stored feature references resolve against, so a digest change means
  a saved edge pick would land differently after the kernel flip.

  Since K0.6 an imported body names every face and edge by its own exact
  fingerprint — an import has no feature contract to name its topology from —
  so the name set can be large. The baseline keeps the full sorted list; the
  *comparison* folds anything over twelve names to a count plus a digest, the
  same fold the hash sets already use, so a divergence stays a pin literal
  rather than a 50 KB dump. Equality is unaffected: the digests match iff the
  name sets do.
- **`inspectStep`** — the pre-import validity probe the app shows users.
- **round-trip delta** — re-export through the same kernel, re-import, and
  record the volume/face/edge deltas plus whether the re-export kept its solid
  count and its `BREP_WITH_VOIDS`. This is the only metric that catches writer
  defects; a reader-only harness cannot see a writer that drops cavities.

## The three bars

1. **Baseline** — each kernel still reports what it reported last time.
2. **Reference** — where a file has a closed-form volume derived from its own
   construction, each kernel must match it. This is the only bar that can say
   which kernel is *wrong* rather than merely different, and it is why several
   corpus files are hand-authored boxes: arithmetic neither implementation gets
   a vote on.
3. **Parity** — BrepKit and OCCT agree, except exactly where `corpus-pins.ts`
   records that they do not.

## Adding a file

1. Add a `CorpusEntry` to `manifest.ts`: pick the category prefix, write a
   one-line `purpose` (it is embedded in the file itself), and set
   `referenceVolumeMm3` if the shape has a closed-form volume — please do,
   it is what makes a future delta decidable. Set `expectNoSolids` for a file
   that should not import at all.
2. Produce the file:
   - *hand-authored* (units, voids, malformed): add it to `authoredFiles()` in
     `generate.spec.ts` using `writeBoxStepFile`. These are byte-verified on
     every run, so they cannot be edited in place.
   - *derived* from another corpus file: add it to `derivedFiles()`. Also
     byte-verified.
   - *adapter-exported*: add the id to `EXPORTED_IDS` and a producer to the
     `produce` map. These are only rewritten under
     `OPENZCAD_WRITE_PARITY_CORPUS=1`, because a kernel bump legitimately
     changes their bytes.
3. `OPENZCAD_WRITE_PARITY_CORPUS=1 pnpm test:parity-corpus` to write it.
4. `OPENZCAD_WRITE_PARITY_BASELINES=1 …` to record it.
5. Run once more with no env vars. Any BrepKit/OCCT divergence now fails with
   the exact pin literal to paste into `corpus-pins.ts`. Fill in the owning
   plan item and a note that says what closing it looks like.
6. Commit the `.step` file, the manifest entry, both baselines, and any pins.

## Re-recording

`OPENZCAD_WRITE_PARITY_BASELINES=1` rewrites `../baselines/corpus.json` and
`../baselines/import-modeling.json` wholesale. **Read the diff.** A baseline
rerecord is the one operation in this lane that can erase a regression, so the
diff is the review: every changed number should be attributable to the change
you are making.

Re-recording does *not* touch the pin list. Pins are asserted against live
measurements in both directions, so a kernel fix turns the corpus red until the
pin is retired by hand — which is the point.

## Adding a modeling scenario

`IMPORT_MODELING_SCENARIOS` in `../scenarios.ts`. Each scenario builds a
document on top of an imported body and carries a `nominalVolumeMm3` worked out
from the construction by hand, plus a `nominalRtol`. A loose tolerance must be
explained on the scenario — an unexplained loose tolerance is how a real defect
hides.

These deliberately do **not** join `PARITY_SCENARIOS`: a document containing an
`imported-step` feature routes the whole hybrid adapter to OpenCascade, so
running them in the default pool would add an OCCT instantiation to the fast
suite and still not show the delta they exist to measure.
