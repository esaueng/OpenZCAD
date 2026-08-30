import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import ts from 'typescript';

const PLACEHOLDER = /<YOUR_[A-Z0-9_]+>/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const D1_DATABASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
export const UPLOAD_CLEANUP_CRON = '17 * * * *';

export const REQUIRED_SECRETS = [
  'AUTH_OTP_PEPPER',
  'TURNSTILE_SECRET_KEY',
  'SETTINGS_ENCRYPTION_KEY',
  'AI_IDENTITY_PEPPER'
];

export const OFFICIAL = Object.freeze({
  repository: 'esaueng/OpenZCAD',
  workerName: 'openzcad',
  databaseBinding: 'DB',
  databaseName: 'openzcad-beta',
  databaseId: '7263c6f1-8781-40d1-a0fa-ea03ce874ef2',
  bucketBinding: 'ARTIFACTS',
  bucketName: 'openzcad-beta-artifacts',
  emailBinding: 'EMAIL',
  durableObjectBinding: 'PROJECT_ROOM',
  assetBinding: 'ASSETS',
  turnstileSiteKey: '0x4AAAAAAD_j6Y7NvXKtcxNX',
  publicOrigin: 'https://zcad.app',
  sender: 'noreply@zcad.esau.app'
});

function parseConfig(path) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }

  const parsed = ts.parseConfigFileTextToJson(path, source);
  if (parsed.error) {
    const message = ts.flattenDiagnosticMessageText(
      parsed.error.messageText,
      '\n'
    );
    throw new Error(`Cannot parse ${path}: ${message}`);
  }
  return parsed.config;
}

function findBindingEntries(config) {
  const entries = [];
  const add = (kind, binding) => {
    if (typeof binding === 'string' && binding.trim()) {
      entries.push({ kind, binding });
    }
  };

  add('assets', config.assets?.binding);
  for (const item of config.d1_databases ?? []) add('D1', item.binding);
  for (const item of config.r2_buckets ?? []) add('R2', item.binding);
  for (const item of config.kv_namespaces ?? []) add('KV', item.binding);
  for (const item of config.queues?.producers ?? []) {
    add('Queue producer', item.binding);
  }
  for (const item of config.services ?? []) add('service', item.binding);
  for (const item of config.vectorize ?? []) add('Vectorize', item.binding);
  for (const item of config.hyperdrive ?? []) add('Hyperdrive', item.binding);
  for (const item of config.analytics_engine_datasets ?? []) {
    add('Analytics Engine', item.binding);
  }
  for (const item of config.send_email ?? []) add('email', item.name);
  for (const item of config.durable_objects?.bindings ?? []) {
    add('Durable Object', item.name);
  }
  if (config.ai) add('Workers AI', config.ai.binding);
  return entries;
}

function duplicateBindings(config) {
  const byName = new Map();
  for (const entry of findBindingEntries(config)) {
    const existing = byName.get(entry.binding) ?? [];
    existing.push(entry.kind);
    byName.set(entry.binding, existing);
  }
  return [...byName].filter(([, kinds]) => kinds.length > 1);
}

function binding(config, collection, name, key = 'binding') {
  return (config[collection] ?? []).find((item) => item?.[key] === name);
}

