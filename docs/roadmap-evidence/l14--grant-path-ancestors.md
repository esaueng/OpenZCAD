---
row: L14
---

Grant hardening follow-up: `openzcad-mcp` now applies the strict-path rule to every folder from a granted file up to the filesystem root, at grant time and on every read and write. Each folder must be a plain folder (read with `lstat`, so a link is refused), owned by the user or root, and writable by no other account unless sticky. No other account can then rename a path component between the check and the no-follow open (the second independent review's ancestor-swap finding on #1622). Regression evidence: `test/agent-bridge.test.ts` (an ancestor folder opened to others refuses a new grant and an existing grant's next read; the sticky bit restores it; a link in the path is refused by the walk).
