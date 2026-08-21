import { execFileSync } from 'node:child_process';
import process from 'node:process';

const DEFAULT_ORIGIN = 'https://zcad.app';
const DEFAULT_ATTEMPTS = 18;
const DEFAULT_DELAY_MS = 5_000;

export const REQUIRED_BETA_HEALTH = Object.freeze({
  status: 'ok',
  environment: 'beta',
  documentStorageAccountingReady: true,
  projectObjectStorageReady: true,
  projectMeasurementStorageReady: true,
  accountErasureReady: true,
  projectErasureReady: true,
  projectMeasurementSyncEnabled: true
});

function currentCommit() {
  const supplied =
    process.env.OPENZCAD_BUILD_COMMIT ??
    process.env.GITHUB_SHA ??
    process.env.WORKERS_CI_COMMIT_SHA;
  if (supplied?.trim()) return supplied.trim();
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}.`);
  }
  return parsed;
}

export function betaDeploymentErrors({ health, metadata, expectedCommit }) {
  const errors = [];
  for (const [field, expected] of Object.entries(REQUIRED_BETA_HEALTH)) {
    if (health?.[field] !== expected) {
      errors.push(`health.${field} must be ${JSON.stringify(expected)}`);
    }
  }
  if (metadata?.format !== 'openzcad-build-metadata') {
    errors.push('build metadata format is invalid');
  }
  if (metadata?.commit !== expectedCommit) {
    errors.push(
      `build metadata commit ${metadata?.commit ?? '(missing)'} does not match ${expectedCommit}`
    );
  }
  return errors;
}

async function jsonResponse(fetchImpl, url) {
  const response = await fetchImpl(url, {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store'
    }
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function verifyBetaDeployment(options = {}) {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const expectedCommit = options.expectedCommit ?? currentCommit();
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const logger = options.logger ?? console;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const cacheBust = `${Date.now()}-${attempt}`;
      const healthUrl = new URL(`/api/health?cb=${cacheBust}`, origin);
      const metadataUrl = new URL(`/build-meta.json?cb=${cacheBust}`, origin);
      const [health, metadata] = await Promise.all([
        jsonResponse(fetchImpl, healthUrl),
        jsonResponse(fetchImpl, metadataUrl)
      ]);
      const errors = betaDeploymentErrors({
        health,
        metadata,
        expectedCommit
      });
      if (errors.length > 0) throw new Error(errors.join('; '));
      logger.log(
        `Verified ${origin}: commit ${expectedCommit} and every beta readiness gate are live.`
      );
      return { health, metadata };
    } catch (error) {
      lastError = error;
      logger.warn(
        `Beta verification attempt ${attempt}/${attempts} failed: ${error.message}`
      );
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(
    `Beta deployment did not become ready: ${lastError?.message ?? 'unknown error'}`
  );
}

if (process.argv[1]?.endsWith('verify-beta-deployment.mjs')) {
  const attempts = positiveInteger(
    process.env.OPENZCAD_VERIFY_ATTEMPTS,
    DEFAULT_ATTEMPTS
  );
  const delayMs = positiveInteger(
    process.env.OPENZCAD_VERIFY_DELAY_MS,
    DEFAULT_DELAY_MS
  );
  try {
    await verifyBetaDeployment({
      origin: process.env.OPENZCAD_BETA_ORIGIN ?? DEFAULT_ORIGIN,
      expectedCommit: currentCommit(),
      attempts,
      delayMs
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
