---
row: K07
---
2026-11-05 bounded qualification: [Remus #1542](https://github.com/esaueng/remus/pull/1542)
repairs a shared closed off-axis sphere/cylinder section and preserves closed
meshes after STEP healing coalesces its equator to one full circle. Paired
`2026.1.122` artifacts are pinned at immutable commit
`a16ca673cecd64772c2f71d615df3ed570527f67`; independent canonical builds match.
Native and fresh/installed-tarball qualification preserves both operand orders,
analytic carriers, strict validity, material/quantity oracles, input immutability
and raw mesh incidence/orientation at unchanged deflections. Consumer coverage
is `test/sphere-cylinder-union.test.ts` and the tagged
`test/e2e/sphere-cylinder-union.spec.ts`: exact Union, undo/redo, native project
reopening and downloaded STEP inspection. The original private input also
passes local full-render Union, undo/redo, downloaded project reopening, reload
and downloaded STEP validation; private inputs and evidence stay outside Git.
General curved boolean, tangency, sliver and scale families remain **Revalidate**.
This is local/PR qualification, not production deployment evidence.