function validateCommon(config, { allowPlaceholders }) {
  const errors = [];
  const serialized = JSON.stringify(config);

  if (!allowPlaceholders && PLACEHOLDER.test(serialized)) {
    errors.push('replace every <YOUR_...> placeholder');
  }
  if (!config.name || (!allowPlaceholders && !WORKER_NAME.test(config.name))) {
    errors.push(
      'name must be a 1-63 character lowercase Worker name using letters, numbers, and hyphens'
    );
  }
  if (!config.main) errors.push('main is required');
  if (!config.assets?.binding) errors.push('assets.binding is required');

  const db = binding(config, 'd1_databases', 'DB');
  if (!db?.database_name || !db?.database_id || !db?.migrations_dir) {
    errors.push(
      'D1 binding DB requires database_name, database_id, and migrations_dir'
    );
  }
  if (
    db?.database_id &&
    !allowPlaceholders &&
    !D1_DATABASE_ID.test(db.database_id)
  ) {
    errors.push('D1 binding DB has an invalid database_id');
  }
  const bucket = binding(config, 'r2_buckets', 'ARTIFACTS');
  if (!bucket?.bucket_name) {
    errors.push('R2 binding ARTIFACTS requires bucket_name');
  }
  const room = (config.durable_objects?.bindings ?? []).find(
    (item) => item?.name === 'PROJECT_ROOM'
  );
  if (room?.class_name !== 'ProjectCollaborationRoom') {
    errors.push(
      'Durable Object binding PROJECT_ROOM must use ProjectCollaborationRoom'
    );
  }
  const email = binding(config, 'send_email', 'EMAIL', 'name');
  if (!Array.isArray(email?.allowed_sender_addresses)) {
    errors.push('email binding EMAIL requires allowed_sender_addresses');
  }

  for (const key of [
    'ENVIRONMENT',
    'AUTH_MODE',
    'PRODUCTION_GUARD',
    'AUTH_EMAIL_FROM',
    'PROJECT_INVITATION_EMAIL_FROM',
    'PUBLIC_APP_ORIGIN',
    'TURNSTILE_SITE_KEY'
  ]) {
    if (!config.vars?.[key]) errors.push(`vars.${key} is required`);
  }
  if (config.vars?.ENVIRONMENT !== 'beta') {
    errors.push('vars.ENVIRONMENT must be beta for a hosted deployment');
  }
  if (config.vars?.AUTH_MODE !== 'email-code') {
    errors.push('vars.AUTH_MODE must be email-code for a hosted deployment');
  }
  if (config.vars?.PRODUCTION_GUARD !== 'enabled') {
    errors.push('vars.PRODUCTION_GUARD must be enabled');
  }

  for (const secret of REQUIRED_SECRETS) {
    if (Object.hasOwn(config.vars ?? {}, secret)) {
      errors.push(
        `vars.${secret} must not contain a secret; set it with wrangler secret put`
      );
    }
  }

  for (const [name, kinds] of duplicateBindings(config)) {
    errors.push(`binding ${name} is duplicated across ${kinds.join(', ')}`);
  }

  for (const route of config.routes ?? []) {
    const pattern = typeof route === 'string' ? route : route?.pattern;
    if (typeof pattern !== 'string' || !pattern.trim()) {
      errors.push('every route requires a non-empty pattern');
    } else if (pattern.includes('://')) {
      errors.push(`route ${pattern} must not include a URL scheme`);
    }
  }
  for (const cron of config.triggers?.crons ?? []) {
    if (typeof cron !== 'string' || cron.trim().split(/\s+/).length !== 5) {
      errors.push(`cron ${String(cron)} must contain five fields`);
    }
  }
  if (
    config.triggers?.crons?.length !== 1 ||
    config.triggers.crons[0] !== UPLOAD_CLEANUP_CRON
  ) {
    errors.push(
      `triggers.crons must contain only the upload cleanup schedule ${UPLOAD_CLEANUP_CRON}`
    );
  }

  return errors;
}

function officialOriginUrl(originUrl) {
  return /(?:github\.com[/:])esaueng\/OpenZCAD(?:\.git)?$/i.test(
    originUrl.trim()
  );
}

