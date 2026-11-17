---
row: M17
state: Complete
---

Slice 4 is the simplified thread display (schema v83, up from v81, with v82 claimed by D02 #1662).

A screw, nut or threaded insert may store `thread: 'simplified'`, and the Standard part tool's Thread option makes Simplified the default. A simplified part is its plain envelope: the head's form, every size and its length are the modeled part's, but no thread is cut and there is no drive recess, chamfer or knurl. The uncut face is named `standard-part.face.thread`. A socket screw is then one revolve of 5 faces and 6 edges, where the modeled screw has about 465,600 display triangles. It refuses the lengths a modeled screw refuses, and switching back to Modeled clears the field. A standard part on a plane reads no other body, so the history cache's primitive reuse now restores it, derived lengths included, across an unrelated edit. A part in a hole is still rebuilt.

Measured on the Active 1 machine with 100 ISO M6 × 20 screws on a quiet host ([record](docs/performance/2026-11-16-m17-fasteners.md)):

- **W01**, editing a box before them: Apply → frame **142.7 ms median and 163.5 ms p95**, against the 150/170 ms budget for a 100-feature history. 100 boxes measure 130.4/150.6 ms on the same build.
- **H02**, the first edit after a settled reload: **164 ms**, against 400/850 ms. Reload → exact ready is 1.36 s, against 0.69 s for the boxes.

Modeled, ten screws are 4.66 M triangles and 17 s to build cold. Evidence:

- `test/standard-parts-threads.test.ts`:
  - the v83 gate, refusals, and the clear;
  - the socket, hex and countersunk envelopes and the nut to their closed-form volumes;
  - matching refusals, and fewer triangles than modeled;
  - reuse through an unrelated edit with derived lengths kept, and a rebuild when a parameter the parts read changes.
- `apps/web/src/lib/inPlace/standardPart.test.ts`, covering the option, storage and reopen.
- The probes `test/perf/standard-parts-display.bench.ts` and `test/e2e/perf-cad-edit.spec.ts` (`CAD_PERF_BROWSER_FASTENERS`).
- `test/e2e/standard-parts-threads.spec.ts`. It picks a block's top face with Standard part, chooses an ISO M6 socket screw with Thread: Simplified, drags its length arrow, and checks the stored `thread: 'simplified'`. It also checks that the viewport draws the screw in under 10,000 triangles. `test/e2e/standard-parts.spec.ts` now chooses Modeled, so the cut thread keeps its own pick-and-drag spec.

With this slice M17's contract is met on main: ISO and ANSI screws, nuts, washers, threaded inserts, dowel pins and bearings generated from the M15 thread and M14 gear engines (#1623), inserted into M01 holes with matched size and length (#1644), listed in the AS03 BOM by designation (#1660), and drawn simplified within the H02/W01 budgets (#1666).
