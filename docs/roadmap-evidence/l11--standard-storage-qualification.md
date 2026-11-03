---
row: L11
---

Disposable recovery qualification writes Standard storage explicitly in both
the client and ingress, including copies of InfrequentAccess source metadata.
Readback refuses any other target storage class before downloading the body;
authenticated backup metadata retains the source class. Local regressions cover
both source classes, target-class refusal, create-only writes and unchanged
HTTP/custom metadata. Live qualification fixtures use Standard; storage-class
variants remain local mocks to avoid Infrequent Access billing minimums.
