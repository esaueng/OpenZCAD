---
row: M04
---

Loft guide and connection refusals are now typed. A curved guide (`loft-guide:curved`), a guide that is not one curve of its sketch (`loft-guide:not-one-curve`), a guide that does not reach every section (`loft-guide:short`), and the kernel's refusal of a connection that misses a section vertex (`loft_connections_refused`) each arrive as a typed `modeling` refusal. Before, each was a plain build failure. A curved guide still has no exact construction on the pinned kernel, so it is refused by name and never faceted. The sentences are unchanged.

Evidence: `test/loft-connections.test.ts` asserts each refusal's `kernelRefusal` record.
