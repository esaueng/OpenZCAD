---
row: A01
---
2026-11-05 WS3 refusal harvest: opt-in aggregate `kernel_refused` event whose bucket carries only the refusing operation, the kernel refusal family/operation/category/code, the warning kind and the target/neighbour surface types, each from a fixed vocabulary validated by the mirrored `glimpseContract.ts` in client and relay ([Kernel refusal harvest](docs/glimpse.md#kernel-refusal-harvest-ws3)). `analytics.test.ts` plants names, ids, hashes, dimensions and file names in every field and proves none reach the wire; `worker/glimpse.test.ts` proves the relay rejects non-canonical buckets and extra keys. The Glimpse service still has to mirror the vocabulary before it records the event.
