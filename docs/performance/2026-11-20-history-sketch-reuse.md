# History sketch edit through a Boolean cut

The profile edits a plate upstream of a pocket cut with 30 independent boxes in the feature history. The width changes from 20 to 22, 23 and 24 mm. Apply previously submitted one worker request for validation and a second request to commit the checked geometry. The candidate submits one request per edit. Each of the 18 edits produced the expected downstream solid volume.

Times run from the Apply click through committed exact analysis. Each row contains three fresh Chromium runs per revision on a Ryzen 9 5900XT with ANGLE OpenGL. Run order was baseline/candidate, candidate/baseline, baseline/candidate. Other host verification jobs overlapped the comparison.

| Width | Solid volume | Baseline samples (ms) | Candidate samples (ms) | Median speedup |
| ----- | ------------ | --------------------- | ---------------------- | -------------- |
| 22 mm | 864 mm³      | 155.8, 147.8, 159.5   | 34.6, 30.8, 36.7       | 4.50×          |
| 23 mm | 904 mm³      | 112.6, 117.7, 113.0   | 40.6, 33.3, 28.0       | 3.39×          |
| 24 mm | 944 mm³      | 91.8, 101.4, 101.4    | 25.9, 26.8, 28.6       | 3.78×          |

The baseline uses the product code at `1e901d7d57c8cbb19480e32c48fe5ebf28f254b2`. Copy the candidate’s `test/e2e/upstream-sketch-edit.spec.ts` into that checkout and run the [same probe](../browser-test-suites.md) on both builds. The benchmark measures the checked history path. It does not time subsequent frame presentation or other sketch workflows.
