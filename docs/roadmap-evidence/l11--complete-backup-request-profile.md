---
row: L11
---

Complete-backup profiling found repeated device-directory reads within one encrypted verification and serialized cloud metadata waits. A head, historical save or replaced envelope now carries its current verified directory through authority/archive binding checks; head link checks use the same directory and revocation cutoffs. No directory result is cached across reads. Backup catalogs, measurements and workspace sessions read concurrently after the verified head, while whole-project staging stays sequential with the existing memory bounds and atomic ZIP commits. Regression coverage tightens the real shared-reader request budget and preserves later-read removal/fork refusal; deferred metadata gates and failed-batch coverage protect scheduling and completeness. The affected group, authority, project-info and sharing suites are included in CI (`test/e2ee-member-lists.test.ts`, `apps/web/src/lib/dataExport.test.ts`, `test/unit-ci-files.json`).
