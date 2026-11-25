import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Copy, Download, Fingerprint, KeyRound, Printer } from 'lucide-react';
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
import {
  pageMigrationController,
  type MigrationController
} from '../../lib/e2ee/projectMigrations';
import { unlockedAccount } from '../../lib/e2ee/unlockedKeys';
import { encryptionStateChanged } from '../../lib/e2ee/encryptionStateEvents';
import {
  browserPasskeys,
  failedPasskeyEnrollment,
  passkeyEnrollmentCleanup,
  passkeyPrfSupport,
  PasskeyError,
  type PasskeyPrf,
  type PasskeyPrfSupport,
  type PasskeySecret
} from '../../lib/e2ee/passkeys';
import { EncryptionDialog } from './EncryptionDialog';
import {
  downloadRecoveryKey,
  messageFor,
  readRecoveryKey,
  type Shared
} from './flow';

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
  hideLastGroup = false,
  onSaved
}: {
  recovery: RecoveryKey;
  saved: boolean;
  /** Masks the group typed back below, so it is read from the saved copy. */
  hideLastGroup?: boolean;
  onSaved(saved: boolean): void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <p>
        This is your recovery key. It opens your encryption keys on any device.
      </p>
      <code className="encryption-key-display" aria-label="Recovery key">
        {hideLastGroup
          ? `${recovery.formatted.slice(0, recovery.formatted.lastIndexOf('-') + 1)}••••`
          : recovery.formatted}
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

/** Forgiving like `parseRecoveryKey`: case, spaces, dashes, O and I/L. */
function normalizedGroup(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** The key's last group of four, which a setup without a passkey types back. */
export function lastRecoveryGroup(formatted: string): string {
  return formatted.slice(formatted.lastIndexOf('-') + 1);
}

/**
 * Step: the last group of the key typed back, from the copy the user saved
 * (ADR-024 amendment 2026-11-25, D2). Asked only where setup made no
 * passkey; the key above hides that group meanwhile.
 */
function LastGroupField({
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
      <label htmlFor={id}>Last group of your recovery key</label>
      <input
        id={id}
        value={typed}
        aria-invalid={mismatch || undefined}
        aria-describedby={mismatch ? `${id}-error` : `${id}-hint`}
        autoComplete="off"
        spellCheck={false}
        maxLength={16}
        onChange={(event) => onTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && typed.trim()) onSubmit();
        }}
      />
      {mismatch ? (
        <small id={`${id}-error`} className="settings-field-error" role="alert">
          That does not match. Check the copy you saved.
        </small>
      ) : (
        <small id={`${id}-hint`}>
          Type its last four characters from the copy you saved.
        </small>
      )}
    </div>
  );
}

/**
 * Hands `addPasskey` the credential setup already created, so the person
 * confirms once for creation (twice where the browser evaluates PRF only on
 * a follow-up assertion, as Safari does), while the click still counts as a
 * user gesture, before any key or network work.
 */
function createdPasskey(created: PasskeySecret): PasskeyPrf {
  let taken = false;
  return {
    create: async () => {
      if (taken) throw new PasskeyError('That passkey was already used.');
      taken = true;
      return created;
    },
    get: () =>
      Promise.reject(new PasskeyError('No passkey is needed for this step.'))
  };
}

/** A passkey failure, with the provider clean-up it needs, in one message. */
function passkeyProblem(caught: unknown, created?: PasskeySecret): string {
  const tagged =
    passkeyEnrollmentCleanup(caught) || !created?.enrollmentLabel
      ? caught
      : failedPasskeyEnrollment(caught, created.enrollmentLabel);
  const cleanup = passkeyEnrollmentCleanup(tagged);
  return `${messageFor(tagged)}${cleanup ? ` ${cleanup}` : ''}`;
}

type SetupStep = 'intro' | 'save' | 'projects';

interface ProjectsChoice {
  /** The server requires encryption for new projects: no choice to make. */
  required: boolean;
  /** Existing plaintext projects can be encrypted (ADR-024 Phase 7). */
  migration: boolean;
}

/** The account's projects not yet encrypted, and the run that encrypts them. */
interface ExistingProjects {
  controller: MigrationController;
  ids: string[];
}

/**
 * Settings › Encryption setup in three screens, passkey first (L11 plan
 * 2026-11-25 §5, decision D2):
 *
 * 1. Turn on encryption. The recovery key already exists in memory.
 *    "Continue with passkey" creates the passkey first (no typing), then
 *    sets up the keys and enrolls that passkey with the in-memory recovery
 *    secret. "Use a recovery key only" commits nothing yet.
 * 2. Save your recovery key, ticking "I saved it". With a passkey made in
 *    setup nothing is typed; without one the last group is typed back, and
 *    only then does a recovery-key-only setup commit its keys.
 * 3. You're set: "Encrypt new projects" and "Encrypt my N existing cloud
 *    projects", both ticked, then Done.
 *
 * A passkey that is cancelled or fails falls back to the recovery-key-only
 * path: before setup that commits nothing; after it, the account already
 * holds keys with the recovery key as its only way in. Once keys exist,
 * screen 2 cannot be closed until the key is saved. Closing before then
 * discards everything, and the recovery secret is zeroed on close.
 */
