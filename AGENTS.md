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

## Engineering Rules
- Browser document/history model is the source of truth.
- Geometry kernel runs in browser workers only.
- Worker handles orchestration, metadata, storage coordination, and collaboration scaffolding.
- Keep package boundaries strict. Do not let viewport state leak into document or kernel packages.

## Delivery
- Commit on `main` with descriptive messages.
- Push to `main` when a remote exists.
- Final status reports must separate working features, stubs, risks, and next milestones.
