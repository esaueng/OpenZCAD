---
row: L01
---

Account project creation, encrypted adoption and encryption migration accept
documents above 1.5 MB under the existing 24 MiB object-storage ceiling.
`cloudflare-adapters.test.ts`, `e2ee-encrypted-copies.test.ts` and
`e2ee-project-migration-engine.test.ts` verify round trips above the legacy
limit. The adapter still enforces the D1 ceiling when no object bucket is bound.
