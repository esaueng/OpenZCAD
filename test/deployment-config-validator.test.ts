import { describe, expect, it } from 'vitest';
import {
  OFFICIAL,
  validateDeploymentConfig
} from '../scripts/validate-deployment-config.mjs';

function hostedConfig() {
  return {
    account_id: '11111111111111111111111111111111',
    name: 'independent-openzcad',
    main: './apps/web/worker/index.ts',
    assets: { binding: 'ASSETS' },
    triggers: { crons: ['17 * * * *'] },
    vars: {
      ENVIRONMENT: 'beta',
      AUTH_MODE: 'email-code',
      PRODUCTION_GUARD: 'enabled',
      AUTH_EMAIL_FROM: 'noreply@example.test',
      PROJECT_INVITATION_EMAIL_FROM: 'noreply@example.test',
      PUBLIC_APP_ORIGIN: 'https://cad.example.test',
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA'
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'independent-openzcad-db',
        database_id: '11111111-1111-4111-8111-111111111111',
        migrations_dir: 'apps/web/migrations'
      }
    ],
    r2_buckets: [
      { binding: 'ARTIFACTS', bucket_name: 'independent-openzcad-artifacts' }
    ],
    send_email: [
      {
        name: 'EMAIL',
        allowed_sender_addresses: ['noreply@example.test']
      }
    ],
    durable_objects: {
      bindings: [
        { name: 'PROJECT_ROOM', class_name: 'ProjectCollaborationRoom' }
      ]
    }
  };
}

describe('deployment configuration preflight', () => {
  it('accepts an independent self-hosting configuration', () => {
    expect(
      validateDeploymentConfig(hostedConfig(), {
        target: 'selfhost'
      })
    ).toEqual([]);
  });

  it('rejects unresolved placeholders and official resources for self-hosting', () => {
    const config = hostedConfig();
    config.name = OFFICIAL.workerName;
    config.d1_databases[0]!.database_id = '<YOUR_D1_DATABASE_ID>';
    config.r2_buckets[0]!.bucket_name = OFFICIAL.bucketName;

    const errors = validateDeploymentConfig(config, { target: 'selfhost' });

    expect(errors).toContain('replace every <YOUR_...> placeholder');
    expect(errors).toContain(
      `self-hosting configuration still references ${OFFICIAL.workerName}`
    );
    expect(errors).toContain(
      `self-hosting configuration still references ${OFFICIAL.bucketName}`
    );
  });

  it('rejects duplicate bindings and committed secret values', () => {
    const config = hostedConfig();
    config.assets.binding = 'DB';
    Object.assign(config.vars, { AUTH_OTP_PEPPER: 'must-not-be-here' });

    const errors = validateDeploymentConfig(config, { target: 'selfhost' });

    expect(errors).toContain('binding DB is duplicated across assets, D1');
    expect(errors).toContain(
      'vars.AUTH_OTP_PEPPER must not contain a secret; set it with wrangler secret put'
    );
  });

  it('rejects official GitHub deployment from a fork or non-main ref', () => {
    const config = hostedConfig();
    config.name = OFFICIAL.workerName;
    config.vars.AUTH_EMAIL_FROM = OFFICIAL.sender;
    config.vars.PROJECT_INVITATION_EMAIL_FROM = OFFICIAL.sender;
    config.vars.PUBLIC_APP_ORIGIN = OFFICIAL.publicOrigin;
    config.vars.TURNSTILE_SITE_KEY = OFFICIAL.turnstileSiteKey;
    config.d1_databases[0]!.database_name = OFFICIAL.databaseName;
    config.d1_databases[0]!.database_id = OFFICIAL.databaseId;
    config.r2_buckets[0]!.bucket_name = OFFICIAL.bucketName;

    const errors = validateDeploymentConfig(config, {
      target: 'official',
      originUrl: 'https://github.com/example/OpenZCAD.git',
      environment: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'example/OpenZCAD',
        GITHUB_REF: 'refs/pull/1/merge'
      }
    });

    expect(errors).toContain(
      'official deployment requires an esaueng/OpenZCAD origin; found https://github.com/example/OpenZCAD.git'
    );
    expect(errors).toContain(
      'official deployment is not allowed from GitHub repository example/OpenZCAD'
    );
    expect(errors).toContain(
      'official deployment is not allowed from GitHub ref refs/pull/1/merge'
    );
  });
});