export function SetupDialog({
  userId,
  busy,
  run,
  ctx,
  onClose,
  onEncryptExisting,
  onComplete,
  skipProjectsStep = false
}: Shared & {
  userId: string;
  onClose(): void;
  /**
   * Closes the dialog at Settings' "Encrypt existing projects", once Done
   * has started encrypting them there. Without it, Done just closes.
   */
  onEncryptExisting?(): void;
  /**
   * Called once, before `onClose`, when the dialog ends with encryption on
   * and its recovery key saved.
   */
  onComplete?(): void;
  /**
   * Ends the dialog once the recovery key is saved, for a caller that goes
   * on to its own next step (an invitation opening the shared project).
   */
  skipProjectsStep?: boolean;
}) {
  const recovery = useFreshRecoveryKey();
  const [step, setStep] = useState<SetupStep>('intro');
  const [prf, setPrf] = useState<PasskeyPrfSupport | null>(null);
  /** Keys exist on the server: set when `setUpEncryption` succeeded. */
  const [committed, setCommitted] = useState(false);
  const [passkeyMade, setPasskeyMade] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [typed, setTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectsChoice | null>(null);
  const [encryptNew, setEncryptNew] = useState(true);
  const [encryptExisting, setEncryptExisting] = useState(true);
  const [existing, setExisting] = useState<ExistingProjects | null>(null);
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
            ? {
                required: config.defaultOn === true,
                migration: config.migrationEnabled === true
              }
            : null
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [preferenceApi]);

  // Default-on encrypts existing projects by itself (automaticMigration);
  // otherwise screen 3 offers the same Phase 7 run Settings starts.
  const offerExisting = projects?.migration === true && !projects.required;
  const counting = step === 'projects' && offerExisting && existing === null;
  useEffect(() => {
    if (step !== 'projects' || !offerExisting) return;
    let live = true;
    const controller = pageMigrationController(userId);
    const listed = controller.getState().running
      ? Promise.resolve()
      : controller.refresh();
    void listed
      .catch(() => undefined)
      .then(() => {
        if (!live) return;
        const state = controller.getState();
        setExisting({
          controller,
          ids: state.error
            ? []
            : state.projects
                .filter((project) => project.phase !== 'done')
                .map((project) => project.projectId)
        });
      });
    return () => {
      live = false;
    };
  }, [step, offerExisting, userId]);

  const steps: SetupStep[] = [
    'intro',
    'save',
    ...(projects && !skipProjectsStep ? (['projects'] as const) : [])
  ];
  const offerPasskey = prf !== 'unsupported';
  const confirmByTyping = !passkeyMade;

  const end = () => {
    if (keySaved) onComplete?.();
    onClose();
  };
  const afterSave = () => {
    setError(null);
    setKeySaved(true);
    if (steps.includes('projects')) setStep('projects');
    else {
      onComplete?.();
      onClose();
    }
  };

  /**
   * Screen 1's passkey step. The passkey is created first, inside the click,
   * so nothing is committed if it is cancelled; then the keys are set up
   * and the passkey enrolled with the recovery secret in memory.
   */
  const continueWithPasskey = () =>
    void run(
      async () => {
        if (!recovery) return;
        setFallback(null);
        let created: PasskeySecret;
        try {
          created = await (ctx.passkeys ?? browserPasskeys).create();
        } catch (caught) {
          // Nothing was committed: the recovery-key-only path, unchanged.
          setFallback(passkeyProblem(caught));
          setStep('save');
          return;
        }
        try {
          let next: EncryptionState;
          try {
            next = await setUpEncryption(ctx, {
              recoverySecret: recovery.secret,
              label: defaultDeviceLabel(navigator.userAgent)
            });
          } catch (caught) {
            // The credential exists but certifies nothing: say which one
            // to delete from the provider.
            throw created.enrollmentLabel
              ? failedPasskeyEnrollment(caught, created.enrollmentLabel)
              : caught;
          }
          setCommitted(true);
          if (next.kind !== 'ready') {
            setFallback('');
          } else {
            try {
              next = await addPasskey(
                { ...ctx, passkeys: createdPasskey(created) },
                next.account,
                recovery.secret
              );
              setPasskeyMade(true);
            } catch (caught) {
              // Keys exist with the recovery key as the only way in:
              // confirm it as a recovery-key-only setup does.
              setFallback(passkeyProblem(caught, created));
            }
          }
          setStep('save');
          return next;
        } finally {
          created.secret.fill(0);
        }
      },
      { onError: setError }
    );

  const lastGroupMatches = () => {
    if (!recovery || !confirmByTyping) return true;
    const matches =
      normalizedGroup(typed) ===
      normalizedGroup(lastRecoveryGroup(recovery.formatted));
    setMismatch(!matches);
    return matches;
  };

  /** Screen 2's Continue: the key saved, and typed back where asked. */
  const confirmSaved = () => {
    if (!recovery || !saved || !lastGroupMatches()) return;
    if (committed) {
      afterSave();
      return;
    }
    void run(
      async () => {
        const next = await setUpEncryption(ctx, {
          recoverySecret: recovery.secret,
          label: defaultDeviceLabel(navigator.userAgent)
        });
        setCommitted(true);
        afterSave();
        return next;
      },
      { onError: setError }
    );
  };

  /**
   * Saves the projects choice, starts encrypting the existing projects if
   * ticked, then leaves. Only after the save succeeds, so a failure is said
   * here instead of in a dialog that has already gone (review finding).
   */
  const finish = () =>
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
        const started =
          offerExisting && encryptExisting && existing?.ids.length
            ? existing
            : null;
        if (started) {
          // The page's own controller: Settings' "Encrypt existing
          // projects" shows its progress, pause and errors.
          void started.controller.run(started.ids).catch(() => undefined);
        }
        onComplete?.();
        if (started && onEncryptExisting) onEncryptExisting();
        else onClose();
      },
      { onError: setError }
    );

  // Keys without a saved recovery key must not be left behind by a stray
  // Escape: screen 2 stays until it is confirmed.
  const closable = !busy && !(step === 'save' && committed);
  const close = () => {
    if (closable) end();
  };

  if (!recovery || prf === null) return null;
  const title =
    step === 'intro'
      ? 'Turn on encryption'
      : step === 'save'
        ? 'Save your recovery key'
        : 'You’re set';

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
            {offerPasskey
              ? 'A passkey unlocks your other devices without typing, and a recovery key is your backup. Your browser may ask you to confirm twice.'
              : 'A recovery key unlocks your other devices and is your backup.'}
          </p>
          <p className="encryption-dialog-warning">{LOSS_SENTENCE}</p>
        </>
      );
      footer = (
        <>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          {offerPasskey ? (
            <>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setFallback(null);
                  setStep('save');
                }}
              >
                Use a recovery key only
              </button>
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={continueWithPasskey}
              >
                <Fingerprint size={14} aria-hidden="true" />
                Continue with passkey
              </button>
            </>
          ) : (
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setStep('save');
              }}
            >
              <KeyRound size={14} aria-hidden="true" />
              Continue
            </button>
          )}
        </>
      );
      break;
    case 'save':
      body = (
        <>
          {passkeyMade ? (
            <p>
              <strong>Your passkey is ready.</strong> Save your recovery key
              too: it’s your backup if the passkey is lost.
            </p>
          ) : null}
          {fallback !== null ? (
            <p className="encryption-dialog-warning" role="status">
              No passkey was added. {fallback}
              {committed
                ? ' Encryption is on with your recovery key; you can add a passkey later in Settings › Encryption.'
                : ' Go back to try again, or continue with a recovery key only.'}
            </p>
          ) : null}
          <SaveKeyStep
            recovery={recovery}
            saved={saved}
            hideLastGroup={confirmByTyping && saved}
            onSaved={(next) => {
              setSaved(next);
              setMismatch(false);
            }}
          />
          {confirmByTyping && saved ? (
            <LastGroupField
              typed={typed}
              mismatch={mismatch}
              onTyped={(text) => {
                setTyped(text);
                setMismatch(false);
              }}
              onSubmit={confirmSaved}
            />
          ) : null}
        </>
      );
      footer = (
        <>
          {committed ? null : (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setStep('intro');
              }}
            >
              Back
            </button>
          )}
          <button
            className="primary"
            type="button"
            disabled={
              busy || !saved || (confirmByTyping && typed.trim() === '')
            }
            onClick={confirmSaved}
          >
            {committed ? 'Continue' : 'Turn on encryption'}
          </button>
        </>
      );
      break;
    case 'projects':
      body = (
        <>
          <p>
            Encryption is on. Choose what to encrypt; you can change it later.
          </p>
          {projects?.required ? (
            <p>This server encrypts every new cloud project.</p>
          ) : (
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
          )}
          {projects?.required && projects.migration ? (
            <p>
              Your existing cloud projects are encrypted next, in this tab.
              Settings › Encryption shows their progress.
            </p>
          ) : offerExisting && existing && existing.ids.length > 0 ? (
            <label className="encryption-acknowledge">
              <input
                type="checkbox"
                checked={encryptExisting}
                onChange={(event) => setEncryptExisting(event.target.checked)}
              />
              <span>
                <strong>
                  Encrypt my {existing.ids.length} existing cloud{' '}
                  {existing.ids.length === 1 ? 'project' : 'projects'}
                </strong>{' '}
                (keep this tab open while it runs)
              </span>
            </label>
          ) : counting ? (
            <p role="status">Checking your existing cloud projects…</p>
          ) : !offerExisting ? (
            <p>
              Projects you already have stay as they are until you encrypt them.
            </p>
          ) : null}
        </>
      );
      footer = (
        <button
          className="primary"
          type="button"
          disabled={busy || counting}
          onClick={finish}
        >
          Done
        </button>
      );
      break;
  }

  return (
    <EncryptionDialog
      title={title}
      step={{ at: steps.indexOf(step) + 1, of: steps.length }}
      busy={!closable}
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
