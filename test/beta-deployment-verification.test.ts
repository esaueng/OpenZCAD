import { describe, expect, it } from 'vitest';
import {
  REQUIRED_BETA_HEALTH,
  betaDeploymentErrors
} from '../scripts/verify-beta-deployment.mjs';

const COMMIT = '086d2f3c9a5c1b3bcdf1143035e296ebd104a46e';

describe('beta deployment verification', () => {
  it('accepts the expected commit only when every production gate is ready', () => {
    expect(
      betaDeploymentErrors({
        health: { ...REQUIRED_BETA_HEALTH },
        metadata: {
          format: 'openzcad-build-metadata',
          commit: COMMIT
        },
        expectedCommit: COMMIT
      })
    ).toEqual([]);
  });

  it('rejects schema drift and a stale deployed commit together', () => {
    const errors = betaDeploymentErrors({
      health: {
        ...REQUIRED_BETA_HEALTH,
        projectMeasurementStorageReady: false,
        accountErasureReady: false,
        projectErasureReady: false,
        projectMeasurementSyncEnabled: false
      },
      metadata: {
        format: 'openzcad-build-metadata',
        commit: '0000000000000000000000000000000000000000'
      },
      expectedCommit: COMMIT
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        'health.projectMeasurementStorageReady must be true',
        'health.accountErasureReady must be true',
        'health.projectErasureReady must be true',
        'health.projectMeasurementSyncEnabled must be true',
        'build metadata commit 0000000000000000000000000000000000000000 does not match 086d2f3c9a5c1b3bcdf1143035e296ebd104a46e'
      ])
    );
  });
});
