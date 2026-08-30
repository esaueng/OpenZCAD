export const REQUIRED_SECRETS: readonly string[];
export const UPLOAD_CLEANUP_CRON: '17 * * * *';

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

export function validateDeploymentConfig(
  config: Record<string, any>,
  options: {
    target: 'official' | 'selfhost' | 'example';
    originUrl?: string;
    environment?: Record<string, string | undefined>;
  }
): string[];
