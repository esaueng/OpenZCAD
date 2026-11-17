---
row: L08
---

Commenter links on end-to-end encrypted projects (plan decisions 2 and 3a, approved by the owner on 2026-11-17). Visitors of an encrypted link now comment like plaintext commenter-link visitors. Their comments are sealed in their browser, so the server stores ciphertext only.

When creating an encrypted link, the owner ticks "Visitors can comment". This signs a comment grant ("OZM", an owner-signed statement naming the project, link id and share-key hash). The Worker keeps the grant beside the link (migration 0061, `e2ee_share_comment_grants`) and stores it only from a device the owner's current device list certifies, and only for a live link. Per decision 3a it is not a third link-grant mode: the link stays `view`, and the encrypted document's link set is unchanged, so older builds still open the project.

The visitor's snapshot frame carries the grant. The visitor checks it against the owner devices its verified share delegation names; the server's word alone never opens the comment box. A comment is an unsigned `share-comment` project envelope (wire code 8) under a fresh key, wrapped with the link's share key (`share-comment-key`, bound to the comment id). The visitor reads and writes them through the token header at `/api/e2ee/share/comments`, at most 500 per link. The server checks only the envelope's kind and project.

Members open every commenter link's comments with the share keys they hold, after checking each grant against the owner's devices on their pinned list. The comments merge into the encrypted comment logs as "(via link)" threads and replies. Members reply to them; only the owner resolves or hides them, and hiding also deletes the comment from the link. Forgetting a link drops its grant and comments, and turning the project back into plaintext purges both tables.

Evidence:
- `packages/crypto` tests: comment grants (round trip, wrong link, unknown signer, forged signature, kept apart from link grants, canonical bytes) and wire codes 1–8.
- `test/e2ee-share-comments.test.ts`:
  - against the Worker, a link without a grant takes no comments;
  - a granted link's visitor posts a thread and a reply, which members read "(via link)";
  - the stored rows contain neither text nor name, and the link stays `view`;
  - an editor's grant and a grant for another share key are refused;
  - the owner hides a comment;
  - a malformed envelope gets 400;
  - a revoked link serves and takes nothing.
- The route inventory, the share-token mapping and the recovery tool's review of 0061.
- The CI smoke case `test/e2e/encrypted-link-comments.spec.ts`: the owner ticks the option, and a signed-out visitor signs and pins a comment. Only ciphertext and an `lcm_` id reach the account, and the owner's panel shows it "(via link)".
