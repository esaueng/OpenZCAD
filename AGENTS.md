# OpenZCAD Agent Notes

## Environment
- Default branch is `beta`.
- Do not create production deploy targets or production domain config.
- Use `wrangler.jsonc` and beta-only Cloudflare resources.

## Engineering Rules
- Browser document/history model is the source of truth.
- Geometry kernel runs in browser workers only.
- Worker handles orchestration, metadata, storage coordination, and collaboration scaffolding.
- Keep package boundaries strict. Do not let viewport state leak into document or kernel packages.

## Delivery
- Commit on `beta` with descriptive messages.
- Push only to the current non-production branch when a remote exists.
- Final status reports must separate working features, stubs, risks, and next milestones.

