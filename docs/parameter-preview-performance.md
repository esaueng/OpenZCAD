# Parameter preview and exact rebuild performance

Parameter drafts now have a separate viewport path. Recognized growing holders reuse
source meshes and update Three.js matrices while the exact worker validates the
committed value. Enter or blur requests validation; Escape cancels the draft. The
approximate display never enters the document, undo history, topology selection,
STEP export, or saved backup.

## Supported display path

- Compiled growing-holder recipes, including width and height controls.
- The older seven-feature construction: two imported ends, a fixed bridge profile,
  an extrusion, two translations, and a union. Recognition requires its complete
  matching graph and expressions; it does not rewrite or approximate its STEP data.
- Supported downstream linear/grid patterns use shared mesh buffers. They display
  overlapping instances without pretending to have computed their exact union.
- Structural changes, unknown warnings, affected feature failures, invalid values,
  and unsupported dependencies decline the preview. Attributed suppression and
  unrelated feature warnings do not disable an otherwise usable construction.

Warning provenance stays in the session's preview baseline. `attachDerivedState`
intentionally strips that provenance from persisted state, so the preview must retain
its own copy of the original worker result.

Before an active pattern, the worker can publish an upstream mesh-only projection.
It remains non-exportable and never marks geometry ready. This path is bounded to
16 upstream bodies and a 32 MiB mesh payload. The application only displays a
projection if its project and version match, and the supported construction can be
recognized. Drafts can then move those meshes even while synchronous WASM continues
building the pattern. Initial framing and Fit include the preview objects.

## Exact work reduced

Parameter validation queues at most one active job and the newest pending edit on
the main thread. Superseded pending requests reject; active synchronous WASM is not
interrupted. Existing version/request guards prevent an obsolete result from
committing, and invalid exact results still refuse the transaction.

A union accepted by face cleanup has already passed strict solid validation and
mesh closure. The immediate subsequent feature check reuses that local acceptance
for the identical solid. Raw fallback results still run both checks, and the later
measurement validation remains intact. There is no persistent validation cache.

Consumed bodies no longer compute background mass properties. Their exact meshes,
volume and topology are still measured; visible results retain mass properties under
the existing face-count limit. Measurement cache keys include that distinction so
changing consumption cannot accidentally hide a newly visible body's properties.

## Local observations, 2026-09-13

Measured with headless Chromium on the development Mac and temporary copies of the
supplied complex holder. Original files were unchanged and were not added to the
repository. These are local observations, not cross-device performance guarantees.

| Case | Observed result |
| --- | --- |
| Warm width edit, grid suppressed: previous exact worker round trip | 18.4 s |
| Same edit with these changes: exact worker round trip | 15.4 s |
| First warm draft: input callback to viewport object installation | 16.1 ms |
| Active original grid: first upstream projection after sync request | About 9.4 s |
| 21 draft edits while the original grid computes | 2.1–3.2 ms; p95 2.9 ms to object installation |

The User Timing measurement `oz:parameter.preview.install` ends after updating the
viewport objects, before the next browser presentation. It is not a measurement of
GPU completion or monitor scanout. Warm exact timings are single-run comparisons;
the kernel and optional recognition still dominate them.

The active dense grid was stopped after verifying its responsive intermediate
projection. Its final exact completion time has **not** been established by these
measurements. Overlapping instances still require expensive exact intersection and
union work. A 1–3 second complete regeneration target is not achieved here.

## Validation and remaining work

Regression coverage includes all preview axes, combined width/height edits, the
legacy graph, warning attribution, grid buffer reuse/disposal, Escape, superseded
validation, ephemeral projection freshness, exact cache parity, invalid-edit
refusal, saved state and repair of an already-invalid document. The full unit
suites, focused browser parameter-validation tests, typecheck, lint and production
bundle budgets were exercised. Lint retains the repository's existing hook warnings.

The next kernel performance work should separately measure face unification,
strict validation, imported feature recognition, and pattern pair intersections.
Recognition and mass-property enrichment need an explicit on-demand lifecycle before
moving them off the exact-result path. Rigid-transform measurement reuse needs
proof-preserving topology handling. Repeated relative placements in a regular grid
are candidates for scoped overlap-result reuse, with exact union/volume regression
coverage. None of those further changes is silently substituted by a faceted export
or weakened geometry acceptance.
