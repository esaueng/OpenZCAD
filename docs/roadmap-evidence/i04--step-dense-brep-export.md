---
row: I04
---

Dense-B-Rep STEP export (#2085): the STEP finisher and the inch unit
declaration found the next free entity id by spreading every id into
`Math.max`, and one call takes about 124,000 arguments on a main thread and
63,000 in a Chromium worker, where exports run. A file past that failed with
"Maximum call stack size exceeded" and no download: a 10,000-facet 3MF that
converts to a faceted solid (about 200,000 entities) beside two exact solids,
or a 4.75-turn sampled helical sweep (2,774 faces, about 67,000 entities).
Both now count in a loop and write every body.
`test/step-export-dense-mesh.test.ts` exports both fixtures through the
production adapter in millimetres and inches with unique entity ids and every
face present; `step-export-metadata.test.ts` and `export-units.test.ts` pin
300,000-entity files. Mesh references are unchanged: they still refuse by the
existing message (#2102, #2097).
