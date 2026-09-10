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

Preserve these architecture boundaries:

- The browser document and command history are canonical; viewport meshes are disposable projections.
- Exact geometry and file translation run in browser workers.
- Cloudflare handles orchestration, metadata, storage, and collaboration.
- Preserve units, tolerances, document compatibility, and fail-closed topology resolution.

The Remus dependencies are pinned to source commits. Kernel updates must include the corresponding lockfile changes and relevant geometry regression checks; do not weaken geometry assertions to accommodate a dependency update.

## Validation

Run the checks relevant to your change and report any checks you could not run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

For geometry changes, also consider `pnpm test:parity-corpus`; for interaction changes, exercise the affected browser workflow. Documentation-only changes should have valid links, accurate commands, and clean formatting. Required pull request checks still apply.

Do not include secrets, private models, or personal environment details in commits, logs, screenshots, or pull requests. Contributions are made under the repository's [Apache-2.0 license](LICENSE).
