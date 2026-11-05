# Captured direct-edit fixtures

Files here are drops from the app's **Export interaction log**, or from
**Save reproduction** beside a refusal's **View details**. One fixture per
file, JSON, in the `openzcad-direct-edit-fixture` format defined by
`apps/web/src/lib/directEditFixture.ts`.

A saved reproduction uses the `feature-build` op: its document is the history
up to and including the refused feature (names neutralised, later features
and the command log removed), and replay is one rebuild judged by the shipped
feature gate. Its pin is also checked against the recorded
`observed.kernelRefusal`, so a refusal that changes kernel category is a new
cell rather than the same pin.

Rules the corpus enforces:

- **The file stem must equal `fixture.name`.** `corpus.test.ts` names each test
  after the stem and looks the pin up by `fixture.name`; a mismatch would let a
  pin silently apply to nothing.
- `format` must be `openzcad-direct-edit-fixture` and `formatVersion` must be
  `1` or `2` (version 2 added `feature-build`).
- A fixture whose `document` is `null` (imported geometry, whose source
  metadata the export does not sanitize) is skipped with its
  `documentOmitted` reason rather than failing.

Drop a file in and run `pnpm exec vitest run test/direct-edit-corpus`. A
refusal that is not in `../pins.ts` fails, which is the point: add the pin with
the literal message and the roadmap item that owns closing it.

Nothing is edited by hand after export. If a capture no longer reproduces, it
has been repaired — retire its pin, do not adjust the fixture.
