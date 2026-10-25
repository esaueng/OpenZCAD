import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType
} from 'react';
import { RefreshCcw, ShieldCheck } from 'lucide-react';
import { parseRecoveryKey, toHex, type Bytes } from '@openzcad/crypto';
import {
  EncryptionFlowError,
  type AccountView,
  type E2eeContext,
  type UnlockAuthorization
} from '../lib/e2ee/accountKeys';
import {
  ContactsError,
  contactScanText,
  contactsContext,
  inspectContact,
  loadContacts,
  ownVerificationCode,
  parseContactScan,
  recordKeyChange,
  untrustContact,
  verifyContact,
  type ContactStanding,
  type ContactView,
  type ContactsBook
} from '../lib/e2ee/contacts';
import { E2eeApiError } from '../lib/e2ee/e2eeApi';
import {
  notifyContactsChanged,
  subscribeContactVerification,
  subscribeContactsChanged,
  takeContactVerificationRequest
} from '../lib/e2ee/contactFocus';
import { PasskeyError, passkeysAvailable } from '../lib/e2ee/passkeys';
import { encodeQr, qrSvgPath } from '../lib/e2ee/qrCode';
import { Group, Notice, SettingRow, Status } from './settingsControls';

/**
 * Settings › Encryption › Contacts (ADR-024 Phase 5, slice 5-1): the people
 * this account shares a project or an invitation with, whether each one is
 * verified, seen or changed, and the mutual comparison that verifies them.
 * Both people read their own 40-digit code (or scan each other's QR code);
 * each side checks the other's against what OpenZCAD shows, then signs the
 * verification into their contacts list with a passkey or the recovery key.
 */
