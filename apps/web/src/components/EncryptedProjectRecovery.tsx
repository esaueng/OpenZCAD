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
      setProjects(await module.encryptedProjectsForRecovery());
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
        projects.map((project) => (
          <SettingRow key={project.projectId} title={project.name} compact>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              aria-label={`Reset the encryption group of ${project.name}`}
              onClick={() => {
                setTarget(project);
                setConfirmed(false);
                setText('');
              }}
            >
              Reset keys
            </button>
          </SettingRow>
        ))
      )}
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
