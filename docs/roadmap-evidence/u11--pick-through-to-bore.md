---
row: U11
---

A command waiting for a curved face (Thread and Gear teeth take a
cylinder, Wrap a cylinder or cone) now reaches one hidden behind the body
in front. Hover shows the nearest such face under the pointer through the
host, using the hover's existing x-ray pass, and a click takes it. A
bore's wall is picked through the stock's flat top, where the same click
with no command selects the top. A sketch region or curve in front is
still picked as itself, and Hole, which places itself at the click, never
picks through to a hidden flat face. Coverage: `inPlace/tools.test.ts`
and the Chromium smoke case "Thread takes a bore wall hidden behind the
host" in `test/e2e/in-place-thread.spec.ts`.