export function EncryptionContacts({
  keys,
  account,
  Scanner
}: {
  keys: E2eeContext;
  account: AccountView;
  /** The camera QR scanner of Settings › Encryption, where available. */
  Scanner?: ComponentType<{ onCode(code: string): void }>;
}) {
  const ctx = useMemo(() => contactsContext(keys), [keys]);
  const [book, setBook] = useState<ContactsBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ContactView | null>(null);
  const [own, setOwn] = useState<{ hash: Bytes; code: string } | null>(null);
  const accountKey = toHex(account.list.headHash);

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        return true;
      } catch (caught) {
        if (keys.isCurrent?.() === false) return false;
        setError(messageFor(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [keys]
  );

  const reload = useCallback(
    () =>
      run(async () => {
        setBook(await loadContacts(ctx, account));
      }),
    // The account view changes with every device-list head.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, run, accountKey]
  );

  useEffect(() => {
    void reload();
    void ownVerificationCode(account).then(setOwn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  // A Verify action elsewhere (the sharing dialog, an invitation) opens
  // that person's comparison here once the contacts have loaded. The book
  // is read again first: an invitation accepted since it loaded relates
  // someone it does not list yet (decision M2).
  const loaded = book !== null;
  useEffect(() => {
    if (!loaded) return;
    const open = () => {
      const userId = takeContactVerificationRequest();
      if (!userId) return;
      void run(async () => {
        const fresh = await loadContacts(ctx, account);
        setBook(fresh);
        setView(await inspectContact(ctx, fresh, userId));
      });
    };
    open();
    const stopRequests = subscribeContactVerification(open);
    // Someone accepted or verified elsewhere on this page: read it again.
    const stopChanges = subscribeContactsChanged(() => void reload());
    return () => {
      stopRequests();
      stopChanges();
    };
    // The account view changes with every device-list head.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, ctx, run, reload]);

  const canUsePasskey =
    passkeysAvailable() &&
    account.list.unlockTargets.some((target) => target.kind === 'passkey');
  const verified =
    book?.contacts.filter((contact) => contact.standing === 'verified')
      .length ?? 0;

  return (
    <>
      <Group title="Contacts" note={book ? `${verified} verified` : undefined}>
        {error ? (
          <Notice
            tone="warning"
            role="alert"
            action={
              <button
                className="secondary"
                type="button"
                onClick={() => void reload()}
              >
                <RefreshCcw size={13} aria-hidden="true" />
                Retry
              </button>
            }
          >
            {error}
          </Notice>
        ) : null}
        <SettingRow
          title="Your contact code"
          hint="People who verify you compare this with you. It changes when you add or remove a device."
        >
          {own ? (
            <ContactCode
              label="Your contact code"
              code={own.code}
              hash={own.hash}
            />
          ) : null}
        </SettingRow>
        {book && book.contacts.length === 0 ? (
          <SettingRow
            title="No contacts yet"
            hint="People you share a project or an invitation with appear here."
          />
        ) : null}
        {book?.contacts.map((contact) => (
          <SettingRow
            key={contact.userId}
            title={contact.email ?? contact.userId}
            hint={STANDING_HINTS[contact.standing]}
          >
            <div className="encryption-actions">
              <StandingBadge standing={contact.standing} />
              <button
                className="secondary"
                type="button"
                disabled={busy}
                aria-label={`${contact.standing === 'verified' ? 'Check' : 'Verify'} ${contact.email ?? contact.userId}`}
                onClick={() =>
                  void run(async () => {
                    setView(await inspectContact(ctx, book, contact.userId));
                  })
                }
              >
                <ShieldCheck size={14} aria-hidden="true" />
                {contact.standing === 'verified' ? 'Check' : 'Verify'}
              </button>
            </div>
          </SettingRow>
        ))}
      </Group>
      {view && book && own ? (
        <ContactPanel
          view={view}
          own={own}
          busy={busy}
          canUsePasskey={canUsePasskey}
          Scanner={Scanner}
          onClose={() => setView(null)}
          onSign={(action, authorization) =>
            run(async () => {
              const next =
                action === 'verify'
                  ? await verifyContact(ctx, account, book, view, authorization)
                  : action === 'key-changed'
                    ? await recordKeyChange(
                        ctx,
                        account,
                        book,
                        view.userId,
                        authorization
                      )
                    : await untrustContact(
                        ctx,
                        account,
                        book,
                        view.userId,
                        authorization
                      );
              setBook(next);
              setView(await inspectContact(ctx, next, view.userId));
              notifyContactsChanged();
            })
          }
        />
      ) : null}
    </>
  );
}

const STANDING_HINTS: Record<ContactStanding, string> = {
  verified: 'Verified: you compared codes with them.',
  'key-changed': 'Their key changed. Compare codes again before sharing.',
  untrusted: 'You stopped trusting their key.',
  seen: 'Seen, not verified. Compare codes before sharing.',
  'not-checked': 'Not checked yet.'
};

function StandingBadge({ standing }: { standing: ContactStanding }) {
  switch (standing) {
    case 'verified':
      return <Status tone="good">Verified</Status>;
    case 'key-changed':
      return <Status tone="warning">Key changed</Status>;
    case 'untrusted':
      return <Status tone="warning">Not trusted</Status>;
    case 'seen':
      return <Status tone="warning">Seen</Status>;
    default:
      return null;
  }
}

function messageFor(error: unknown): string {
  if (
    error instanceof ContactsError ||
    error instanceof EncryptionFlowError ||
    error instanceof E2eeApiError ||
    error instanceof PasskeyError
  ) {
    if (error instanceof E2eeApiError && error.status === 503) {
      return 'Contacts are unavailable until the service is updated.';
    }
    return error.message;
  }
  if (error instanceof Error && error.name === 'E2eeError') {
    return `The keys did not verify: ${error.message}`;
  }
  return 'Contacts are unavailable right now. Check your connection and try again.';
}

/** A code people compare: digit groups, with its QR form one click away. */
function ContactCode({
  label,
  code,
  hash
}: {
  label: string;
  code: string;
  hash: Bytes;
}) {
  const [showQr, setShowQr] = useState(false);
  const { path, size } = useMemo(
    () => qrSvgPath(encodeQr(contactScanText(hash))),
    [hash]
  );
  return (
    <div className="encryption-scan">
      <code className="encryption-code" aria-label={label}>
        {code}
      </code>
      {showQr ? (
        <svg
          className="encryption-qr"
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label} as a QR code`}
          shapeRendering="crispEdges"
        >
          <rect width={size} height={size} fill="#fff" />
          <path d={path} fill="#000" />
        </svg>
      ) : null}
      <button
        className="secondary"
        type="button"
        onClick={() => setShowQr(!showQr)}
      >
        {showQr ? 'Hide QR code' : 'Show QR code'}
      </button>
    </div>
  );
}

type SignAction = 'verify' | 'key-changed' | 'untrust';

function ContactPanel({
  view,
  own,
  busy,
  canUsePasskey,
  Scanner,
  onClose,
  onSign
}: {
  view: ContactView;
  own: { hash: Bytes; code: string };
  busy: boolean;
  canUsePasskey: boolean;
  Scanner?: ComponentType<{ onCode(code: string): void }>;
  onClose(): void;
  onSign(
    action: SignAction,
    authorization: UnlockAuthorization
  ): Promise<boolean>;
}) {
  const name = view.email ?? view.userId;
  const [confirming, setConfirming] = useState<SignAction | null>(null);
  const [scan, setScan] = useState('');
  const [scanResult, setScanResult] = useState<'match' | 'mismatch' | null>(
    null
  );
  const checkScan = (text: string) => {
    const scanned = parseContactScan(text);
    setScanResult(
      scanned && view.codeHash && toHex(scanned) === toHex(view.codeHash)
        ? 'match'
        : 'mismatch'
    );
  };
  return (
    <Group title={`Verify ${name}`}>
      {view.keyChanged ? (
        <Notice tone="warning" role="alert">
          {name}’s key changed. They are not verified, and nothing new is shared
          with them, until you compare codes again.
        </Notice>
      ) : null}
      {view.status === 'no-keys' ? (
        <Notice tone="info">
          {name} has not set up encryption yet, so there is nothing to compare.
        </Notice>
      ) : (
        <>
          <Notice tone="info">
            Compare both codes with {name} in person or on a call: they read
            theirs, you read yours. Verify only if both match.
          </Notice>
          <SettingRow
            title="Their code"
            hint={
              view.status === 'verified'
                ? 'Verified. It changes when they add or remove a device.'
                : 'What OpenZCAD received for them. It must match what they read to you.'
            }
          >
            {view.code && view.codeHash ? (
              <ContactCode
                label={`${name}’s contact code`}
                code={view.code}
                hash={view.codeHash}
              />
            ) : null}
          </SettingRow>
          <SettingRow
            title="Your code"
            hint="Read this to them, so they can verify you in the same call."
          >
            <code className="encryption-code" aria-label="Your code to read">
              {own.code}
            </code>
          </SettingRow>
          <SettingRow
            title="Scan their QR code"
            hint="Scan the QR code on their screen, or paste what a scanner read."
          >
            <div className="encryption-scan-entry">
              {Scanner ? (
                <Scanner
                  onCode={(code) => {
                    setScan(code);
                    checkScan(code);
                  }}
                />
              ) : null}
              <input
                className="settings-text-wide"
                value={scan}
                aria-label="Scanned contact code"
                autoComplete="off"
                spellCheck={false}
                placeholder="OZC1:…"
                onChange={(event) => {
                  setScan(event.target.value);
                  setScanResult(null);
                }}
              />
              <button
                className="secondary"
                type="button"
                disabled={scan.trim() === ''}
                onClick={() => checkScan(scan)}
              >
                Compare
              </button>
              {scanResult === 'match' ? (
                <Status tone="good">QR codes match</Status>
              ) : scanResult === 'mismatch' ? (
                <Status tone="warning">QR codes do not match</Status>
              ) : null}
            </div>
          </SettingRow>
        </>
      )}
      {confirming ? (
        <AuthorizeSignature
          title={
            confirming === 'verify'
              ? `Verify ${name}`
              : confirming === 'key-changed'
                ? `Record ${name}’s key change`
                : `Stop trusting ${name}`
          }
          actionLabel={
            confirming === 'verify'
              ? 'Verify contact'
              : confirming === 'key-changed'
                ? 'Record key change'
                : 'Stop trusting'
          }
          busy={busy}
          canUsePasskey={canUsePasskey}
          onCancel={() => setConfirming(null)}
          onAuthorize={async (authorization) => {
            if (await onSign(confirming, authorization)) setConfirming(null);
          }}
        />
      ) : (
        <div className="settings-button-row">
          {view.list && view.status !== 'verified' ? (
            <button
              className="primary"
              type="button"
              disabled={busy || scanResult === 'mismatch'}
              onClick={() => setConfirming('verify')}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              Codes match — verify
            </button>
          ) : null}
          {view.keyChangeUnsigned ? (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setConfirming('key-changed')}
            >
              Record key change
            </button>
          ) : null}
          {view.status === 'verified' ? (
            <button
              className="secondary danger"
              type="button"
              disabled={busy}
              onClick={() => setConfirming('untrust')}
            >
              Stop trusting
            </button>
          ) : null}
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      )}
    </Group>
  );
}

/** A recovery key or a passkey opens the identity key for one signature. */
function AuthorizeSignature({
  title,
  actionLabel,
  busy,
  canUsePasskey,
  onCancel,
  onAuthorize
}: {
  title: string;
  actionLabel: string;
  busy: boolean;
  canUsePasskey: boolean;
  onCancel(): void;
  onAuthorize(authorization: UnlockAuthorization): Promise<void>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="encryption-approve" aria-label={title} role="group">
      {error ? (
        <Notice tone="warning" role="alert">
          {error}
        </Notice>
      ) : null}
      <SettingRow
        title="Recovery key to confirm"
        hint="Opens your identity key to sign your contacts list, then it is forgotten."
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
          className="primary"
          type="button"
          disabled={busy || text.trim() === ''}
          onClick={() =>
            void (async () => {
              setError(null);
              let secret: Bytes;
              try {
                secret = await parseRecoveryKey(text);
              } catch {
                setError(
                  'That is not a recovery key. Check it for typos: it is 56 letters and digits in groups of four.'
                );
                return;
              }
              try {
                await onAuthorize(secret);
                setText('');
              } finally {
                secret.fill(0);
              }
            })()
          }
        >
          {actionLabel}
        </button>
        {canUsePasskey ? (
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => void onAuthorize('passkey')}
          >
            Confirm with passkey
          </button>
        ) : null}
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