export function validateDeploymentConfig(
  config,
  { target, originUrl = '', environment = {} }
) {
  const allowPlaceholders = target === 'example';
  const errors = validateCommon(config, { allowPlaceholders });
  const db = binding(config, 'd1_databases', 'DB');
  const bucket = binding(config, 'r2_buckets', 'ARTIFACTS');
  const email = binding(config, 'send_email', 'EMAIL', 'name');
  const room = (config.durable_objects?.bindings ?? []).find(
    (item) => item?.name === 'PROJECT_ROOM'
  );

  if (target === 'official') {
    const checks = [
      [config.name, OFFICIAL.workerName, 'Worker name'],
      [config.assets?.binding, OFFICIAL.assetBinding, 'asset binding'],
      [db?.binding, OFFICIAL.databaseBinding, 'D1 binding'],
      [db?.database_name, OFFICIAL.databaseName, 'D1 database name'],
      [db?.database_id, OFFICIAL.databaseId, 'D1 database ID'],
      [bucket?.binding, OFFICIAL.bucketBinding, 'R2 binding'],
      [bucket?.bucket_name, OFFICIAL.bucketName, 'R2 bucket name'],
      [email?.name, OFFICIAL.emailBinding, 'email binding'],
      [room?.name, OFFICIAL.durableObjectBinding, 'Durable Object binding'],
      [
        config.vars?.TURNSTILE_SITE_KEY,
        OFFICIAL.turnstileSiteKey,
        'Turnstile site key'
      ],
      [config.vars?.PUBLIC_APP_ORIGIN, OFFICIAL.publicOrigin, 'public origin'],
      [config.vars?.AUTH_EMAIL_FROM, OFFICIAL.sender, 'authentication sender'],
      [
        config.vars?.PROJECT_INVITATION_EMAIL_FROM,
        OFFICIAL.sender,
        'invitation sender'
      ]
    ];
    for (const [actual, expected, label] of checks) {
      if (actual !== expected) {
        errors.push(`${label} changed from the official deployment value`);
      }
    }
    if (originUrl && !officialOriginUrl(originUrl)) {
      errors.push(
        `official deployment requires an esaueng/OpenZCAD origin; found ${originUrl}`
      );
    }
    if (
      environment.GITHUB_ACTIONS === 'true' &&
      environment.GITHUB_REPOSITORY !== OFFICIAL.repository
    ) {
      errors.push(
        `official deployment is not allowed from GitHub repository ${environment.GITHUB_REPOSITORY || '(unknown)'}`
      );
    }
    if (
      environment.GITHUB_ACTIONS === 'true' &&
      environment.GITHUB_REF !== 'refs/heads/main'
    ) {
      errors.push(
        `official deployment is not allowed from GitHub ref ${environment.GITHUB_REF || '(unknown)'}`
      );
    }
  } else if (target === 'selfhost') {
    if (!config.account_id || !ACCOUNT_ID.test(config.account_id)) {
      errors.push('self-hosting account_id must be a 32-character account ID');
    }
    const checks = [
      [config.name, OFFICIAL.workerName],
      [db?.database_name, OFFICIAL.databaseName],
      [db?.database_id, OFFICIAL.databaseId],
      [bucket?.bucket_name, OFFICIAL.bucketName],
      [config.vars?.TURNSTILE_SITE_KEY, OFFICIAL.turnstileSiteKey],
      [config.vars?.PUBLIC_APP_ORIGIN, OFFICIAL.publicOrigin],
      [config.vars?.AUTH_EMAIL_FROM, OFFICIAL.sender],
      [config.vars?.PROJECT_INVITATION_EMAIL_FROM, OFFICIAL.sender]
    ];
    for (const [actual, value] of checks) {
      if (actual === value) {
        errors.push(`self-hosting configuration still references ${value}`);
      }
    }
    for (const route of config.routes ?? []) {
      const pattern = typeof route === 'string' ? route : route?.pattern;
      if (/^(?:\*\.)?(?:zcad\.app|zcad\.esau\.app)(?:\/.*)?$/i.test(pattern)) {
        errors.push(`self-hosting configuration still references ${pattern}`);
      }
    }
  } else if (target === 'example') {
    if (!config.account_id) errors.push('example account_id is required');
  } else {
    errors.push(`unknown target ${target}`);
  }

  return errors;
}

function readOriginUrl() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1]?.endsWith('validate-deployment-config.mjs')) {
  const configPath = argument('--config');
  const target = argument('--target');
  if (!configPath || !target) {
    console.error(
      'Usage: node scripts/validate-deployment-config.mjs --config <path> --target <official|selfhost|example>'
    );
    process.exit(2);
  }

  try {
    const config = parseConfig(configPath);
    const errors = validateDeploymentConfig(config, {
      target,
      originUrl: readOriginUrl(),
      environment: process.env
    });
    if (errors.length) {
      for (const error of errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log(`${configPath} is valid for ${target} deployment.`);
    console.log(
      `Required Worker secrets: ${REQUIRED_SECRETS.join(', ')}. Verify them with wrangler secret list before deployment.`
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
