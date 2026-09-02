# Captured direct-edit fixtures

Files here are drops from the app's **Export interaction log**. One fixture per
file, JSON, in the `openzcad-direct-edit-fixture` format defined by
`apps/web/src/lib/directEditFixture.ts`.

Rules the corpus enforces:

- **The file stem must equal `fixture.name`.** `corpus.test.ts` names each test
  after the stem and looks the pin up by `fixture.name`; a mismatch would let a
  pin silently apply to nothing.
- `format` must be `openzcad-direct-edit-fixture` and `formatVersion` must be
  `1`.
- A fixture whose `document` is `null` (imported geometry, whose source
  metadata the export does not sanitize) is skipped with its
  `documentOmitted` reason rather than failing.

Drop a file in and run `pnpm exec vitest run test/direct-edit-corpus`. A
refusal that is not in `../pins.ts` fails, which is the point: add the pin with
the literal message and the roadmap item that owns closing it.

Nothing is edited by hand after export. If a capture no longer reproduces, it
has been repaired — retire its pin, do not adjust the fixture.
