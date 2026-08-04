# ADR-003: Split Metadata And Project Objects

## Decision

D1 stores ownership, shelf metadata, optimistic-version fences, revision
pointers, logical-byte accounting, and R2 object metadata. Private R2 stores:

- immutable gzip-compressed project projections;
- content-addressed gzip-compressed STEP source and expanded mesh payloads;
- uploaded and generated artifacts.

The browser document and IndexedDB copy remain self-contained. The Cloudflare
persistence adapter removes only known imported STEP/mesh payloads from its R2
projection and restores them, with size and SHA-256 verification, before
`normalizeDocument` or the browser kernel sees the document. Existing D1-only
rows remain readable. When no usable R2 binding exists, the adapter retains the
legacy 1.5 MB D1 path rather than pretending a large save succeeded.

D1 migration `0011_r2_project_storage.sql` adds the pointers, compact summary
columns, document-object table, and project-asset table. The existing private
`ARTIFACTS` binding is used under a `project-storage/` namespace; an optional
`PROJECT_STORAGE` binding can move project objects to a dedicated bucket later
without changing stored keys or application behavior.

## Rationale

This keeps relational reads small, removes D1 row-size failures, deduplicates
the two canonical copies of each import payload (feature plus replay command),
and preserves deterministic offline/exact rebuild behavior. R2 is private and
strongly consistent, so D1 can atomically switch the current pointer only after
the immutable object exists.

## Failure and retention rules

- The R2 object is written before the D1 pointer changes.
- A failed optimistic-version fence deletes the uncommitted snapshot; imported
  assets stay content-addressed and can be reused by the retry.
- Autosave removes unreferenced prior document objects after the new pointer is
  committed. Explicit revision pointers protect retained history objects.
- Project deletion removes R2 objects before D1 metadata so a failed delete is
  visible and retryable.
- Checksums and project-scoped key validation fail closed on missing, corrupt,
  or cross-project object references.

## Rollout

Apply and verify migration 0011 and the private R2 binding before deploying the
Worker. `/api/health` reports `projectObjectStorageReady`; no migration or
deployment is performed by application startup.
