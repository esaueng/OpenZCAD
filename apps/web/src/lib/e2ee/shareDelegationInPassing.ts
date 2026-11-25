/**
 * L11 (D4, ADR-024 amendment 2026-11-25): `E2eeContext.afterIdentityKey`
 * for the page. An action that opened the identity key (a device unlocked,
 * approved or removed, a passkey added or removed, contacts sealed) also
 * renews the account's share delegation when it has one and it is due, so
 * Create link rarely has to ask. Loaded only after such an action; it starts
 * no MLS session. True when it signed one. The action treats a failure as
 * best effort.
 */
import { createE2eeShareLinksApi } from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import type { AccountView, E2eeContext } from './accountKeys';

export async function renewShareDelegationInPassing(
  e2ee: Pick<E2eeContext, 'api'>,
  step: {
    readonly identityPrivateKey: CryptoKey;
    readonly account: AccountView;
  },
  api = createE2eeShareLinksApi(desktopFetch)
): Promise<boolean> {
  // While encrypted projects are closed to the account there are no links,
  // and the delegation routes would only answer 501.
  const config = await e2ee.api.config().catch(() => null);
  if (!config?.enabled || config.projectsEnabled !== true) return false;
  const { renewShareDelegationInPassing: renew, signWithIdentityKey } =
    await import('./shareLinks');
  const { account } = step;
  const renewed = await renew(
    {
      groups: {
        account: { list: account.list, generation: account.generation },
        device:
          account.deviceStatus === 'certified' && account.device
            ? { deviceId: account.device.deviceId }
            : null
      },
      api
    },
    signWithIdentityKey(step.identityPrivateKey)
  );
  return renewed !== null;
}
