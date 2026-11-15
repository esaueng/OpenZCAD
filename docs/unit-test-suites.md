# Unit test suites

Routine pull-request and merge-queue CI run the critical Vitest manifest
in `test/unit-ci-files.json` plus the test files a change affects (see
[CI qualification](ci-qualification.md) for when the complete suites run).
The manifest covers representative model and command operations,
exact-kernel validation/refusal, persistence, account authorization, crypto/MLS,
and the web's editing, saving, sharing and recovery paths. Workflow, privacy,
package, bundle, deployment and roadmap guards remain in this selection.

This intentionally reduces routine regression coverage. Extended geometry,
encryption state-machine, race and historical cases remain in the full suite.
New files are full-suite coverage until added to the smoke manifest. Keep
representative capabilities and guard suites here rather than every variant.
The active runner also discovers affected files from the full project and
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
