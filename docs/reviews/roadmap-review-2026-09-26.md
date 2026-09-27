# Roadmap review: OpenZCAD and Remus, 26 September 2026

**What was reviewed.** OpenZCAD `ROADMAP.md` at `f396ed50` (branch of PR #452, which adds the reference-CAD rows) with its supporting plans, and the Remus master roadmap `docs/kernel-maturity/roadmap.md` at `origin/main` after #721, with the P-Class program, capability matrix, stability matrix and target documents.

**What was checked, not just read.** Every roadmap claim below was tested against something outside the roadmap: the merged-PR list of each repository (92 OpenZCAD PRs since the last reconciliation, 80 Remus PRs since its last priority review), the kernel pin in the lockfile, the schema constant, the existence of every file path a row cites, the state cell of every register row, and the WASM bindings the consumer rows describe. Nothing here is a judgement about code quality; it is about whether each roadmap still steers.

**Read this first.** Both roadmaps are unusually honest about evidence and unusually bad at staying small. Both are edited constantly (93 commits to the OpenZCAD file and 131 to the Remus file in two weeks) but the parts that decide what happens next were not re-derived from those edits. The result is two documents whose status cells are current and whose steering sentences are stale.

---

## 1. Verdict

|                   | OpenZCAD `ROADMAP.md`                                                                                                                                               | Remus master roadmap                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status accuracy   | Good. Rows are updated in the PR that changes them, cited tests exist (166 of 167 paths resolve), the pin and schema claims match the lockfile and the constant.    | Good on the registers; the capability matrix and the in-flight snapshot lag by weeks and say so only in one case.                                                  |
| Steering accuracy | **Stale.** The "next bounded picks" sentence names two items that were delivered on 17 September. The stated milestone order was not what the last two weeks built. | **Partially stale.** The priority lanes are still right for a correctness-first kernel, but the milestone every new consumer ask lands in (M7) appears in no lane. |
| Size and shape    | 11,100 words; one row holds 14,000 characters of changelog prose and 14 "(this PR)" placeholders.                                                                   | 43,800 words, 1,159 lines; 75 bridge rows of which 44 are individual defects filed since 21 September; a 111-package performance catalogue that is 2 percent done. |
| Gates             | Milestone 0 rows can never close as written (their remainders need private data or live credentials).                                                               | H4's "every unfinished bridge row is closed" gate recedes about two rows a day because the roadmap is also the bug tracker.                                        |
| Cross-repo        | The kernel lane (K01–K09) describes an older Remus; three rows are already delivered upstream.                                                                      | No crosswalk to the consumer's IDs; consumer asks arrive as ad-hoc rows.                                                                                           |

The single most useful change on each side is mechanical: re-derive the steering sentences from the registers, and separate the ledger of what happened from the list of what is next.

---

## 2. OpenZCAD `ROADMAP.md`

### 2.1 What works and should be kept

- The status vocabulary (Open, Partial, Revalidate, Deferred, Complete) is defined and used; no row claims delivery without a cited test or PR.
- The delivered-baseline table pins every claim to a test file. All but one of the 167 cited paths resolve; the one miss is `CommandPalette.test.tsx`, which U04 itself says became `CommandBar.test.tsx`.
- The header's pin claim (`cf411cd`, 2.130.51) matches `pnpm-lock.yaml`; the schema claim (v15) matches the constant, and `test/deploy-safety.test.ts` enforces that.
- The supporting-plans table gives every older plan an owner ID, which stopped the competing-queue problem the 12 September consolidation set out to fix.
- Refusing calendar estimates is the right call for a project shipped by agents and one maintainer.

### 2.2 Findings

**O1. The steering text is nine days behind the status text.** The "next bounded picks, in order" sentence still opens with H02's cold-edit measurement and H01's acceptance-gap inventory. Both were delivered on 17 September (#358, #360, and the H02 row's own text says the 18–31 s figure was not reproduced). Since that day 92 PRs merged. The milestone exit signals were last rewritten on 12 September. The roadmap is being maintained as a ledger and not re-read as a plan.

_Recommendation._ Add a dated "steering" block of at most five items that must be re-derived at every reconciliation, and make the reconciliation itself a row with a due trigger (for example "after every 25 merged PRs"). The last full reconciliation covered #316–#356; #357–#451 has not had one.

**O2. What was built is not what the delivery order says to build.** Categorising the 92 merged PRs since #357 by title: roughly 35 to 40 are workspace UI (the U04 quiet-stage slices and their follow-ups, #409–#450), about 16 are modeling or data features and fixes, 10 are tests only, 8 are docs or design, 8 are kernel pins or CI. Milestone 1 ("complete the modeling foundation") advanced through two features (#381 label placement, #383 residual feedback) and five design documents (#379, #380, #387, #388, #389, #391). Milestone 0's U04 row absorbed most of the capacity. That may be the right decision, but the roadmap says the opposite ("finish useful workflows before adding a second way") and never records the choice.

_Recommendation._ Either move U04's remaining slices out of milestone 0 into a named "workspace redesign" milestone with its own exit signal, or write one sentence in the delivery-order section saying the redesign was prioritised over milestone 1 for September and why. A roadmap that is overridden silently stops being trusted.

**O3. Rows are changelogs.** The U04 row is about 14,000 characters in one table cell, roughly 2,300 words. It contains 14 occurrences of "(this PR)" referring to at least eight different merged PRs, the sentence "All seven slices are in review" (all seven merged), a cited test that no longer exists, and entry-chunk byte counts from four different days. U02 (2,400 characters), L01 (2,600) and K05 (2,000) are heading the same way. The maintenance rule ("update this file in the implementation PR") is being followed by appending, so rows only grow.

_Recommendation._ Cap a row at its status, its remaining scope, its dependencies and at most three evidence links. Move delivery narrative to the PR body, which is where the rule already says detailed acceptance belongs. Replace every "(this PR)" with the PR number now; there are 14. Add a check to `deploy-safety.test.ts` that fails on the string "this PR" and on any backticked path that does not exist. Both checks are a few lines and would have caught all three defects above.

**O4. Status is inconsistent and "Partial" is doing too much work.** Seventy-six rows: 27 Open, 26 Partial, 13 Deferred, 9 Revalidate, 1 Complete. Three inconsistencies:

- A design document earns D01 a "Partial" while R01, S02 and S04, each also design-only, stay "Open". The rules say delivered means merged source with evidence; a design is not a delivery.
- Milestone 0's H01, H02, L01, U01 and U02 are Partial with remainders that need the private hammer fixture, live credentials or a second account. They cannot close on any PR, so milestone 0 cannot close on any PR.
- "Revalidate" has become a parking status. U03, K03, K06, K07, W02, W05, O01 and L07 have carried it since the 12 September consolidation with no revalidation recorded; F05 joined this week.

_Recommendation._ Split each milestone 0 row into a closed merged-scope row and one entry in a single "live acceptance ledger" row so the milestone can complete. Give Revalidate an expiry: a row in Revalidate for 30 days without a recorded attempt becomes Open or Deferred by rule. Keep design-only rows Open with a "design: done" note, including D01.

**O5. The kernel lane describes a Remus that no longer exists.** The K rows warn against trusting old kernel claims, and then do exactly that:

- K02 (cancellation and budgets) is "Open, inspect upstream first". Upstream P-Class 2.8 has had boolean and surface-surface-intersection cancellation callable from direct and batch WASM since August (Remus #138, #147, #160, #202). K02 is adapter and worker work now, not a kernel ask.
- K06 (trimmed edge domains, ordered wires, material sense, batched classification) is "Revalidate". Remus B16 delivered `trimmedEdgeDomain` and `unifyFacesChecked` and records that it closes only when the OpenZCAD adapter PR that deletes the repeated validation calls is linked. The remaining work is on this side.
- K03 (census CI, fuzz corpus, real-model coverage) is "Revalidate"; the Remus O1 register shows the gauntlet pipeline, manifests and CI wiring Complete with a nightly scoreboard. The consumer question is whether OpenZCAD fixtures are in that corpus, which is a different row.
- K05's remainder (unify-with-evolution, multi-operand booleans, edge and vertex provenance) is Remus B18, which landed pattern and offset history this week (#637, #682, #702). K05 still says "multi-operand booleans skip the probe" with no pointer to where that is being built.

There is no ID crosswalk in either direction. The Remus consolidation map mentions OpenZCAD zero times. Consumer asks reach the kernel as one-off rows (B16, B27, B28, B54, the 26 September overlay).

_Recommendation._ Re-derive K01–K09 and W01–W05 from the Remus registers in one PR, with a two-column crosswalk (OpenZCAD ID to Remus ID) kept in `docs/kernel-roadmap-remus.md` and referenced from both roadmaps. K02 and K06 should become "adopt" rows with the adapter file named.

**O6. Real risks with no owner row.**

- _Entry-chunk headroom._ U04's own text records the launcher chunk at 498,234 of 512,000 bytes, so 2.7 percent remains, and the row notes that the ⌘K palette had to leave its lazy chunk. Every new always-on control is now a budget negotiation, and nothing owns the budget.
- _Test-suite health._ 56 Playwright specs across six shards, two CI retries, a 180 s budget on the rounded-cylinder drags "at varying late steps on hosted CI" with the slowdown "not yet profiled", and a known pair of flaky specs. This is the gate every PR waits on and it has no row.
- _Release criteria._ The document says production acceptance is "recorded separately" and points at L01, which is a ledger of live checks. There is no row that says what beta must satisfy to become a release, so every milestone is open-ended.
- _Security._ #451 (project-boundary enforcement, three migrations) is recorded as one sentence inside L01. It deserves its own row because its migrations are deployment gates.
- _Assistant._ F03 (vocabulary) is the only assistant row; the assistant's console redesign, digest limits and preflight sharing are scattered across U04, L01 and U02.

_Recommendation._ Add four rows: performance budgets (entry chunk and kernel bytes, owned with the report script named), test-suite health (shard balance, retry policy, flaky-spec ledger), release readiness (an explicit list, even if short), and security posture. Keep each to three sentences.

**O7. Scope grew this week without a capacity statement.** The 26 September revision (mine) added 14 rows and widened milestone 1's exit signal from "S01–S06, R01, F01–F04" to "S01–S08, R01, F01–F05, U05–U07". That is the right inventory and the wrong milestone shape: milestone 1 is now larger than the sum of everything shipped since 12 September. Twenty-seven rows are Open. No row says what is deliberately not next.

_Recommendation._ Split U05–U07 into a milestone "1b, workspace conventions" that can run in parallel, and add a "parked until" list under the delivery order naming the rows that will not be picked before milestone 1's first three items close. A roadmap that only ranks is a backlog.

**O8. Governance mechanics.** Rule 4 is honoured in spirit but not in form: of the 93 commits that touched the roadmap since 13 September, 26 cite a PR number in their subject; 76 of the 92 merged PRs are not cited by number anywhere in the file. The execution guide (`docs/plans/roadmap-execution-agent-instructions.md`) still uses the legacy IDs (K-S5, P1-S1, P1-R1) in its playbooks, so an agent following it will look for rows that were renamed on 12 September. The agent guide's description of the CI jobs (quality, unit, validation) describes a layout `ci.yml` no longer has; it now delegates to a reusable fleet workflow.

_Recommendation._ One hygiene PR: renumber the execution guide's playbooks to master IDs, fix the CI job description, replace the placeholders, and add the two lint checks from O3.

### 2.3 Proposed steering block

A concrete proposal for the next-picks sentence, derived from the current statuses rather than the 17 September ones. It is a proposal; the choice is yours.

1. **S02 reference dimensions.** Design complete (#388); first row of milestone 1 with no kernel dependency.
2. **R01 offset plane and cylinder axis.** Design complete (#380); unblocks revolve about a model axis, mirror and circular patterns, which three M-rows and the reference-CAD comparison all wait on.
3. **F01 through-all.** Qualification complete (#389); the extrude extent the reference CAD ships by default.
4. **U05 keyboard and command contract.** App-only, cheap, and the largest single gap in the comparison.
5. **K-lane refresh.** The doc-only reconciliation in O5, so the next kernel adoption slice (K02 or K06) is chosen from current upstream state.

Parked until those close: further U04 slices, M-rows that depend on K05 or K08, and every Deferred row.

---

## 3. Remus master roadmap

### 3.1 What works and should be kept

- The register discipline is the best I have seen in an open kernel: every row carries a state word from a defined vocabulary, an evidence link, and the limitations in the same cell; "Implemented" explicitly does not promote a capability.
- Exit gates per P-Class issue, EXIT-B1–B5 as permanent integration scenarios, and the decisions table keep the roadmap from silently reopening closed questions.
- `scripts/check-doc-paths.sh` and `scripts/sync-roadmap-inventory.py --check` make the document partly self-verifying. The 24-hour correction of my own overlay (#720, #721 fixed two claims I had read from the native struct rather than the binding) shows the review culture works.
- Dated overlays (industrial parity, consumer) add scope without rewriting history.

### 3.2 Findings

**R1. The roadmap is also the bug tracker, and the release gate assumes it is not.** Both repositories have zero open GitHub issues. The bridge register has 75 rows; B32–B75 are 44 rows, 40 of them filed since 21 September from the B26 property campaign, the B19 mutation tranches and fuzz smoke, each an individual geometry defect (a specific box–cone placement, a specific torus notch). Twenty-four are Done and 19 Open. The H4 release gate says "every unfinished bridge row is closed or explicitly re-triaged". At the current filing rate that gate moves away faster than rows close. Meanwhile the original bridge rows (B1–B31, the cross-cutting program) are 13 Partial and 5 Open and get less attention because they share a table with forty defects.

_Recommendation._ Split the bridge register into a "bridge program" (B1–B31 plus B72–B75) and a "defect ledger" (B32–B71 and everything the campaigns file next), keep the B-numbering for links, and change the H4 gate to "zero open defect classes with a silent-wrong or crash outcome, and every program row closed or re-triaged". The defect ledger can be a generated table with class, oracle, state and PR, which is what those rows already are.

**R2. The document has outgrown its own consistency checks.** 1,159 lines and 43,800 words in one file, 131 commits in two weeks. Symptoms: the in-flight section is a self-described "historical snapshot from 2026-09-13" that is still the first thing after the priorities; the capability matrix, which the roadmap says "still governs qualification", describes PRs #210, #222, #226 and #228 as "in review" weeks after they merged; 21 occurrences of "this PR" remain on `main` (B16's own state cell begins "Partial (2026-09-16, this PR)"); 80 PRs merged since the 21 September priority review, and 65 are not cited by number, mostly because defect rows cite tests rather than PRs.

_Recommendation._ Keep the master roadmap as the index and move each register into its own generated or hand-maintained file per milestone (the P-Class and Open Kernel registers are already `<details>` blocks that want to be files). Add "this PR" to the doc-path check. Regenerate the capability matrix's PR references from the register, or delete the PR-state prose from the matrix and let the register own it.

**R3. M7 is unscheduled and now load-bearing.** M7 has six Pending rows and one Partial (7.5's curvature slice). No M7 item appears in the priorities table. Yet H5 requires 7.1 and 7.2 qualified; the P-Class program marks 7.4 "build first" as a 6.1 prerequisite (6.1 was merged for analytic cells without it); and the consumer overlay this week attached B73, Replace Face, sketch projection and the whole measure-depth ask to 7.4 and 7.5. The kernel already binds sweep corner and scale-law options and a section-face export that nobody has qualified, which is the cheapest possible M7 slice.

_Recommendation._ Name one bounded M7 slice in lane 4 or 5: qualify the already-bound `sweepWithOptions` corner and scale options with closed-form witnesses, then 7.4 curve projection on planar and cylindrical faces. Both are small and both unblock consumer rows.

**R4. The performance catalogue is a plan for a team that does not exist.** 111 packages: 100 Proposed, 9 Partial, 2 Done. The catalogue is generated (CSV and JSON) and internally consistent, but a 98-percent-unstarted inventory inside the master roadmap inflates the H6 gate ("large-model memory and tail-latency budgets enforced") and the document. The measured work that matters (O3.1a baseline, PERF-T01 savepoints, PERF-S01 sketch baseline, B28's NURBS chain) is a handful of rows.

_Recommendation._ Keep the measured baselines and at most ten selected packages in the roadmap; leave the rest in the generated catalogue with a one-line pointer. Nothing is lost; the inventory script already owns it.

**R5. The consumer is the last lane, and the consumer is the only user.** Lane 5 is "consumer and performance follow-through"; the public claim S6 is "someone else ships on it". OpenZCAD's product rows block on three kernel items: B18 (unify-with-evolution and edge/vertex provenance, behind K05, behind M02/M05/M07/I01/AS05), P-Class 2.8 adoption (behind K02), and 2.5 (NURBS × NURBS, the imported-body booleans a STEP-centric product lives on). B18 is moving well this week. 2.5 is Partial with deliberately narrow witnesses and sits in lane 4 as one of three items with no named next slice.

_Recommendation._ Add a two-column crosswalk (Remus ID to OpenZCAD ID) to the consolidation map so consumer dependencies are visible from the kernel side, and name 2.5's next bounded cell in lane 4 (a curved-NURBS-face cut against a plane is the smallest cell the consumer hits on every imported holder).

**R6. The gates have no burn-down.** H4 requires no unresolved Unsupported-untyped or Partial matrix cells, every bridge row closed, EXIT-B1–B5 passing, and S1–S7 evidenced. The roadmap states "no completion counts are asserted by this consolidation", which is honest, but it means nobody can tell from the document how far H4 is. Today: 18 Pending P-Class rows, 37 unfinished bridge rows, only EXIT-B5 has a stated owner state (2.6 Partial), and the S1–S7 claims have no per-claim status.

_Recommendation._ Put a generated count block under H4 (matrix cells by state, bridge rows by state, EXIT scenarios passing) and update it in the same script that checks the inventory. Prose gates without numbers cannot recede visibly.

**R7. Source citations in consumer-facing notes need enforcement, not good intentions.** My overlay stated that `sweepWithOptions` bound an auxiliary spine and that anisotropic scale converts every analytic carrier exactly. Both came from reading the native struct and the transform comment instead of the binding and the sphere branch; #720 and #721 corrected them within a day. The doc-path checker already verifies backticked paths exist; it does not verify that a claimed binding name exists.

_Recommendation._ Extend `check-doc-paths.sh` to verify backticked `camelCase` identifiers in the roadmap against `crates/wasm/src` exports, or require a `file:line` citation next to any binding claim in a scope note.

### 3.3 Proposed next five for Remus

Derived from the lanes and the consumer dependencies; a proposal only.

1. B18 edge and vertex history for booleans (the consumer's K05 remainder), continuing #682/#702.
2. 2.5's next named cell: curved-NURBS face against a plane, the imported-holder cut.
3. Qualification of the already-bound sweep corner and scale options (first M7 slice).
4. The register split from R1 and the "this PR" lint from R2, as one docs PR.
5. B16's remaining adapter-adoption evidence, which closes on an OpenZCAD PR and therefore doubles as the K06 refresh.

---

## 4. Cross-repository

- **Cadence mismatch.** OpenZCAD reconciles "against main at a SHA" and last did so on 17 September; Remus runs a "priority review" and last did so on 21 September with a full reconciliation frozen at 13 September. Neither document says when the next one is due. A shared trigger (every 25 merged PRs, or every kernel pin bump) would keep both steering blocks within a week of reality.
- **Pin cadence is fine.** OpenZCAD pins 2.130.51 (`cf411cd`); Remus refreshed committed packages to 2.130.55 on 26 September. One day of lag through the auto-opened pin PR is the design.
- **No shared crosswalk.** The only place the two ID spaces meet is the consumer kernel roadmap's C8 table in OpenZCAD and the 26 September overlay in Remus, both written this week. Maintain one crosswalk in one place and link it from both.
- **Both refuse estimates and both need a capacity sentence.** Not a date, a rate: how many bounded slices per week the two repos actually absorb (the last two weeks say roughly 40 to 45 merged PRs a week across both). Ranking without a rate is why milestone 1 could grow by 14 rows in a day.

---

## 5. Numbers behind the findings

| Measure                                         | OpenZCAD                                                   | Remus                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roadmap size                                    | 11,129 words, 76 rows                                      | 43,820 words, 1,159 lines; 58 P-Class, 58 Open Kernel, 75 bridge, 111 performance rows                                                                              |
| Commits touching the roadmap since 13 September | 93                                                         | 131                                                                                                                                                                 |
| Merged PRs since last reconciliation or review  | 92 (since #357)                                            | 80 (since 21 September)                                                                                                                                             |
| Of those not cited by number in the roadmap     | 76                                                         | 65                                                                                                                                                                  |
| Placeholder "this PR" occurrences               | 14                                                         | 21                                                                                                                                                                  |
| Cited file paths that do not exist              | 1 of 167                                                   | not measured (the repo has a checker)                                                                                                                               |
| Row status tally                                | Open 27, Partial 26, Deferred 13, Revalidate 9, Complete 1 | P-Class: Merged 15, Complete 3, Implemented 10, Partial 12, Pending 18. Bridge: Done 33, Partial 13, Open 24, other 5. Performance: Proposed 100, Partial 9, Done 2 |
| Largest single row                              | U04, about 14,000 characters                               | B16 and B4 state cells, several thousand characters each                                                                                                            |
| Open GitHub issues                              | 0                                                          | 0                                                                                                                                                                   |
| Kernel pin                                      | `cf411cd`, 2.130.51, matches lockfile                      | committed packages at 2.130.55                                                                                                                                      |

**Not verified.** No test suite or benchmark was run for this review; no live deployment was checked; the PR categorisation in O2 is by title keywords and is approximate to a few PRs either way. The "in flight" status of Remus PRs was taken from GitHub on the review date.
