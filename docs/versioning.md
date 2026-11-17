# App versioning

OpenZCAD has two version numbers, and the Settings page shows both under
**Advanced → About this build**:

|        | Example                       | Source                          | Advanced by                                     |
| ------ | ----------------------------- | ------------------------------- | ----------------------------------------------- |
| App    | `OpenZCAD 2026.1.0 · fdbb664` | root `package.json`             | a version PR in this repo                       |
| Kernel | `Remus 2026.1.134 · ae6a04b`  | the pinned `remus-wasm` package | the Remus repo (`update-remus.yml` pulls it in) |

They are independent: a kernel bump does not change the app version, and an
app release does not have to bump the kernel.

## Scheme

The app uses Remus's scheme, `YYYY.RELEASE.PATCH`, starting at `2026.1.0`.
All three fields are decimal integers without leading zeros, which makes the
number a valid npm, Cargo and macOS bundle version.

- `YYYY` is the year a release line was opened. It changes only when the
  maintainers deliberately open a new line (`--set 2027.1.0`), never
  automatically.
- `RELEASE` starts at 1 and increments for a planned release that adds
  features or changes a user-visible contract.
- `PATCH` starts at 0 for each release and increments for compatible fixes
  within it.

The pre-scheme number was `0.1.0` (tag `v0.1.0-alpha.1`); `2026.1.0` sorts
after it.

The version names a release line, not a build. `main` deploys to beta on
every merge and stable is promoted daily, so many builds share one version
between cuts. The source commit identifies the exact build, which is why
every place the version appears also carries the commit: the Settings row,
the crash report and page-load line (`OpenZCAD 2026.1.0 (fdbb66492abc) ·
Remus …`), and `build-meta.json`.

Document, settings and diagnostic schema versions are separate from the app
version; bumping one never implies the other.

## Where the version lives

`package.json` at the repository root is authoritative.
`scripts/app-version.mjs` keeps these copies in lockstep, because each tool
reads its own manifest:

- `apps/web/package.json` and `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json` (the macOS bundle version)
- `apps/desktop/src-tauri/Cargo.toml` and its `Cargo.lock` entry

Every Vite build (web and desktop) runs the same check and fails when a copy
disagrees, defines the version as `OZ_APP_VERSION` for
`apps/web/src/lib/appBuild.ts`, and stamps it into `build-meta.json` as
`version`. `pnpm build` then refuses build metadata without a well-formed
version. `test/app-version.test.ts` runs the lockstep check on every PR.

## Cutting a version

Bump in a standalone PR, so parallel PRs never race for the same number:

```bash
pnpm version:app                  # print the current version
pnpm version:app --bump patch     # 2026.1.0 -> 2026.1.1
pnpm version:app --bump release   # 2026.1.4 -> 2026.2.0
pnpm version:app --set 2027.1.0   # open a new year's line
pnpm version:app --check          # verify every copy agrees
```

The script rewrites only the version text in each file and refuses to move
the version backwards. Title the PR `chore(release): OpenZCAD <version>`.
Once it merges, beta reports the new version; stable reports it after the
next promotion ([release channels](release-channels.md)).
