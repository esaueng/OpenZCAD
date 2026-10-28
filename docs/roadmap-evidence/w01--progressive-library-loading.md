---
row: W01
---
Library startup publishes existing device summaries while account discovery
continues, then returns the cloud listing before encrypted card metadata has
finished. Names and thumbnail references still pass the existing signature,
epoch, authority and rollback checks, with four verifications in flight and
session-scoped, batched presentation updates. Health, authentication config,
settings, collaboration config and speculative chunk prefetch no longer block
the initial library. Selecting a project immediately shows its named loading
screen with cancellation; document reconciliation still precedes hydration,
and the file count loads afterward. Regression coverage includes 150 encrypted
cards, delayed optional services, cached rows, rejected/stale metadata, local
settings changed during discovery, cancellation and superseded navigation
(`progressive-loading.spec.ts`, `apiProjectListing.test.ts`,
`progressiveShelf.test.ts`, `projectShelf.test.ts`). Original-account production
timing and target-hardware median/p95 qualification remain open.
