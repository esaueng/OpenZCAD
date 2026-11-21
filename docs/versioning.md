# App versioning

OpenZCAD has two version numbers, and the Settings page shows both under
**Advanced → About this build**:

|        | Example                         | Source                            | Advanced by                                        |
| ------ | ------------------------------- | --------------------------------- | -------------------------------------------------- |
| App    | `OpenZCAD 2026.1.103 · cd5f152` | root `package.json` + git history | every user-facing merge; a version PR for the base |
| Kernel | `Remus 2026.1.134 · ae6a04b`    | the pinned `remus-wasm` package   | the Remus repo (`update-remus.yml` pulls it in)    |

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
- `PATCH` starts at 0 for each release and increments with every
  user-facing merge (see [Automatic patch numbers](#automatic-patch-numbers)).
  It is not committed: builds work it out from git history.

The pre-scheme number was `0.1.0` (tag `v0.1.0-alpha.1`); `2026.1.0` sorts
after it.

## Automatic patch numbers

`package.json` holds the base version. A build reports the base plus one
patch for every user-facing merge on `main`'s first-parent history since the
commit that set the base (`buildAppVersion` in `scripts/app-version.mjs`).
Squash merges carry their PR title, so the PR's Conventional Commits type
decides:

| Counts                                                                  | Does not count                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `feat`, `fix`, `perf`, `revert` (any scope, `!` included), `Revert "…"` | `docs`, `test`, `chore`, `ci`, `build`, `refactor`, `style`, untyped titles |

With base `2026.1.0` and 103 such merges since it was set, beta reports
`2026.1.103`. Each user-facing merge to `main` deploys a new number to beta
with no version PR and no extra CI; stable reports the number of the commit
it was promoted to. Builds of the same commit always agree, so the beta and
stable Workers and the desktop bundle's in-app label match. The desktop
bundle's own version (`tauri.conf.json`, `Cargo.toml`) keeps the base.

Commits that do not count still deploy, so builds can share a number; the
source commit identifies the exact build, which is why every place the
version appears also carries the commit: the Settings row, the crash report
and page-load line (`OpenZCAD 2026.1.103 (cd5f152fc5b4) · Remus …`), and
`build-meta.json`.

### History the build needs

Counting needs the history back to the base commit. CI checkouts and
Workers Builds clone shallowly, so a `vite build` deepens the clone (from
`origin`, falling back to the public GitHub URL) in doubling steps until it
reaches the base, and unshallows as a last resort. A dev or preview server
never fetches.

A build with `CI`, `WORKERS_CI` or `WORKERS_CI_COMMIT_SHA` set fails when
the history is still unavailable, instead of reporting the bare base as if
nothing had merged. Other builds, such as one from a source tarball without
`.git`, warn and report the base.

Print what a build of the current checkout will report:

```bash
pnpm version:app --build   # 2026.1.103 (base 2026.1.0 + 103 user-facing merges)
```

Document, settings and diagnostic schema versions are separate from the app
version; bumping one never implies the other.

## Where the version lives

`package.json` at the repository root holds the base version.
`scripts/app-version.mjs` keeps these copies in lockstep, because each tool
reads its own manifest:

- `apps/web/package.json` and `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json` (the macOS bundle version)
- `apps/desktop/src-tauri/Cargo.toml` and its `Cargo.lock` entry

Every Vite build (web and desktop) runs the same check and fails when a copy
disagrees, adds the merge count, defines the result as `OZ_APP_VERSION` for
`apps/web/src/lib/appBuild.ts`, and stamps it into `build-meta.json` as
`version`. `pnpm build` then refuses build metadata without a well-formed
version. `test/app-version.test.ts` runs the lockstep check on every PR.

## Cutting a release

Patch numbers need no PR. Open a new release line (or year) by moving the
base, in a standalone PR so parallel PRs never race for the same number:

```bash
pnpm version:app                  # print the base version
pnpm version:app --build          # print the version builds report
pnpm version:app --bump release   # 2026.1.103 -> 2026.2.0
pnpm version:app --set 2027.1.0   # open a new year's line
pnpm version:app --check          # verify every copy agrees
```

`--bump` and `--set` start from the reported version, not the stale base, and
refuse to move backwards; `--bump patch` (2026.1.103 -> 2026.1.104) also
resyncs the desktop bundle's version without a new release. The script
rewrites only the version text in each file. Title the PR
`chore(release): OpenZCAD <version>`: `chore` keeps the bump itself out of
the count, and the count restarts from its merge. Once it merges, beta
reports the new version; stable reports it after the next promotion
([release channels](release-channels.md)).
