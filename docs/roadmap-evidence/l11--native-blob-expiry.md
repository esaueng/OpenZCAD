---
row: L11
---

Proposed follow-up to ADR-024 slice 8-C3: native blob streams have a five-second reaper independent of renderer commands. Unread streams expire after sixty seconds (within the next tick), dropping their bounded queues and aborting their pumps. The task retains only a weak reference across sleeps so native state teardown releases the table. Tokio's monotonic clock is used for both admission and expiry. Timer regressions cover an abandoned full queue, renewal by reads, a pending reader waking when its pump is aborted, and task termination after state release. Formatting and an independent read-only review pass; native compilation and execution are pending. The new `desktop-native.yml` PR check compiles and tests portable host logic on Linux with Rust 1.96.0; it does not exercise WKWebView, Keychain or macOS packaging. This evidence does not mark native expiry verified or the E2EE plan complete.
