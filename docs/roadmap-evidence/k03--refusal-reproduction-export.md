---
row: K03
---
2026-11-05 WS3 consumer repros: **Save reproduction** beside a refusal's View details downloads a sanitized `openzcad-direct-edit-fixture` (format 2, new `feature-build` op) for any refused feature build, booleans included: history up to the refused feature, kernel pin and refusal record, with names neutralised and user/project ids, later features and the command log stripped. `test/direct-edit-corpus/replay.ts` replays it through the shipped feature gate; `test/refusal-reproduction.test.ts` proves the sphere-boss direct resize and a refused identical-solid cut reproduce the same sentence and kernel classification after a JSON round trip. The project diagnostic sanitizer now keeps feature suppression flags, which a rebuild reads.
