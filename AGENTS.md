# OpenZCAD Agent Notes

## Environment
- Default branch is `main`.
- Do not create production deploy targets or production domain config.
- Use `wrangler.jsonc` and non-production Cloudflare resources.
- Never use `git stash` from a linked worktree. `refs/stash` lives in the
  common git dir and is shared by every worktree of this repo, so a `stash
  pop` in one worktree can take work stashed in another. Commit to the
  worktree's own branch instead — a throwaway commit is always recoverable,
  a popped stash from a sibling worktree is not.
- When bumping the `brepkit-wasm` pin, read the refresh commit's **message**
  for the sha it was BUILT from. Never infer it from the commit's position in
  history. The refresh job builds from its triggering commit and then rebases,
  so when two PRs merge close together the second refresh dies on a conflict in
  the generated package and main is left carrying a binary that is neither the
  newest nor the oldest thing beneath it. This has nearly shipped the wrong
  kernel twice, in opposite directions: once the stale refresh was *older* in
  history, once it was *newer* and sat directly on top of the fix it did not
  contain. If the refresh you need is missing, check
  `Release & Publish` for a failed "Refresh committed WASM package" job and
  re-run it by dispatching `publish.yml` on main with `sync_package=true`,
  which rebuilds from HEAD. Do not push to brepkit `main` to work around it.
- After bumping the pin, run BOTH `npx vitest run` and
  `pnpm test:parity-corpus`. The corpus alone is not the gate —
  `test/topology-lineage-spike.test.ts` has caught a bad pin the corpus could
  not see.
- `git log @{u}..` **errors** rather than reporting "nothing unpushed" when a
  branch has no remote-tracking ref, which is the normal state for a lane
  worktree. Before reclaiming any worktree's `target/`, compare its `HEAD`
  against `git ls-remote origin <branch>` instead; an error is not evidence
  that work is safely pushed.

## Engineering Rules
- Browser document/history model is the source of truth.
- Geometry kernel runs in browser workers only.
- Worker handles orchestration, metadata, storage coordination, and collaboration scaffolding.
- Keep package boundaries strict. Do not let viewport state leak into document or kernel packages.

## Delivery
- Commit on `main` with descriptive messages.
- Push to `main` when a remote exists.
- Final status reports must separate working features, stubs, risks, and next milestones.
