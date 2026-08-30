export const REQUIRED_BETA_HEALTH: Readonly<{
  status: 'ok';
  environment: 'beta';
  artifactUploadAccountingReady: true;
  documentStorageAccountingReady: true;
  projectObjectStorageReady: true;
  projectMeasurementStorageReady: true;
  accountErasureReady: true;
  projectErasureReady: true;
  projectMeasurementSyncEnabled: true;
}>;

export function betaDeploymentErrors(options: {
  health: Record<string, unknown> | undefined;
  metadata: Record<string, unknown> | undefined;
  expectedCommit: string;
}): string[];

export function verifyBetaDeployment(options?: {
  origin?: string;
  expectedCommit?: string;
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn'>;
}): Promise<{
  health: Record<string, unknown>;
  metadata: Record<string, unknown>;
}>;
