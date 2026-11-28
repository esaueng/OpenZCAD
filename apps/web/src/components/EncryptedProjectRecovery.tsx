import { useEffect, useState } from 'react';
import { parseRecoveryKey } from '@openzcad/crypto';
import type {
  AccountView,
  E2eeContext,
  UnlockAuthorization
} from '../lib/e2ee/accountKeys';
import type { RecoverableProject } from '../lib/e2ee/pageDeviceRemoval';
import { Group, Notice, SettingRow } from './settingsControls';

/**
 * Settings › Encryption › Encrypted project recovery (ADR-024 Phase 4,
 * decision D9): reset a solo project's encryption group when none of your
 * devices can open its keys any more. The owner must confirm, in plain
 * words, that nobody else has access, and the recovery key (or a passkey)
 * signs the reset. Its code loads only when the section is opened.
 *
 * A project whose verification record the account no longer returns (issue
 * #1704) is named here too. Where this device's own verified copy shows the
 * account owns it, the owner can put the record back after confirming in
 * plain words; the account's word alone never does.
 */
export function EncryptedProjectRecovery({
  ctx,
  account,
  canUsePasskey
}: {
  ctx: E2eeContext;
  account: AccountView;
  canUsePasskey: boolean;
}) {
  const [projects, setProjects] = useState<RecoverableProject[] | null>(null);
  const [target, setTarget] = useState<RecoverableProject | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'warning' | 'success';
    text: string;
  } | null>(null);
  const [phrase, setPhrase] = useState('');
  const [restoring, setRestoring] = useState<RecoverableProject | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restorePhrase, setRestorePhrase] = useState('');
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    ctx.api.config().then(
      (config) => {
        if (live)
          setAvailable(config.enabled && config.projectsEnabled === true);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [ctx]);

  const page = () => import('../lib/e2ee/pageDeviceRemoval');

  const show = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const module = await page();
      setPhrase(module.GROUP_RESET_CONFIRMATION);
      setRestorePhrase(module.AUTHORITY_RESTORE_CONFIRMATION);
      setProjects(await module.encryptedProjectsForRecovery(ctx, account));
    } catch (error) {
      setMessage({
        tone: 'warning',
        text:
          error instanceof Error
            ? error.message
            : 'Encrypted projects could not be listed.'
      });
    } finally {
      setBusy(false);
    }
  };

  const reset = async (authorization: UnlockAuthorization) => {
    if (!target) return;
    setBusy(true);
    setMessage(null);
    try {
      const module = await page();
      await module.resetEncryptedProject(
        ctx,
        account,
        target.projectId,
        authorization,
        confirmed ? module.GROUP_RESET_CONFIRMATION : ''
      );
      setMessage({
        tone: 'success',
        text: `${target.name} has a new encryption group. Its history stays readable on your devices.`
      });
      setTarget(null);
      setConfirmed(false);
      setText('');
    } catch (error) {
      setMessage({
        tone: 'warning',
        text:
          error instanceof Error
            ? error.message
            : 'The project could not be reset.'
      });
    } finally {
      if (authorization instanceof Uint8Array) authorization.fill(0);
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!restoring) return;
    setBusy(true);
    setMessage(null);
    try {
      const module = await page();
      const outcome = await module.restoreEncryptedProjectAuthority(
        ctx,
        account,
        restoring.projectId,
        restoreConfirmed ? module.AUTHORITY_RESTORE_CONFIRMATION : ''
      );
      setMessage(
        outcome.verified
          ? {
              tone: 'success',
              text: `The verification record of ${restoring.name} is back in your account. Open the project again to sync it.`
            }
          : {
              tone: 'warning',
              text: `The verification record of ${restoring.name} is back in your account, but the project’s history still doesn’t verify, so it stays unsynced. ${outcome.problem ?? ''}`.trim()
            }
      );
      setProjects(
        (current) =>
          current?.map((project) =>
            project.projectId === restoring.projectId
              ? { projectId: project.projectId, name: project.name }
              : project
          ) ?? null
      );
      setRestoring(null);
      setRestoreConfirmed(false);
    } catch (error) {
      setMessage({
        tone: 'warning',
        text:
          error instanceof Error
            ? error.message
            : 'The verification record could not be restored.'
      });
    } finally {
      setBusy(false);
    }
  };

  if (!available) return null;
  return (
    <Group title="Encrypted project recovery">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {projects === null ? (
        <SettingRow
          title="Reset a project’s encryption group"
          hint="For a project only you use, when no device can open it."
        >
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => void show()}
          >
            Show encrypted projects
          </button>
        </SettingRow>
      ) : projects.length === 0 ? (
        <Notice tone="info">You have no encrypted projects.</Notice>
      ) : (
        projects.map((project) => {
          const resetKeys = (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              aria-label={`Reset the encryption group of ${project.name}`}
              onClick={() => {
                setRestoring(null);
                setTarget(project);
                setConfirmed(false);
                setText('');
              }}
            >
              Reset keys
            </button>
          );
          if (!project.authority) {
            return (
              <SettingRow key={project.projectId} title={project.name} compact>
                {resetKeys}
              </SettingRow>
            );
          }
          return (
            <SettingRow
              key={project.projectId}
              title={project.name}
              hint={
                project.authority === 'restorable'
                  ? 'Your account no longer returns this project’s verification record, so this device won’t sync it. This device kept its verified copy.'
                  : 'Secured with encryption keys your account no longer has, so it can’t be verified or synced. Open it, choose Export project in the File menu, then import it as a new project.'
              }
            >
              <span className="encryption-actions">
                {project.authority === 'restorable' ? (
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy}
                    aria-label={`Restore the verification record of ${project.name}`}
                    onClick={() => {
                      setTarget(null);
                      setRestoring(project);
                      setRestoreConfirmed(false);
                    }}
                  >
                    Restore record
                  </button>
                ) : null}
                {resetKeys}
              </span>
            </SettingRow>
          );
        })
      )}
      {restoring ? (
        <>
          <Notice tone="warning">
            Restoring saves the verification record of {restoring.name} to your
            account again, from the copy this device verified. The project’s
            members, keys and history stay as they are, and this device keeps
            checking the account against its own copy. Only restore a project
            that is yours, and from the device you last used it on.
          </Notice>
          <SettingRow title="Confirm" hint={restorePhrase}>
            <input
              type="checkbox"
              aria-label={restorePhrase}
              checked={restoreConfirmed}
              onChange={(event) => setRestoreConfirmed(event.target.checked)}
            />
          </SettingRow>
          <div className="settings-button-row">
            <button
              className="secondary"
              type="button"
              disabled={busy || !restoreConfirmed}
              onClick={() => void restore()}
            >
              Restore verification record
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setRestoring(null)}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
      {target ? (
        <>
          <Notice tone="warning">
            Resetting starts a new encryption group for {target.name}. Your
            devices rejoin it; older versions stay readable. If anyone else had
            access, they would be cut off and their copy would split from yours.
          </Notice>
          <SettingRow title="Confirm" hint={phrase}>
            <input
              type="checkbox"
              aria-label={phrase}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
          </SettingRow>
          <SettingRow
            title="Recovery key to confirm"
            hint="Opens your identity key for this one change, then it is forgotten."
          >
            <input
              className="settings-text-wide"
              value={text}
              aria-label="Recovery key"
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-…"
              onChange={(event) => setText(event.target.value)}
            />
          </SettingRow>
          <div className="settings-button-row">
            <button
              className="secondary danger"
              type="button"
              disabled={busy || !confirmed || text.trim() === ''}
              onClick={() =>
                void parseRecoveryKey(text).then(
                  (secret) => reset(secret),
                  () =>
                    setMessage({
                      tone: 'warning',
                      text: 'That is not a recovery key. Check it for typos: it is 56 letters and digits in groups of four.'
                    })
                )
              }
            >
              Reset encryption group
            </button>
            {canUsePasskey ? (
              <button
                className="secondary"
                type="button"
                disabled={busy || !confirmed}
                onClick={() => void reset('passkey')}
              >
                Confirm with passkey
              </button>
            ) : null}
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setTarget(null)}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </Group>
  );
}
