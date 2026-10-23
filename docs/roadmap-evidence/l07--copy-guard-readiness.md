---
row: L07
---
The coincident-copy transition regression now waits for one rendered viewport
body and an enabled Move command, then explicitly checks the Move form before
using its Copy checkbox. Hosted main CI run
[39827590807](https://github.com/esaueng/OpenZCAD/actions/runs/39827590807/job/119994927732)
timed out waiting for that checkbox on all three attempts; the same main SHA's
[Jane shard passed](https://github.com/esaueng/OpenZCAD/actions/runs/39828277732/job/119997297733).
The unchanged scenario passed 30 local repetitions, including
the CI worker configuration and a temporary CPU-throttled diagnostic, so its
hosted failure's exact timing cause remains unconfirmed. With the explicit
readiness assertions, 20 no-retry CI-configured repetitions and all three copy
browser cases passed locally. The four Apply/Cancel transition checks and all
copy-state and body-count assertions remain intact, with unchanged deadlines
and retry configuration. The flaky-test budget and fleet rollout qualification
remain open.
