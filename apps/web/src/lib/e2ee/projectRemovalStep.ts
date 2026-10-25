/**
 * The encrypted-project step of a removal (ADR-024 slice 4-10) as Settings
 * › Encryption hands it to `removeDevice` and the other rotations. The page
 * wiring (`pageDeviceRemoval.ts`) loads only when a removal starts; every
 * step the participant has is forwarded, `written` included, which signs
 * the cutoffs before the account is read again.
 */
import type { E2eeContext, RemovalParticipantStep } from './accountKeys';
import type { RemovalOutcome } from './deviceRemoval';

export function projectRemovalStep(
  ctx: E2eeContext,
  onOutcome: (outcome: RemovalOutcome) => void
): RemovalParticipantStep {
  const load = () =>
    import('./pageDeviceRemoval').then((module) =>
      module.pageRemovalParticipant(ctx, onOutcome)
    );
  let loaded: ReturnType<typeof load> | null = null;
  return {
    prepare: async (account) => (await (loaded ??= load())).prepare(account),
    written: async (step) => (await (loaded ??= load())).written?.(step),
    complete: async (step) => (await (loaded ??= load())).complete(step)
  };
}
