import { readFileSync, appendFileSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedPaths } from './ci-selection.mjs';

export function selectDependencyAudits(paths, event) {
  if (!['pull_request', 'push'].includes(event) || !paths?.length)
    return { javascript: true, rust: true };
  const policy = paths.some(
    (path) =>
      path === '.github/workflows/dependency-audit.yml' ||
      path.startsWith('scripts/dependency-audit-selection.') ||
      path === 'scripts/install-cargo-audit.sh' ||
      path === 'test/ci-runtime-optimization.test.ts'
  );
  return {
    javascript:
      policy ||
      paths.some(
        (path) =>
          path === 'pnpm-lock.yaml' ||
          path === 'pnpm-workspace.yaml' ||
          /(^|\/)package\.json$/.test(path)
      ),
    rust:
      policy ||
      paths.some(
        (path) =>
          /^apps\/desktop\/(?:src-tauri|glib-regression|device-keys)\//.test(
            path
          ) ||
          /(^|\/)(?:Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?)$/.test(
            path
          ) ||
          path.startsWith('.cargo/')
      )
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  let plan = { javascript: true, rust: true };
  try {
    if (['pull_request', 'push'].includes(process.env.GITHUB_EVENT_NAME)) {
      const event = JSON.parse(
        readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')
      );
      const base = event.pull_request?.base.sha ?? event.before;
      plan = selectDependencyAudits(
        changedPaths(base),
        process.env.GITHUB_EVENT_NAME
      );
    }
  } catch {
    process.stderr.write(
      'Audit inputs unavailable; run both dependency audits.\n'
    );
  }
  const output = Object.entries(plan)
    .map(([name, enabled]) => `${name}=${enabled}\n`)
    .join('');
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
}
