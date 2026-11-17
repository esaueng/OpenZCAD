---
row: L08
state: Complete
---

All L08 slices are on main, each safe under end-to-end encryption (ADR-024, L11) by the owner's decisions in docs/plans/l08-l03-review-and-versions-plan.md (#1667):
- comments pinned to the model for plaintext projects, for every member role (#1671);
- commenter share links whose visitors sign comments (#1689);
- encrypted comments as one signed, encrypted log per member (#1690);
- drawing sheets chosen per sheet on share links, read only with a PDF download (#1670);
- a confirmation that names the count before encrypting deletes a project's plaintext comments (#1708);
- commenter links on encrypted projects: an owner-signed comment grant beside the link, and visitors' comments encrypted under the link's share key (#1716).

Each slice's CI smoke spec is named in its evidence above.
