# Browser test suites

Regular CI runs a focused **smoke suite**, selected by the `@ci-smoke` tag.
This intentionally trades the extended regression matrix for a faster check:
startup and sign-in, desktop and phone entry, create/edit/cancel/undo, a few
representative exact operations, import/export, save/reload, cloud sync and
encrypted sharing. Assertions within those journeys remain unchanged.

The full suite still contains the detailed geometry, interaction races,
breakpoint/theme combinations and historical regressions. It is not run on
ordinary PRs. An untagged new regression is therefore full-suite coverage only.
Tag a representative user journey when adding a major capability; keep the
smoke suite small instead of tagging every variant.

## Running a suite

- `pnpm test:e2e`: full suite locally; smoke suite when `CI` is set.
- `OPENZCAD_E2E_SUITE=smoke pnpm test:e2e`: smoke suite locally.
- `pnpm test:e2e:full`: explicitly full, including when `CI` is set.
- `OPENZCAD_E2E_SUITE=full`: opt a sharded CI/manual run into the full suite.

Performance probes and documentation captures (`OZ_PERF`, `OZ_CAPTURE`,
`H02_SESSION_PROBE=1`) keep their full selection by default, so a focused
untagged probe is not filtered away. Unknown suite names fail immediately.
Both suites retain the existing timeouts, retries and two-worker CI budget.

## Sharding and timing

Both suites use the existing six shards and required E2E completion gate.
The immutable fleet workflow and its runner restrictions are unchanged.
The sharder selects files containing the smoke tag, and Playwright selects
tagged cases within those files. An empty shard fails rather than publishing
an empty success. Merge candidates still run no browser shards.

Full measurements live in `test/e2e/shard-weights.json`; smoke measurements
live in `test/e2e/smoke-shard-weights.json`. Initial smoke weights sum the
selected cases from a successful hosted full-suite run. Refresh them from
completed reports:

```bash
node scripts/e2e-shards.mjs --suite smoke --update /path/to/e2e-report-*.json
node scripts/e2e-shards.mjs --suite full --update /path/to/full-report-*.json
```

Reports name their suite in `config.metadata.e2eSuite`. Updating weights from
the other suite is refused, so short smoke timings cannot corrupt the full
suite's balancing. Older reports without suite metadata count as full runs.
