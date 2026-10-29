import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  OFFICIAL,
  validateDeploymentConfig
} from '../scripts/validate-deployment-config.mjs';

function officialConfig() {
  return ts.parseConfigFileTextToJson(
    'wrangler.jsonc',
    readFileSync('wrangler.jsonc', 'utf8')
  ).config as ReturnType<typeof hostedConfig>;
}

const officialOptions = {
  target: 'official' as const,
  originUrl: 'https://github.com/esaueng/OpenZCAD.git',
  configOnly: true
};

function hostedConfig() {
  return {
    account_id: '11111111111111111111111111111111',
    name: 'independent-openzcad',
    main: './apps/web/worker/index.ts',
    assets: { binding: 'ASSETS', run_worker_first: ['/api/*', '/healthz'] },
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
  it('validates official PR configuration without authorizing a deployment', () => {
    const config = ts.parseConfigFileTextToJson(
      'wrangler.jsonc',
      readFileSync('wrangler.jsonc', 'utf8')
    ).config as ReturnType<typeof hostedConfig>;
    const options = {
      target: 'official' as const,
      originUrl: 'https://github.com/esaueng/OpenZCAD.git',
      environment: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'esaueng/OpenZCAD',
        GITHUB_REF: 'refs/pull/565/merge'
      }
    };
    expect(
      validateDeploymentConfig(config, { ...options, configOnly: true })
    ).toEqual([]);
    expect(validateDeploymentConfig(config, options)).toContain(
      'official deployment is not allowed from GitHub ref refs/pull/565/merge'
    );
    config.vars.AUTH_MODE = 'development';
    expect(
      validateDeploymentConfig(config, { ...options, configOnly: true })
    ).toContain('vars.AUTH_MODE must be email-code for a hosted deployment');
  });

  describe('end-to-end encryption flags', () => {
    function withFlags(flags: Record<string, unknown>) {
      const config = hostedConfig();
      Object.assign(config.vars, flags);
      return config;
    }

    it('accepts the recommended rollout steps in order', () => {
      for (const flags of [
        { E2EE_KEYS_ENABLED: 'false', E2EE_PROJECTS_ENABLED: 'false' },
        { E2EE_KEYS_ENABLED: 'true', E2EE_PROJECTS_ENABLED: 'false' },
        { E2EE_KEYS_ENABLED: 'true', E2EE_PROJECTS_ENABLED: 'true' },
        {
          E2EE_KEYS_ENABLED: 'true',
          E2EE_PROJECTS_ENABLED: 'true',
          E2EE_MIGRATION_ENABLED: 'true'
        },
        {
          E2EE_KEYS_ENABLED: 'true',
          E2EE_PROJECTS_ENABLED: 'true',
          E2EE_MIGRATION_ENABLED: 'true',
          E2EE_REVERSE_ENABLED: 'true'
        },
        {
          E2EE_KEYS_ENABLED: 'true',
          E2EE_PROJECTS_ENABLED: 'true',
          E2EE_MIGRATION_ENABLED: 'true',
          E2EE_DEFAULT_ON: 'true'
        }
      ]) {
        expect(
          validateDeploymentConfig(withFlags(flags), { target: 'selfhost' })
        ).toEqual([]);
      }
    });

    it('accepts the shipped self-hosting example', () => {
      const config = ts.parseConfigFileTextToJson(
        'wrangler.selfhost.example.jsonc',
        readFileSync('wrangler.selfhost.example.jsonc', 'utf8')
      ).config as ReturnType<typeof hostedConfig>;
      expect(validateDeploymentConfig(config, { target: 'example' })).toEqual(
        []
      );
      // Shipped closed: an operator turns them on in order after reading the
      // End-to-end encryption section of docs/SELF_HOSTING.md.
      expect(config.vars).toMatchObject({
        E2EE_KEYS_ENABLED: 'false',
        E2EE_PROJECTS_ENABLED: 'false',
        E2EE_MIGRATION_ENABLED: 'false',
        E2EE_DEFAULT_ON: 'false'
      });
      expect(config.vars).not.toHaveProperty('E2EE_REVERSE_ENABLED');
    });

    it('rejects a flag whose prerequisite is off', () => {
      expect(
        validateDeploymentConfig(withFlags({ E2EE_PROJECTS_ENABLED: 'true' }), {
          target: 'selfhost'
        })
      ).toContain(
        'vars.E2EE_PROJECTS_ENABLED requires vars.E2EE_KEYS_ENABLED to be "true"'
      );
      expect(
        validateDeploymentConfig(
          withFlags({
            E2EE_KEYS_ENABLED: 'true',
            E2EE_PROJECTS_ENABLED: 'false',
            E2EE_MIGRATION_ENABLED: 'true'
          }),
          { target: 'selfhost' }
        )
      ).toEqual([
        'vars.E2EE_MIGRATION_ENABLED requires vars.E2EE_PROJECTS_ENABLED to be "true"'
      ]);
      expect(
        validateDeploymentConfig(
          withFlags({
            E2EE_KEYS_ENABLED: 'true',
            E2EE_PROJECTS_ENABLED: 'true',
            E2EE_REVERSE_ENABLED: 'on'
          }),
          { target: 'example' }
        )
      ).toEqual([
        'vars.E2EE_REVERSE_ENABLED requires vars.E2EE_MIGRATION_ENABLED to be "true"'
      ]);
    });

    it('reads flag values the way the Worker does', () => {
      expect(
        validateDeploymentConfig(
          withFlags({
            E2EE_KEYS_ENABLED: ' Yes ',
            E2EE_PROJECTS_ENABLED: '1',
            E2EE_MIGRATION_ENABLED: 'OFF'
          }),
          { target: 'selfhost' }
        )
      ).toEqual([]);
      const errors = validateDeploymentConfig(
        withFlags({
          E2EE_KEYS_ENABLED: true,
          E2EE_PROJECTS_ENABLED: 'enabled'
        }),
        { target: 'selfhost' }
      );
      expect(errors).toContain(
        'vars.E2EE_KEYS_ENABLED must be the string "true" or "false"'
      );
      expect(errors).toContain(
        'vars.E2EE_PROJECTS_ENABLED must be the string "true" or "false"'
      );
    });

    it('rejects an E2EE name the Worker does not read, naming the closest flag', () => {
      expect(
        validateDeploymentConfig(
          withFlags({
            E2EE_KEYS_ENABLED: 'true',
            E2EE_PROJETCS_ENABLED: 'true'
          }),
          { target: 'selfhost' }
        )
      ).toEqual([
        'vars.E2EE_PROJETCS_ENABLED is not an end-to-end encryption flag this release reads; did you mean E2EE_PROJECTS_ENABLED?'
      ]);
      expect(
        validateDeploymentConfig(withFlags({ E2EE_KEY_ENABLED: 'false' }), {
          target: 'official'
        })
      ).toContain(
        'vars.E2EE_KEY_ENABLED is not an end-to-end encryption flag this release reads; did you mean E2EE_KEYS_ENABLED?'
      );
    });

    it('requires migration for default-on and rejects the conflicting reverse flag', () => {
      expect(
        validateDeploymentConfig(
          withFlags({
            E2EE_KEYS_ENABLED: 'true',
            E2EE_PROJECTS_ENABLED: 'true',
            E2EE_DEFAULT_ON: 'true'
          }),
          { target: 'selfhost' }
        )
      ).toEqual([
        'vars.E2EE_DEFAULT_ON requires vars.E2EE_MIGRATION_ENABLED to be "true"'
      ]);
      expect(
        validateDeploymentConfig(
          withFlags({
            E2EE_KEYS_ENABLED: 'true',
            E2EE_PROJECTS_ENABLED: 'true',
            E2EE_MIGRATION_ENABLED: 'true',
            E2EE_DEFAULT_ON: 'on',
            E2EE_REVERSE_ENABLED: 'yes'
          }),
          { target: 'selfhost' }
        )
      ).toEqual([
        'vars.E2EE_REVERSE_ENABLED must be "false" while vars.E2EE_DEFAULT_ON is "true"'
      ]);
      expect(
        validateDeploymentConfig(withFlags({ E2EE_DEFAULT_ON: true }), {
          target: 'selfhost'
        })
      ).toContain('vars.E2EE_DEFAULT_ON must be the string "true" or "false"');
    });

    it('accepts the plaintext freeze only with global keys and default-on prerequisites', () => {
      const official = officialConfig();
      Object.assign(official.vars, {
        E2EE_KEYS_ENABLED: 'false', E2EE_PROJECTS_ENABLED: 'true', E2EE_MIGRATION_ENABLED: 'true',
        E2EE_DEFAULT_ON: 'true', E2EE_PLAINTEXT_FROZEN: 'true'
      });
      expect(validateDeploymentConfig(official, officialOptions)).toContain('vars.E2EE_PLAINTEXT_FROZEN requires vars.E2EE_KEYS_ENABLED to be "true"');
      expect(
        validateDeploymentConfig(
          withFlags({
            E2EE_DEFAULT_ON: 'false',
            E2EE_PLAINTEXT_FROZEN: 'false'
          }),
          { target: 'selfhost' }
        )
      ).toEqual([]);
      expect(
        validateDeploymentConfig(withFlags({ E2EE_PLAINTEXT_FROZEN: false }), {
          target: 'selfhost'
        })
      ).toEqual([
        'vars.E2EE_PLAINTEXT_FROZEN must be the string "true" or "false"'
      ]);
      expect(
        validateDeploymentConfig(withFlags({ E2EE_PLAINTEXT_FROZEN: 'true' }), {
          target: 'selfhost'
        })
      ).toEqual([
        'vars.E2EE_PLAINTEXT_FROZEN requires vars.E2EE_DEFAULT_ON to be "true"',
        'vars.E2EE_PLAINTEXT_FROZEN requires vars.E2EE_KEYS_ENABLED to be "true"'
      ]);
      expect(
        validateDeploymentConfig(
          withFlags({
            E2EE_KEYS_ENABLED: 'true',
            E2EE_PROJECTS_ENABLED: 'true',
            E2EE_MIGRATION_ENABLED: 'true',
            E2EE_DEFAULT_ON: 'true',
            E2EE_PLAINTEXT_FROZEN: 'true'
          }),
          { target: 'selfhost' }
        )
      ).toEqual([]);
    });

    it('rejects canary accounts committed to vars', () => {
      expect(
        validateDeploymentConfig(
          withFlags({ E2EE_CANARY_EMAILS: 'someone@example.test' }),
          { target: 'selfhost' }
        )
      ).toContain(
        'vars.E2EE_CANARY_EMAILS must not list accounts in the config; set it with wrangler secret put'
      );
    });

    it('lets the official deployment run the canary but keeps the rest of the order', () => {
      const canary = officialConfig();
      Object.assign(canary.vars, {
        E2EE_KEYS_ENABLED: 'false',
        E2EE_PROJECTS_ENABLED: 'true'
      });
      expect(validateDeploymentConfig(canary, officialOptions)).toEqual([]);
      expect(
        validateDeploymentConfig(canary, { target: 'selfhost' })
      ).toContain(
        'vars.E2EE_PROJECTS_ENABLED requires vars.E2EE_KEYS_ENABLED to be "true"'
      );

      const migration = officialConfig();
      Object.assign(migration.vars, {
        E2EE_PROJECTS_ENABLED: 'false', E2EE_MIGRATION_ENABLED: 'true'
      });
      expect(validateDeploymentConfig(migration, officialOptions)).toEqual([
        'vars.E2EE_MIGRATION_ENABLED requires vars.E2EE_PROJECTS_ENABLED to be "true"'
      ]);
    });
  });
});
