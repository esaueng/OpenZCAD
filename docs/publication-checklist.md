# Public repository cutover checklist

Publishing the existing private repository in place preserves issues, pull
requests, releases, tags, Actions configuration, and production integrations.
Prefer that path when the final full-history secret scan is clean. Author and
committer attribution is public Git metadata and is not, by itself, a reason to
discard project history.

## Prepare the release snapshot

- Merge the publication-remediation pull request into the private source
  repository.
- Re-run the full secret, PII, license, dependency, build, and test audit against
  the exact merge commit. Do not reuse object IDs or force-with-lease values
  from an earlier audit.
- Confirm `THIRD-PARTY-NOTICES.md`, all D1 migrations, and the current
  `wrangler.jsonc` are present in that snapshot.
- Review every unmerged branch and delete or retain it intentionally before
  publication. A clean default branch does not make branch-only history safe.
- If a confirmed credential or private-data object is found, pause publication
  and choose between a coordinated history rewrite and a fresh public
  repository. Rotate the affected credential before either option.

## Configure GitHub before visibility changes

- Set the repository description and CAD/STEP/WebAssembly/React topics.
- Protect `main`; require the public-runner CI workflow and review before merge.
- Review GitHub Actions fork-approval policy. The workflow uses read-only
  repository permissions and does not expose deployment secrets to fork pull
  requests.
- Disable unused features and verify release assets, wiki content, Pages,
  packages, Actions artifacts, repository variables/secrets, environments,
  deploy keys, webhooks, and branch refs intentionally belong in public view.
- Re-check the fork pull-request approval policy after visibility changes; that
  setting is unavailable while the repository is private.

## Configure the beta separately

- Apply every tracked D1 migration before deploying Worker code that depends on
  it.
- Provision stable Worker secrets: authentication peppers, Turnstile secret,
  settings encryption key, and `AI_IDENTITY_PEPPER`. These four are the ones a
  deploy refuses to publish without.
- Funding AI from the deployment is opt-in and needs two further secrets, the
  provider key and `AI_DEPLOYMENT_ALLOWED_EMAILS`. Neither blocks a deploy:
  with the allowlist unset no account can spend the deployment key, and the
  assistant runs on personal provider tokens alone.
- Set provider-side billing limits independently of the in-app D1 budget.
- Verify Turnstile hostname/action validation, allowlisted and denied AI
  accounts, daily-budget exhaustion, personal provider credentials, login,
  project isolation, and collaboration against the intended beta host.

Repository publication, D1 migration, Worker deployment, and production-domain
changes are separate approvals. Do not combine them into one operation.
