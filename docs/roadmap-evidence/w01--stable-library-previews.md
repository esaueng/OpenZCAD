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
thumbnail continuity journey in `progressive-loading.spec.ts`). Target-hardware
median/p95 qualification remains open.
