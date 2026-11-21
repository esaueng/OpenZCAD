---
row: W01
---

Opening a saved model now starts its first geometry rebuild during the project switch so the worker can build while the viewport initializes. Full-render Chromium on an RTX 3090 measured six fresh library opens per build and plate size against parent `c0c784625`. Median click to first frame showing the model fell from 546 to 515 ms for 12 holes, 822 to 639 ms for 32 holes and 1,419 to 1,210 ms for 100 holes. Both builds used the released kernel. All 36 opens sent one live rebuild, and opening and edited geometry matched across builds. The first viewport frame, which can still be empty, took 42 ms longer on the 32-hole candidate and 28 ms longer on the 100-hole candidate. The CI smoke case in [new-project-startup.spec.ts](test/e2e/new-project-startup.spec.ts) checks that opening an owned project submits one rebuild with its persistence policy before viewport initialization.
