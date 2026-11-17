import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Copy, Download, Fingerprint, Printer } from 'lucide-react';
import {
  generateRecoveryKey,
  parseRecoveryKey,
  type Bytes
} from '@openzcad/crypto';
import {
  addPasskey,
  defaultDeviceLabel,
  replaceRecoveryKey,
  setUpEncryption,
  type AccountView,
  type EncryptionState
} from '../../lib/e2ee/accountKeys';
import {
  createProjectPreferenceApi,
  loadProjectPreference,
  localStoragePreferencePins,
  preferenceFloor,
  saveProjectPreference
} from '../../lib/e2ee/projectPreferences';
import { unlockedAccount } from '../../lib/e2ee/unlockedKeys';
import { encryptionStateChanged } from '../../lib/e2ee/encryptionStateEvents';
import {
  passkeyPrfSupport,
  type PasskeyPrfSupport
} from '../../lib/e2ee/passkeys';
import { EncryptionDialog } from './EncryptionDialog';
import { downloadRecoveryKey, readRecoveryKey, type Shared } from './flow';

/** What losing every way in costs, said the same way wherever it matters. */
export const LOSS_SENTENCE =
  'If you lose every device, every passkey and the recovery key, your encrypted cloud projects can’t be recovered, by you or by us.';

type RecoveryKey = { secret: Bytes; formatted: string };

/** A fresh recovery key, erased when its flow closes. */
function useFreshRecoveryKey(): RecoveryKey | null {
  const [recovery, setRecovery] = useState<RecoveryKey | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: RecoveryKey | null = null;
    void generateRecoveryKey().then((key) => {
      made = key;
      if (cancelled) key.secret.fill(0);
      else setRecovery(key);
    });
    return () => {
      cancelled = true;
      made?.secret.fill(0);
    };
  }, []);
  return recovery;
}

function printRecoveryKey(formatted: string): void {
  const frame = window.open('', '_blank', 'width=480,height=360');
  if (!frame) return;
  frame.document.title = 'OpenZCAD recovery key';
  const body = frame.document.body;
  body.style.fontFamily = 'system-ui, sans-serif';
  const heading = frame.document.createElement('h1');
  heading.textContent = 'OpenZCAD recovery key';
  const key = frame.document.createElement('pre');
  key.textContent = formatted;
  key.style.fontSize = '18px';
  const note = frame.document.createElement('p');
  note.textContent =
    'Keep this somewhere safe and offline. It opens your encryption keys on any device. OpenZCAD cannot recover it for you.';
  body.append(heading, key, note);
  frame.focus();
  frame.print();
}

/** Step: the new key, its copies, and the acknowledgement (I80). */
function SaveKeyStep({
  recovery,
  saved,
  onSaved
}: {
  recovery: RecoveryKey;
  saved: boolean;
  onSaved(saved: boolean): void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <p>
        This is your recovery key. It opens your encryption keys on any device.
      </p>
      <code className="encryption-key-display" aria-label="Recovery key">
        {recovery.formatted}
      </code>
      <div className="encryption-actions start">
        <button
          className="secondary"
          type="button"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(recovery.formatted)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          <Copy size={14} aria-hidden="true" />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => downloadRecoveryKey(recovery.formatted)}
        >
          <Download size={14} aria-hidden="true" />
          Download
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => printRecoveryKey(recovery.formatted)}
        >
          <Printer size={14} aria-hidden="true" />
          Print
        </button>
      </div>
      <label className="encryption-acknowledge">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => onSaved(event.target.checked)}
        />
        I saved my recovery key somewhere other than this device, such as a
        password manager or on paper
      </label>
    </>
  );
}

/** Step: the key typed back. Setup cannot finish with an unsaved key. */
function ConfirmKeyStep({
  typed,
  mismatch,
  onTyped,
  onSubmit
}: {
  typed: string;
  mismatch: boolean;
  onTyped(text: string): void;
  onSubmit(): void;
}) {
  const id = useId();
  return (
    <div className="encryption-key-field">
      <label htmlFor={id}>Confirm recovery key</label>
      <input
        id={id}
        value={typed}
        aria-invalid={mismatch || undefined}
        aria-describedby={mismatch ? `${id}-error` : `${id}-hint`}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        onChange={(event) => onTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && typed.trim()) onSubmit();
        }}
      />
      {mismatch ? (
        <small id={`${id}-error`} className="settings-field-error" role="alert">
          That does not match. Go back and check what you saved.
        </small>
      ) : (
        <small id={`${id}-hint`}>Type or paste the key you saved.</small>
      )}
    </div>
  );
}

async function sameKey(typed: string, secret: Bytes): Promise<boolean> {
  let parsed: Bytes;
  try {
    parsed = await parseRecoveryKey(typed);
  } catch {
    return false;
  }
  const match =
    parsed.length === secret.length &&
    parsed.every((byte, index) => byte === secret[index]);
  parsed.fill(0);
  return match;
}

