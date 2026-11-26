# Contributing to OpenZCAD

For bugs and feature requests, use the [issue templates](https://github.com/esaueng/OpenZCAD/issues/new/choose). For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) before sharing details.

## Local development

Use Node.js 20.19+ on the 20.x line, or Node.js 22.12+, and pnpm 10. See the [README](README.md#quick-start) for setup and optional local configuration.

```bash
pnpm install --frozen-lockfile
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm dev:web
```

Keep credentials in ignored local configuration. Use synthetic or sanitized models in reports and tests; project backups can contain imported files and modeling history.

## Making changes

Create a branch in your fork and open a pull request against `main`. Explain the problem, the resulting behavior, and how you verified it. Discuss large changes in an issue first. Keep fixes focused and include regression coverage for bugs.

Title pull requests as [Conventional Commits](https://www.conventionalcommits.org/) (`feat(web): …`, `fix(kernel-adapter): …`, `docs: …`). Main merges through a squash-only merge queue, so the title becomes the commit, and its type decides the app version: each `feat`, `fix`, `perf` or `revert` merge adds one patch ([App versioning](docs/versioning.md)). Do not bump versions by hand.

Pick work from the [master roadmap](ROADMAP.md). Record an implementation's evidence as a fragment in [docs/roadmap-evidence/](docs/roadmap-evidence/README.md) instead of editing the roadmap row. A change that bumps `PROJECT_DOCUMENT_SCHEMA_VERSION` should state the version it builds on and the one it introduces; tests read the constant rather than a version literal.

Preserve these architecture boundaries:

- The browser document and command history are canonical; viewport meshes are disposable projections.
- Exact geometry and file translation run in browser workers.
- Cloudflare handles orchestration, metadata, storage, and collaboration.
- Preserve units, tolerances, document compatibility, and fail-closed topology resolution.

The Remus dependencies are pinned to source commits. Kernel updates must include the corresponding lockfile changes and relevant geometry regression checks; do not weaken geometry assertions to accommodate a dependency update.

## Validation

Run the checks relevant to your change and report any checks you could not run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:parity-corpus
pnpm build
pnpm test:e2e
```

The first five are the required `checks / validate` gate; CI also runs the tagged Playwright smoke suite. Use the top-level `pnpm build`, which adds the bundle-size check, rather than a filtered web build. Geometry and kernel changes need `pnpm test:parity-corpus`; for interaction changes, exercise the affected browser workflow. [Unit test suites](docs/unit-test-suites.md) and [Browser test suites](docs/browser-test-suites.md) explain how CI selects tests. Documentation-only changes should have valid links, accurate commands, and clean formatting. Required pull request checks still apply.

Do not include secrets, private models, or personal environment details in commits, logs, screenshots, or pull requests. Contributions are made under the repository's [Apache-2.0 license](LICENSE).
