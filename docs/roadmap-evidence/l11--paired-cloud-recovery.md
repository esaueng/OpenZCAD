---
row: L11
---
Paired D1/R2 recovery tooling inventories committed object references, checks stored and logical checksums, authenticates encrypted snapshot readback and refuses production/source restore targets. Disposable restore checks actual provider bindings, table contents, object bytes and HTTP/custom metadata. Operator setup, key custody, retention and application qualification boundaries are documented in `scripts/recovery/README.md`; regression coverage is in `test/recovery-snapshot.test.ts` and the Python recovery suite. No rollout flags or production deployment configuration changes.
