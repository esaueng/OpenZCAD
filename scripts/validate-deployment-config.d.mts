export const REQUIRED_SECRETS: readonly string[];
export const UPLOAD_CLEANUP_CRON: '17 * * * *';

export const RELEASE_BUILD_CHECK: string;
export const OFFICIAL: Readonly<{
  repository: string;
  workerName: string;
  databaseBinding: string;
  databaseName: string;
  databaseId: string;
  bucketBinding: string;
  bucketName: string;
  emailBinding: string;
  durableObjectBinding: string;
  assetBinding: string;
  turnstileSiteKey: string;
  publicOrigin: string;
  sender: string;
}>;

export const OFFICIAL_STABLE: Readonly<{
  workerName: string;
  databaseName: string;
  databaseId: string;
  bucketName: string;
  sender: string;
  publicOrigins: readonly string[];
  branch: string;
}>;

export function validateDeploymentConfig(
  config: Record<string, any>,
  options: {
    target: 'official' | 'stable' | 'selfhost' | 'example' | 'dev';
    configOnly?: boolean;
    originUrl?: string;
    environment?: Record<string, string | undefined>;
    /** Required for `stable`: beta's config, to compare shared budgets. */
    betaConfig?: Record<string, any>;
  }
): string[];

export const E2EE_FLAGS: readonly string[];
export const E2EE_FLAG_PREREQUISITES: readonly (readonly [string, string])[];
export const E2EE_PLANNED_FLAGS: readonly string[];
