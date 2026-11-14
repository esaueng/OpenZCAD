# Unit test suites

Routine pull-request and merge-queue CI run the critical Vitest manifest
in `test/unit-ci-files.json` plus the test files a change affects (fleet v8;
see [CI qualification](ci-qualification.md) for when the complete suites run).
The manifest covers representative model and command operations,
exact-kernel validation/refusal, persistence, account authorization, crypto/MLS,
and the web's editing, saving, sharing and recovery paths. Workflow, privacy,
package, bundle, deployment and roadmap guards remain in this selection.

This intentionally reduces routine regression coverage. Extended geometry,
encryption state-machine, race and historical cases remain in the full suite.
New files are full-suite coverage until added to the smoke manifest. Keep
representative capabilities and guard suites here rather than every variant.
The staged v7 runner also discovers affected files from the full project and
unions them with this manifest, so changed regressions are not omitted from
their own PR. Discovery failures fall back to the complete project. See
[CI qualification](ci-qualification.md) for activation and daily full runs.
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
separate parity corpus, browser profile, assertions, isolation and worker limits
are unchanged. No workflow pins or required checks change.

## Windows

Use Node with its bundled npm, Git for Windows, and Python 3.10+. The policy
harness rejects Microsoft Store aliases that do not start an interpreter.
For a custom Python installation, set `OPENZCAD_PYTHON` to its executable;
`OPENZCAD_BASH` can select Git Bash explicitly. Python subprocesses use UTF-8,
including their disposable Git metadata and captured workflow text.

The recovery tool explicitly requires Linux, POSIX descriptors, private tmpfs
and GnuPG ([prerequisites](../scripts/recovery/README.md)). On Windows its
unchanged synthetic recovery suite runs through the default WSL distribution,
which must have Python and GnuPG installed. The root Vitest runner and all
other tests run natively on Windows.

Filesystem fixtures use NTFS junctions for directory/file-path aliases on
Windows and symlinks on POSIX. They still test actual filesystem resolution,
inode identity, dangling reparse points and byte preservation. Developer Mode
and administrator privileges are not required.

## Policy fixture setup

The root CI global setup acquires the existing immutable Git fixtures before
workers start, with a 60-second process limit and fatal acquisition errors.
When the shallow-checkout regression is selected, its disposable history is
also prepared before workers, including in a local full run. Its original
provenance assertions still run in the individual test cases.
That disposable six-commit history uses normal shared Git hooks and has a
separate two-minute provisioning budget (65 seconds measured on Windows).
On timeout, the supervisor retires its owned process tree before cleanup;
Windows cleanup retries transient locks and preserves the original error.
The policy suite still runs its original setup and every assertion under the
existing deadlines, including the cold/offline/stale-pin negative controls.
The nested deadline harness uses its own full-selection config without outer
global prewarming, so its deliberately cold control must still time out.
This prevents a slow cold Git transfer from consuming the policy hook's
10-second deadline, as happened in the preceding browser-profile PR.
The nested routing control retains its five-second assertion deadline and
ten-second preparation deadline. The outer process harness separately allows
startup time. Multi-process Git fixtures have explicit 30-second integration
budgets. Root `test/e2ee-*.test.ts` files exercise complete encrypted-project
flows with real cryptography and use a 30-second integration default. Other
unit tests retain their five-second default, and explicit per-case deadlines
still take precedence. Runtime regressions check all three boundaries.
Protocol, provenance and refusal assertions remain unchanged.
The explicit approximate-boolean validation probe has a 30-second integration
budget. Policy child processes are bounded at 25 seconds while the routing
probe keeps its five-second test deadline. Structured-output qualification
checks every rollout flag combination in batches of 64, retaining the ordinary
unit deadline.
The envelope stress checks retain the 500,000-part join under the ordinary
unit deadline. Real 5,000-record encryption/decryption and 3,000-record hashing
have 30-second bulk-workload budgets, retaining every record and plaintext
comparison. Rejection ceilings and resource-limit assertions are unchanged.
The longer three-account historical-authority journey has a one-minute
budget, retaining every fresh-browser and historical-version check.

The 1,024-replay kernel-retirement stress case has a five-minute budget and
the gear fixture uses its suite's existing one-minute geometry budget. The
glyph audit scans the real source tree once in a bounded 30-second setup;
coverage and scan-floor assertions inspect that same result. These checks
assert correctness and ownership, not elapsed-time performance. Global test
timeouts, worker limits, replay counts and assertion thresholds are unchanged.
The dense spline oracle still checks all 120 seeded trials and all 4,000
chords. A sweep over sorted closed x intervals skips provably disjoint pairs,
retaining the original crossing arithmetic, chord order and default test
deadline. Differential fixtures retain the original quadratic pair scan as
an independent check of candidate discovery.
Repeated STEP byte comparisons supply a fixed timestamp through the public
export options, since the API defaults to export time. The checkpoint test
advances the clock across a second while retaining equality of every byte,
including the header; STL equality and ownership checks are unchanged.
