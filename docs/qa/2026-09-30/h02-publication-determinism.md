# H02 fresh-build publication determinism (2026-09-30)

The opt-in private fresh-build publication oracle introduced by PR #488
(`test/h02-private-holder-cache.test.ts`, evidence in that PR's
`docs/qa/2026-09-29/h02-cache-safety.md`) failed on both unmodified main
(`8da82a0b`) and the hardened cache with the same two differing field
families: 73 `topology.faces.*.geometry.blendRegionKey` values and eight
`topology.lineageDiagnostics.*.message` values across eight of 17 bodies,
while all other compared fields of all 720 faces matched. This change fixes
both families at the source. The private STEP source never entered this
repository; all evidence below is on redistributable geometry.

## Root cause

Both families quoted Remus kernel arena handles, which are rebuild-local:

- `measureBlendRegion` keyed each blend region as
  `${solidHandle}:${faceHandles…}`. A warm adapter restoring a history
  checkpoint and replaying a suffix allocates handles from the restored
  arena's free list; a cold adapter rebuilding the same geometry from an
  empty kernel numbers them differently. Identical geometry therefore
  published different keys — including keys retained by the measurement
  cache from an older arena.
- Seven published lineage-diagnostic sentences interpolated raw handles
  (`remus-lineage.ts`: pattern-journal claim, direct-edit naming conflict,
  transform merge, boolean-evolution unverified face, preserved-edge witness
  change, and the two boolean evolution/carrier disagreement messages). The
  same arena renumbering changed the sentences.

Public confirmations that this predates PR #488: the reproduction test below
fails on unmodified main (one region publishing `11:45` warm vs `25:103`
cold), `test/stepped-bore-parameter-replay.test.ts` had to strip
`blendRegionKey` from its rebuild comparison, and the cad-operations
benchmark's warm/fresh oracle had to strip it too.

## Fix

- `blendRegionKey` is now `blend:<sorted member ADR-011 face hashes>`. The
  publication pass in `measureShape` reuses the hashes its face loop already
  computed (no extra kernel calls); the direct-edit reproof
  (`requireBlendRegion`) recomputes member hashes from exact witnesses, so a
  reproof in any arena names the region exactly as publication did. A member
  without a hash withdraws `editableDimension`/`blendRegionFaceCount`
  (fail closed); `measureBlendRegion` still fails closed to `null`.
- The seven messages name only lineage names, topology kinds and counts —
  all functions of the geometry and document, never of the arena. Internal
  `RemusLineageDiagnostic` records keep `sourceHandle`/`resultHandles`, so
  debugging loses nothing; only the published projection is handle-free.
- Nothing was stripped or relaxed to make an assertion pass. The comparisons
  below still normalize only the two documented arena-bound
  `recognizedOpening.evidence.candidate.faceA/faceB` diagnostic indices, as
  the existing public holder equivalence test does.

## Regression coverage

- `test/h02-publication-determinism.test.ts` — public mirror of the private
  oracle: a warm adapter (asserted to take the `prefix-restore` path) versus
  a cache-disabled cold adapter over a filleted stepped-bore part; compares
  volume, bbox, face count, triangle count and the full topology including
  every `blendRegionKey`, face hash, witness reference and lineage
  diagnostic. Fails on main, passes with the fix.
- `packages/kernel-adapter/src/lineage-message-determinism.test.ts` — drives
  every former handle-quoting producer under two arena numberings (natural
  and +4000-shifted) and requires byte-identical projected diagnostics, with
  the exact copy pinned and no digits in the conflict sentences.
- `test/stepped-bore-parameter-replay.test.ts` and
  `test/perf/cad-operations.bench.ts` no longer strip `blendRegionKey`; both
  compare it like every other published field.

## Local verification

Linux x64, Node v24.14.0, frozen install, Remus pin `594cd308` unchanged.

- `pnpm lint`: 0 errors (19 pre-existing warnings); `pnpm typecheck`: clean.
- `pnpm test`: root 3178 passed / 6 skipped, web 1524 passed.
- `pnpm test:parity-corpus`: 178 passed / 1 skipped.
- `pnpm build`: exit 0 (bundle policy: the pre-existing kernel size-review
  warning only, no failures).
- Cad-operations benchmark, fillet family, history 30, one sample
  (`CAD_PERF_RUN=1`): operation/early/late warm-versus-fresh parity all
  `equal`, zero mismatches, with `blendRegionKey` compared.

## What remains for the private oracle

The private run itself needs the maintainer's STEP source
(`OZ_PERF_HOLDER_STEP=/path/to/source.step pnpm exec vitest run
test/h02-private-holder-cache.test.ts` on a branch carrying PR #488's test,
rebased on this fix). Both field families it reported are deterministic at
the source now, so its remaining difference paths should be empty; the rerun
is the confirmation. Serialized raw B-rep byte equivalence across arenas
remains unproven and stays an acceptance blocker for any future detached
Text-branch cache, as does the separate 20% p95 performance target.
