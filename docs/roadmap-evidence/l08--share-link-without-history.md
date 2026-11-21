---
row: L08
---

Share links without history. When creating a link the owner may untick
"Include history" (ticked by default; existing links are unchanged). Such a
link serves the finished model only: the owner's browser writes each shown
body on its own as STEP, the kernel's exact exchange form, and builds a new
document holding one imported solid per body (`frozenShareDocument`), with
the project's name and units and each body's name, chosen colour and
opacity. No feature, sketch, parameter, save state, command log or import
source of the project is in it, so none is sent. The link is view only
(Tweak is disabled, comments stay available), is fixed when made, and the
owner's list marks it "No history" with an Update action that freezes the
current model into the same link and URL. Make a copy gives the visitor the
imported solids as an ordinary project. A visitor is told "The owner shared
it without its history" in the status line, the Shared chip and the Tweak
tab's reason. Plaintext links (migration 0062, additive:
`project_share_links.history`, `frozen_document`, `frozen_at`): the Worker
stores the frozen document on the link row (gzip, base64, at most 1.9 MB
stored), serves only it and never reads the project's document for such a
link, serves no asset or import source through it, and accepts a document
only if `frozenShareDocumentProblem` passes (an allowlist: imported-solid
features with embedded STEP and nothing else), on create, on Update and
again on every read. Encrypted links (ADR-024): a third owner-signed grant
mode, `frozen` (wire code 3), so every member's browser learns it with the
link and a build from before it refuses the link set instead of
republishing the project into the link; publishers seal the frozen model
given at create or Update, and on later republications (a new statement or
key epoch) read the link's own stored snapshot back with the share key,
check a current author signed it and that it passes the same allowlist, and
seal that again; with neither the link stays unpublished ("Needs an
update"). The visitor's browser refuses a `frozen` link whose snapshot
holds more than the frozen solids. The server keeps the mode column's
values and marks the row `history = 0` (migration 0063, additive:
`e2ee_share_links.history`). A plaintext link without history is
not offered again as an encrypted link when its project is encrypted.
Evidence: `packages/document-core/src/frozen-share.test.ts` (the builder,
the allowlist, a copy), `test/share-link-without-history.test.ts` (D1 and
in memory, and the routes: only the frozen solids served, the project
refused as a model, Update, revoke clears the model, no asset or source,
existing links unchanged), `test/e2ee-share-links-without-history.test.ts`
(real client, Worker and SQLite: the visitor's document, the owner's and an
editor's saves leave the model, forced republication, Update, reissue, a
visitor refusing a snapshot that holds the project),
`apps/web/src/lib/frozenShareModel.test.ts`, `ProjectSharingDialog.test.tsx`,
`EncryptedShareLinks.test.tsx`, `projectShareClient.test.ts`, and the CI
smoke case `test/e2e/share-link-without-history.spec.ts` (a visitor opens
the frozen model, asks for no source, and copies only the solid).
