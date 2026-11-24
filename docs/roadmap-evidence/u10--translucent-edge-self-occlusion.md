---
row: U10
---

A translucent body's own back and inner-wall edges recede behind its glass instead of doubling its outline: a per-frame depth-and-owner prepass of the translucent bodies' faces (`packages/viewport/src/render/translucentEdges.ts`), drawn only while a body is translucent, splits each translucent body's resting edge ink so fragments behind that body's own nearest face draw in a faint twin at the x-ray hidden-edge strength; the main depth buffer, opaque bodies, other bodies' edges, highlights and X-ray are unchanged (`translucentEdges.test.ts`; headless-Chromium before/after of a hollow housing around an opaque core in PR). Closes #2018.
