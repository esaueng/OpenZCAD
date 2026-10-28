---
row: W01
---
Library refresh preserves cached project names and card order while encrypted
metadata is unverified, without changing transport versions, storage formats,
organization precedence or late-verification conflict fences. Thumbnails keep
their decoded image during refresh and on returning to the library, switch
only after the replacement decodes, and retain visibility-based loading. The
bounded memory cache scopes protected previews to the account and key session;
account changes, key teardown and unsupported formats cannot reuse protected
images or accept late results. Regression coverage exercises provisional
listings, verified renames, decode failures, empty projects, stale requests,
remounts and session invalidation (`PartThumbnail.test.tsx`,
`apiProjectListing.test.ts`, `projectShelf.test.ts`, and the smoke-tagged
thumbnail continuity journey in `progressive-loading.spec.ts`). Previously
verified cloud-only titles are cached as account-scoped device presentation
hints, like local document summaries, and appear with the HTTP listing while
encrypted metadata is still pending. Pinned and visible cards are verified
first; current signatures, authority, rollback checks and document loads remain
authoritative. Name hints never change versions, thumbnail references or
permissions, and clear at sign-out. Coverage includes 150 cached titles while
the encryption account request is held, cache isolation, unavailable storage
and newer device renames (`projectShelfNames.test.ts`). Target-hardware
median/p95 qualification remains open.
