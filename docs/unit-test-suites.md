# Unit test suites

Routine pull-request and merge-queue CI run a focused Vitest smoke selection
from `test/unit-ci-files.json`: representative model and command operations,
exact-kernel validation/refusal, persistence, account authorization, crypto/MLS,
and the web's editing, saving, sharing and recovery paths. Workflow, privacy,
package, bundle, deployment and roadmap guards remain in this selection.

This intentionally reduces routine regression coverage. Extended geometry,
encryption state-machine, race and historical cases remain in the full suite.
New files are full-suite coverage until added to the smoke manifest. Keep
representative capabilities and guard suites here rather than every variant.
Manifest entries must be unique existing test files; a stale selection fails
before running tests. Worker-owned web suites are all retained.

## Commands

- `pnpm test`: both projects, full locally and smoke when `CI` is set.
- `OPENZCAD_UNIT_SUITE=smoke pnpm test`: smoke selection locally.
- `pnpm test:full`: explicitly full root and web suites, including in CI.
- `pnpm test:unit:full` / `pnpm test:web:full`: either full project.
- `OPENZCAD_UNIT_SUITE=full`: select full coverage in a CI invocation.

Kernel overlays (`REMUS_WASM_PKG` / `REMUS_WASM_IO_PKG`) keep the full suite
by default. Coverage reporting also explicitly selects full coverage. The
separate parity corpus, browser profile, assertions, isolation, worker limits
and test/hook deadlines are unchanged. No workflow pins or required checks
change.

## Policy fixture setup

The root CI global setup acquires the existing immutable Git fixtures before
workers start, with a 60-second process limit and fatal acquisition errors.
The policy suite still runs its original setup and every assertion under the
existing deadlines, including the cold/offline/stale-pin negative controls.
The nested deadline harness uses its own full-selection config without outer
global prewarming, so its deliberately cold control must still time out.
This prevents a slow cold Git transfer from consuming the policy hook's
10-second deadline, as happened in the preceding browser-profile PR.
