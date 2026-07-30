# Public repository cutover checklist

Publishing the existing private repository in place does not remove historical
objects already held by GitHub. Use a fresh public repository boundary so
former author identities and deleted machine-local paths are not carried into
the public object database.

## Prepare the release snapshot

- Merge the publication-remediation pull request into the private source
  repository.
- Re-run the full secret, PII, license, dependency, build, and test audit against
  the exact merge commit. Do not reuse object IDs or force-with-lease values
  from an earlier audit.
- Confirm `THIRD-PARTY-NOTICES.md`, all D1 migrations, and the current
  `wrangler.jsonc` are present in that snapshot.
- Export only the audited tree into a new repository with a new root commit.
  Do not push historical branches, tags, pull-request refs, notes, stashes, or
  backup refs.
- Keep the current private repository as the access-controlled history archive.

## Configure GitHub before visibility changes

- Set the repository description and CAD/STEP/WebAssembly/React topics.
- Protect `main`; require the public-runner CI workflow and review before merge.
- Review GitHub Actions fork-approval policy. The workflow uses read-only
  repository permissions and does not expose deployment secrets to fork pull
  requests.
- Disable unused features and verify no release assets, wiki pages, environment
  secrets, or branch refs were copied unintentionally.

## Configure the beta separately

- Apply every D1 migration, including `0007_ai_global_budget.sql`, before
  deploying Worker code that depends on it.
- Provision stable Worker secrets: authentication peppers, Turnstile secret,
  settings encryption key, `AI_IDENTITY_PEPPER`, the deployment AI email
  allowlist, and any provider key.
- Set provider-side billing limits independently of the in-app D1 budget.
- Verify Turnstile hostname/action validation, allowlisted and denied AI
  accounts, daily-budget exhaustion, personal provider credentials, login,
  project isolation, and collaboration against the intended beta host.

Repository publication, D1 migration, Worker deployment, and production-domain
changes are separate approvals. Do not combine them into one operation.
