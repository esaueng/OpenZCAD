---
row: L11
---
ADR-024 Phase 8-C2 owner-device removal now refreshes share-authority statements
immediately after renewing the account delegation, using fresh project clients
bound to the post-removal account view. Owned projects continue independently
when another project is unavailable; unchanged server statements remain due for
ordinary upkeep after a failed refresh. Integration coverage verifies a link
whose statement the removed device signed becomes usable again without a
document save or sharing-dialog open. Production encryption remains off pending
outside review; this does not complete the remaining checkpoint, historical
authorization or legacy-reader work.
