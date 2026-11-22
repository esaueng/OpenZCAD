---
row: L08
---

Encrypted comment and related E2EE request readers enforce their existing
decoded-text or frame-byte ceilings while consuming the stream, before retaining
an oversized body. Cancellation and split UTF-8 controls are covered in
`test/request-body.test.ts`; full Worker visitor-path, visitor-header and owner
grant regressions, plus legitimate encrypted-comment controls, are in
`test/e2ee-share-comments.test.ts`. Existing limits, errors, encryption formats
and access checks are preserved.
