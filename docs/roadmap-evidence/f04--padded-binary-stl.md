---
row: F04
---

Correction (2026-11-12): the padded binary STL follow-up is fixed. Since #673
(`8752ae3f`) `parseStl` reads a file as binary whenever its declared triangle
count fits the buffer, before looking at header text, so a header that reads
like an ASCII `vertex` statement no longer routes it to the ASCII reader
(`test/io.test.ts`, "reads a padded binary STL whose header says … as
binary"). It no longer belongs in this row's remaining work.