type SetupStep = 'intro' | 'save' | 'confirm' | 'passkey' | 'projects';

interface ProjectsChoice {
  /** The server requires encryption for new projects: no choice to make. */
  required: boolean;
}

/**
 * Settings › Encryption setup as one guided dialog (L11 plan §4.2): what
 * changes, the recovery key saved and typed back, a passkey for one-touch
 * confirmation, then "Encrypt new projects" ticked by default. Cancel before
 * the key is confirmed discards everything; from then on the account has
 * keys, and closing only skips the optional steps.
 */
export function SetupDialog({
  userId,
  busy,
  run,
  ctx,
  onClose,
  onEncryptExisting
}: Shared & {
  userId: string;
  onClose(): void;
  /** Closes the dialog at Settings' "Encrypt existing projects". */
  onEncryptExisting(): void;
}) {
  const recovery = useFreshRecoveryKey();
  const [step, setStep] = useState<SetupStep>('intro');
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [prf, setPrf] = useState<PasskeyPrfSupport>('unknown');
  const [projects, setProjects] = useState<ProjectsChoice | null>(null);
  const [encryptNew, setEncryptNew] = useState(true);
  const preferenceApi = useMemo(() => createProjectPreferenceApi(), []);

  useEffect(() => {
    let live = true;
    void passkeyPrfSupport().then((support) => {
      if (live) setPrf(support);
    });
    void preferenceApi
      .config()
      .then((config) => {
        if (!live) return;
        setProjects(
          config.enabled && config.projectsEnabled === true
            ? { required: config.defaultOn === true }
            : null
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [preferenceApi]);

  const steps: SetupStep[] = [
    'intro',
    'save',
    'confirm',
    ...(prf === 'unsupported' ? [] : (['passkey'] as const)),
    ...(projects ? (['projects'] as const) : [])
  ];
  const at = steps.indexOf(step) + 1;
  const after = (current: SetupStep): SetupStep | null =>
    steps[steps.indexOf(current) + 1] ?? null;

  const advanceFrom = (current: SetupStep) => {
    const next = after(current);
    setError(null);
    if (next) setStep(next);
    else onClose();
  };

  const turnOn = () =>
    void run(
      async () => {
        if (!recovery) return;
        const matches = await sameKey(typed, recovery.secret);
        setMismatch(!matches);
        if (!matches) return;
        const next = await setUpEncryption(ctx, {
          recoverySecret: recovery.secret,
          label: defaultDeviceLabel(navigator.userAgent)
        });
        if (next.kind === 'ready') setAccount(next.account);
        advanceFrom('confirm');
        return next;
      },
      { onError: setError }
    );

  const createPasskey = () =>
    void run(
      async () => {
        if (!recovery || !account) return;
        const next: EncryptionState = await addPasskey(
          ctx,
          account,
          recovery.secret
        );
        if (next.kind === 'ready') setAccount(next.account);
        advanceFrom('passkey');
        return next;
      },
      { onError: setError }
    );

  /**
   * Saves the projects choice, then leaves: closing, or going on to Encrypt
   * existing projects. Only after the save succeeds, so a failure is said
   * here instead of in a dialog that has already gone (review finding).
   */
  const finish = (then: () => void = onClose) =>
    void run(
      async () => {
        const unlocked = unlockedAccount(userId);
        if (projects && !projects.required && unlocked) {
          const preferences = {
            userId,
            accountKey: unlocked.accountKey,
            api: preferenceApi,
            pins: localStoragePreferencePins()
          };
          const stored = await loadProjectPreference(preferences);
          const current =
            stored.kind === 'verified' ? stored.encryptNewProjects : false;
          if (current !== encryptNew) {
            await saveProjectPreference(
              preferences,
              encryptNew,
              preferenceFloor(stored)
            );
            encryptionStateChanged(userId);
          }
        }
        then();
      },
      { onError: setError }
    );

  const close = () => {
    if (!busy) onClose();
  };

  if (!recovery) return null;
  const title =
    step === 'passkey'
      ? 'Add a passkey'
      : step === 'projects'
        ? 'Your projects'
        : 'Set up encryption';

  let body: ReactNode;
  let footer: ReactNode;
  switch (step) {
    case 'intro':
      body = (
        <>
          <p>
            <strong>
              Only your devices will be able to read your cloud projects.
            </strong>{' '}
            OpenZCAD can’t read them, and can’t recover them for you.
          </p>
          <p>
            Next you’ll save a recovery key. It’s your way back in if you lose
            your devices.
          </p>
          <p className="encryption-dialog-warning">{LOSS_SENTENCE}</p>
        </>
      );
      footer = (
        <>
          <button className="secondary" type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => setStep('save')}
          >
            Start
          </button>
        </>
      );
      break;
    case 'save':
      body = (
        <SaveKeyStep recovery={recovery} saved={saved} onSaved={setSaved} />
      );
      footer = (
        <>
          <button
            className="secondary"
            type="button"
            onClick={() => setStep('intro')}
          >
            Back
          </button>
          <button
            className="primary"
            type="button"
            disabled={!saved}
            onClick={() => setStep('confirm')}
          >
            Continue
          </button>
        </>
      );
      break;
    case 'confirm':
      body = (
        <ConfirmKeyStep
          typed={typed}
          mismatch={mismatch}
          onTyped={(text) => {
            setTyped(text);
            setMismatch(false);
          }}
          onSubmit={turnOn}
        />
      );
      footer = (
        <>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => setStep('save')}
          >
            Back
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy || typed.trim() === ''}
            onClick={turnOn}
          >
            Turn on encryption
          </button>
        </>
      );
      break;
    case 'passkey':
      body = (
        <>
          <p>
            <strong>Encryption is on.</strong> Add a passkey to unlock new
            devices and confirm changes with one touch, instead of typing the
            recovery key.
          </p>
          <p>
            Your password manager or device saves it, and it syncs to your other
            devices where the provider supports that. The recovery key stays
            your backup.
          </p>
        </>
      );
      footer = (
        <>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => advanceFrom('passkey')}
          >
            Skip
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={createPasskey}
          >
            <Fingerprint size={14} aria-hidden="true" />
            Add passkey
          </button>
        </>
      );
      break;
    case 'projects':
      body = projects?.required ? (
        <p>
          This server encrypts every new cloud project. Projects you already
          have stay as they are until you encrypt them.
        </p>
      ) : (
        <>
          <p>Choose what to encrypt. You can change this later.</p>
          <label className="encryption-acknowledge">
            <input
              type="checkbox"
              checked={encryptNew}
              onChange={(event) => setEncryptNew(event.target.checked)}
            />
            <span>
              <strong>Encrypt new projects</strong> (recommended)
            </span>
          </label>
          <p>
            Projects you already have stay as they are until you encrypt them.
          </p>
        </>
      );
      footer = (
        <>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => finish(onEncryptExisting)}
          >
            Encrypt existing projects…
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => finish()}
          >
            Done
          </button>
        </>
      );
      break;
  }

  return (
    <EncryptionDialog
      title={title}
      step={{ at, of: steps.length }}
      busy={busy}
      onClose={close}
      footer={footer}
    >
      {body}
      {error ? (
        <p className="encryption-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </EncryptionDialog>
  );
}

/**
 * Replacing the recovery key, which replaces the identity too (ADR-024, Key
 * lifecycle): the cost first, then the new key saved and typed back, with
 * the current key optional to sign the hand-over.
 */
export function ReplaceRecoveryKeyDialog({
  account,
  busy,
  run,
  ctx,
  onClose
}: Shared & { account: AccountView; onClose(): void }) {
  const recovery = useFreshRecoveryKey();
  const [step, setStep] = useState<'save' | 'confirm'>('save');
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState('');
  const [oldTyped, setOldTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oldId = useId();

  const replace = () =>
    void run(
      async () => {
        if (!recovery) return;
        const matches = await sameKey(typed, recovery.secret);
        setMismatch(!matches);
        if (!matches) return;
        const oldSecret = oldTyped.trim()
          ? await readRecoveryKey(oldTyped)
          : null;
        try {
          const next = await replaceRecoveryKey(
            ctx,
            account,
            recovery.secret,
            oldSecret
          );
          onClose();
          return next;
        } finally {
          oldSecret?.fill(0);
        }
      },
      { onError: setError }
    );

  if (!recovery) return null;
  return (
    <EncryptionDialog
      title="Replace recovery key"
      step={{ at: step === 'save' ? 1 : 2, of: 2 }}
      tone="danger"
      busy={busy}
      onClose={onClose}
      footer={
        step === 'save' ? (
          <>
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              type="button"
              disabled={!saved}
              onClick={() => setStep('confirm')}
            >
              Continue
            </button>
          </>
        ) : (
          <>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setStep('save')}
            >
              Back
            </button>
            <button
              className="confirm-dialog-danger"
              type="button"
              disabled={busy || typed.trim() === ''}
              onClick={replace}
            >
              Replace recovery key
            </button>
          </>
        )
      }
    >
      {step === 'save' ? (
        <>
          <p className="encryption-dialog-warning">
            This also replaces your keys: your other devices must be approved
            again, and people who verified you must compare contact codes with
            you again.
          </p>
          <SaveKeyStep recovery={recovery} saved={saved} onSaved={setSaved} />
        </>
      ) : (
        <>
          <ConfirmKeyStep
            typed={typed}
            mismatch={mismatch}
            onTyped={(text) => {
              setTyped(text);
              setMismatch(false);
            }}
            onSubmit={replace}
          />
          <div className="encryption-key-field">
            <label htmlFor={oldId}>Current recovery key (optional)</label>
            <input
              id={oldId}
              value={oldTyped}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setOldTyped(event.target.value)}
            />
            <small>Signs the hand-over to your new key, if you have it.</small>
          </div>
        </>
      )}
      {error ? (
        <p className="encryption-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </EncryptionDialog>
  );
}
