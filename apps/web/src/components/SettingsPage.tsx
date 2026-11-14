import { AnalyticsConsent, CloudStatisticsConsent } from './AnalyticsConsent';
import type { DeviceKeySignOutChoice } from '../lib/e2ee/signOut';
import {
  MIDDLE_DRAG_LABELS,
  POINTER_NAVIGATION_LABELS
} from '@openzcad/viewport/input-bindings';
import {
  Fragment,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent
} from 'react';
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  CloudOff,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  HardDrive,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  Mouse,
  Move3d,
  Palette,
  PencilRuler,
  RefreshCcw,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound
} from 'lucide-react';
import {
  anthropicThinkingOffType,
  CLOUD_AUTOSAVE_DELAY_BOUNDS,
  VIEWPORT_FIELD_OF_VIEW_BOUNDS,
  XRAY_OPACITY_BOUNDS,
  displayLengthName,
  type AccountDeletionScope,
  type AccountStorageUsage,
  type AppSettings,
  type AppSettingsResponse,
  type AuthConfigResponse,
  type AuthSession,
  type HealthResponse,
  type UnitSystem
} from '@openzcad/shared';
import { countLabel } from '../lib/toasts';
import { formatBytes } from '../lib/formatBytes';
import { fetchEncryptionAvailability } from '../lib/e2ee/availability';
import {
  loadAccountShapeHint,
  rememberAccountShape
} from '../lib/accountShapeHint';
import { lazyWithStaleChunkNotice } from '../lib/staleChunk';
import { ErrorBoundary } from './ErrorBoundary';
import { BrandMark } from './BrandMark';
import { ExternalAnchor } from './ExternalAnchor';
import { AssistantConnectionSettings } from './AssistantConnectionSettings';
import { api } from '../lib/api';
import { APP_SETTINGS_NUMBER_BOUNDS } from '../lib/appSettings';
import { isDesktopApp } from '../lib/desktopBridge';
import { privacyPolicyHref } from '../lib/privacyPolicy';
import {
  KERNEL_BUILD,
  kernelBuildDetail,
  kernelBuildLabel
} from '../lib/kernelBuild';
import {
  visibleSettingsSections,
  type SettingsSectionId
} from '../lib/settingsSections';
import {
  loadSettingsViewState,
  updateSettingsViewState
} from '../lib/settingsViewState';
import {
  KEYBOARD_CONTROL_GROUPS,
  POINTER_CONTROL_GROUPS,
  type ControlReferenceGroup
} from '../lib/controlReference';
import { KeymapEditor } from './KeymapEditor';
import { RelationGlyphFilter } from './RelationGlyphFilter';
import { resolveKeymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';
import {
  Group,
  Meter,
  Notice,
  NumberSetting,
  Section,
  Segmented,
  SettingRow,
  Status,
  Toggle,
  type SegmentOption
} from './settingsControls';
import {
  SpaceMousePreferenceRows,
  SpaceMouseSettings
} from './SpaceMouseSettings';
import { SPACE_MOUSE_KEY_REFERENCE } from '../lib/spaceMouseActions';
import { CloudDataDeletionDialog } from './CloudDataDeletionDialog';
import { describeFailure } from '../lib/plainFailure';
import { DataDownload } from './DataDownload';
import { ActivityLogSettings } from './ActivityLogSettings';
import {
  PrivateEmailInput,
  PrivateText,
  setPersonalInfoVisible,
  usePersonalInfoVisible
} from './PersonalInfo';

/**
 * The parts of the one storage allowance. Older servers (and the e2e stubs)
 * may omit them; an absent part reads as nothing stored.
 */
function storageParts(usage: AccountStorageUsage): {
  projects: number;
  files: number;
} {
  const partial = usage as Partial<AccountStorageUsage>;
  return {
    projects: partial.projectStorageBytes ?? 0,
    // Uploads in flight hold their room, so they read as files.
    files: (partial.artifactBytes ?? 0) + (partial.artifactReservedBytes ?? 0)
  };
}

/**
 * Everything the account stores, against its one allowance: project storage
 * and finalized files. Older servers send only the two parts.
 */
function storedBytes(usage: AccountStorageUsage): number {
  const { projects, files } = storageParts(usage);
  return usage.storageBytes ?? projects + files;
}

/** What the one storage allowance is made of, and what it holds. */
function storageHint(usage: AccountStorageUsage | null): string {
  if (!usage) {
    return 'Projects, save states, imports and exports saved to your account.';
  }
  const { projects, files } = storageParts(usage);
  const trashed = usage.trashedProjectCount ?? 0;
  const counts = [
    countLabel(usage.projectCount, 'project', 'projects'),
    ...(trashed > 0 ? [`${trashed.toLocaleString()} in trash`] : []),
    countLabel(usage.revisionCount, 'save state', 'save states')
  ].join(' · ');
  return `Projects ${formatBytes(projects)} · Imports and exports ${formatBytes(files)}. ${counts}.`;
}

/**
 * Usage against an allowance, naming an overage outright. The meter names the
 * ceiling even before anyone is near it: a limit discovered only at the
 * moment a save is refused reads as a bug; one stated up front reads as a
 * limit.
 */
function allowanceFigure(usedBytes: number, limitBytes: number): string {
  const figure = `${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}`;
  return usedBytes > limitBytes ? `${figure} · over allowance` : figure;
}

type SectionId = SettingsSectionId;

interface SettingsPageProps {
  settings: AppSettings;
  cloudFunctionsEnabled: boolean;
  accountState: AppSettingsResponse | null;
  authConfig: AuthConfigResponse | null;
  authConfigStatus: AuthConfigStatus;
  /**
   * The saved session (and, once signed in, the account's settings) is still
   * being restored. Distinct from signed out: nothing account-shaped is
   * guessed while this is true, and no sign-in form is offered.
   */
  accountResolving?: boolean;
  health: HealthResponse | null;
  session: AuthSession | null;
  busy: boolean;
  message: string;
  initialSection?: SectionId;
  projectInvitationPending?: boolean;
  projectInvitationError?: string | null;
  desktopAuthorizationAttempt?: string | null;
  desktopAuthorizationApproved?: boolean;
  desktopAuthorizationCode?: string;
  /**
   * Whether a project's workspace sits behind Settings. From the start screen
   * there is no view to apply defaults to and no workspace to go back to.
   */
  workspaceOpen?: boolean;
  /**
   * The open project's units, which the linear snap is measured in; absent
   * from the start screen, where each project's own units apply.
   */
  documentUnits?: UnitSystem;
  onChange(settings: AppSettings): void;
  onCloudFunctionsEnabledChange(enabled: boolean): void;
  onSaveCredential(token: string): void;
  onDeleteCredential(): void;
  onTestAssistant(): void;
  onRequestLoginCode(
    email: string,
    turnstileToken: string
  ): Promise<{ challengeId: string; expiresInSeconds: number }>;
  onVerifyLoginCode(challengeId: string, code: string): Promise<void>;
  onRefreshAuthConfig(): Promise<void>;
  onStartDesktopLogin(): Promise<void>;
  onDesktopAuthorizationCodeChange(code: string): void;
  onApproveDesktopLogin(): Promise<void>;
  onLogout(choice: DeviceKeySignOutChoice): Promise<void>;
  onDeleteCloudData(
    scope: AccountDeletionScope,
    confirmation: string
  ): Promise<void>;
  onReset(): void;
  onApplyViewportDefaults(): void;
  /**
   * Support exports, kept out of the File menu: a sanitized snapshot of the
   * open project, and this device's log of direct-edit attempts.
   */
  onExportDiagnostics(): void;
  onExportInteractionLog(): void;
  onDismissProjectInvitation(): void;
  onClose(): void;
}

/** How long after a sign-in code is sent a new one can be asked for. */
const LOGIN_CODE_RESEND_DELAY_MS = 30_000;

export type AuthConfigStatus = 'loading' | 'ready' | 'unavailable';

/**
 * End-to-end encryption keys load with their crypto only when the section
 * opens, so neither reaches the Settings chunk or the entry chunk.
 */
const EncryptionSettings = lazyWithStaleChunkNotice(() =>
  import('./EncryptionSettings').then((module) => ({
    default: module.EncryptionSettings
  }))
);

const SECTION_ICONS: Record<SectionId, ReactNode> = {
  general: <Settings2 size={15} aria-hidden="true" />,
  appearance: <Palette size={15} aria-hidden="true" />,
  viewport: <Move3d size={15} aria-hidden="true" />,
  controls: <Mouse size={15} aria-hidden="true" />,
  sketching: <PencilRuler size={15} aria-hidden="true" />,
  saving: <HardDrive size={15} aria-hidden="true" />,
  account: <UserRound size={15} aria-hidden="true" />,
  encryption: <ShieldCheck size={15} aria-hidden="true" />,
  assistant: <Bot size={15} aria-hidden="true" />,
  privacy: <LockKeyhole size={15} aria-hidden="true" />,
  activity: <ScrollText size={15} aria-hidden="true" />,
  advanced: <Cpu size={15} aria-hidden="true" />
};

/**
 * The keyboard reference without its remappable items, which the keymap
 * editor lists with their live keys: what is left keeps one meaning always.
 */
const FIXED_KEYBOARD_GROUPS: readonly ControlReferenceGroup[] =
  KEYBOARD_CONTROL_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !('commands' in item))
  })).filter((group) => group.items.length > 0);

/**
 * The keyboard and pointer reference: keys and the action they run. Each
 * binding's longer explanation is one Details press away rather than a
 * second line on every row, so the reference scans as a list of keys. A
 * tooltip alone left it out of reach by touch and by keyboard.
 */
function ControlReferenceGroups({
  groups
}: {
  groups: readonly ControlReferenceGroup[];
}) {
  return (
    <div className="settings-control-groups">
      {groups.map((group) => (
        <ControlReferenceGroupCard group={group} key={group.id} />
      ))}
    </div>
  );
}

function ControlReferenceGroupCard({
  group
}: {
  group: ControlReferenceGroup;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const listId = useId();
  return (
    <section className="settings-control-group">
      <header>
        <h4>{group.title}</h4>
        <button
          type="button"
          className="settings-details-toggle"
          aria-expanded={showDetails}
          aria-controls={listId}
          // The name stays put; aria-expanded carries the state.
          aria-label={`Details for ${group.title}`}
          onClick={() => setShowDetails((current) => !current)}
        >
          Details
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </header>
      <dl id={listId}>
        {group.items.map((item) => (
          <div
            className="settings-control-row"
            key={item.id}
            title={showDetails ? undefined : item.detail}
          >
            <dt>
              <span className="settings-control-keys">
                {item.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </dt>
            {showDetails ? (
              <dd>
                <strong>{item.action}</strong>
                <small>{item.detail}</small>
              </dd>
            ) : (
              <dd>{item.action}</dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}

const UNIT_OPTIONS: readonly SegmentOption<
  AppSettings['general']['defaultUnits']
>[] = [
  { value: 'mm', label: 'mm', title: 'Millimeters' },
  { value: 'cm', label: 'cm', title: 'Centimeters' },
  { value: 'm', label: 'm', title: 'Meters' },
  { value: 'inch', label: 'in', title: 'Inches' }
];

const THEME_OPTIONS: readonly SegmentOption<
  AppSettings['appearance']['theme']
>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

const DENSITY_OPTIONS: readonly SegmentOption<
  AppSettings['appearance']['density']
>[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' }
];

const LIBRARY_CARD_SIZE_OPTIONS: readonly SegmentOption<
  AppSettings['appearance']['libraryCardSize']
>[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' }
];

const PROJECTION_OPTIONS: readonly SegmentOption<
  AppSettings['viewport']['defaultProjection']
>[] = [
  { value: 'perspective', label: 'Perspective' },
  { value: 'orthographic', label: 'Orthographic' }
];

const DISPLAY_OPTIONS: readonly SegmentOption<
  AppSettings['viewport']['displayMode']
>[] = [
  { value: 'shaded-edges', label: 'Shaded + edges' },
  { value: 'shaded', label: 'Shaded' },
  { value: 'wireframe', label: 'Wireframe' }
];

const TANGENT_EDGE_OPTIONS: readonly SegmentOption<
  AppSettings['viewport']['tangentEdges']
>[] = [
  { value: 'show', label: 'Show' },
  { value: 'faint', label: 'Faint' },
  { value: 'hide', label: 'Hide' }
];

const RELATION_GLYPH_OPTIONS: readonly SegmentOption<
  AppSettings['sketching']['relationGlyphs']
>[] = [
  { value: 'always', label: 'Always' },
  { value: 'selected', label: 'Selected' },
  { value: 'hidden', label: 'Hidden' }
];

const SCROLL_OPTIONS: readonly SegmentOption<
  AppSettings['viewport']['pointerNavigation']
>[] = [
  // "Auto" in the control; the full name stays the accessible one.
  { value: 'auto', label: 'Auto', title: POINTER_NAVIGATION_LABELS.auto },
  { value: 'mouse', label: 'Mouse', title: POINTER_NAVIGATION_LABELS.mouse },
  { value: 'trackpad', label: POINTER_NAVIGATION_LABELS.trackpad }
];

const MIDDLE_DRAG_OPTIONS: readonly SegmentOption<
  AppSettings['viewport']['middleDrag']
>[] = (['pan', 'orbit', 'zoom'] as const).map((value) => ({
  value,
  label: MIDDLE_DRAG_LABELS[value]
}));

const ORBIT_MODE_OPTIONS: readonly SegmentOption<
  AppSettings['viewport']['orbitMode']
>[] = [
  { value: 'free', label: 'Free' },
  { value: 'turntable', label: 'Turntable' }
];

const DELETION_OPTIONS: readonly SegmentOption<AccountDeletionScope>[] = [
  { value: 'projects', label: 'Projects' },
  { value: 'profile', label: 'Profile' },
  { value: 'all', label: 'Everything' }
];

/** What each deletion removes, so the choice explains itself as it changes. */
const DELETION_SCOPES: Record<
  AccountDeletionScope,
  { title: string; hint: string; action: string; needsProjects: boolean }
> = {
  projects: {
    title: 'Delete all cloud projects',
    hint: 'Every project you own, with its revisions and files. Your profile stays.',
    action: 'Delete projects',
    needsProjects: true
  },
  profile: {
    title: 'Delete cloud profile',
    hint: 'Your profile, synced settings, AI credential and sessions. Projects stay, owned anonymously.',
    action: 'Delete profile',
    needsProjects: false
  },
  all: {
    title: 'Delete all cloud data',
    hint: 'Profile and every project. Collaborators lose access.',
    action: 'Delete all data',
    needsProjects: true
  }
};

/**
 * Settings › Privacy & data › Delete cloud data: one choice of what to delete
 * and one button, rather than three rows of near-identical warnings. The
 * dialog behind the button still confirms before anything is removed.
 */
function CloudDeletion({
  health,
  busy,
  onDelete
}: {
  health: HealthResponse | null;
  busy: boolean;
  onDelete(scope: AccountDeletionScope): void;
}) {
  const [scope, setScope] = useState<AccountDeletionScope>('projects');
  const chosen = DELETION_SCOPES[scope];
  const serverReady = health?.accountErasureReady === true;
  const ready =
    serverReady &&
    (!chosen.needsProjects || health?.projectErasureReady === true);
  return (
    <Group title="Delete cloud data" tone="danger">
      {!serverReady ? (
        <Notice>Cloud data deletion isn’t available on this server yet.</Notice>
      ) : !ready ? (
        <Notice>
          Project deletion is unavailable until storage cleanup is ready.
          Profile-only deletion remains available.
        </Notice>
      ) : null}
      <SettingRow title="What to delete">
        <Segmented
          label="What to delete"
          value={scope}
          options={DELETION_OPTIONS}
          onChange={(next) => setScope(next)}
        />
      </SettingRow>
      <SettingRow title={chosen.title} hint={`${chosen.hint} Can’t be undone.`}>
        <button
          className="secondary danger"
          type="button"
          disabled={busy || !ready}
          onClick={() => onDelete(scope)}
        >
          <Trash2 size={14} aria-hidden="true" />
          {chosen.action}
        </button>
      </SettingRow>
    </Group>
  );
}

function providerDefaults(provider: AppSettings['assistant']['provider']) {
  if (provider === 'openai') {
    return { model: 'gpt-6-luna', baseUrl: '' };
  }
  if (provider === 'anthropic') {
    return { model: 'claude-sonnet-5-5', baseUrl: '' };
  }
  if (provider === 'openrouter') {
    return { model: 'openai/gpt-6-luna', baseUrl: '' };
  }
  return { model: '', baseUrl: '' };
}

type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      size: 'normal' | 'compact';
      callback(token: string): void;
      'expired-callback'(): void;
      'error-callback'(): void;
    }
  ): string;
  remove(widgetId: string): void;
  reset(widgetId: string): void;
};

type TurnstileState = 'loading' | 'ready' | 'verified' | 'expired' | 'error';

function TurnstileWidget({
  siteKey,
  resetSignal,
  onToken
}: {
  siteKey: string;
  resetSignal: number;
  onToken(token: string): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [state, setState] = useState<TurnstileState>('loading');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [size, setSize] = useState<'normal' | 'compact' | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () =>
      setSize(
        container.getBoundingClientRect().width < 300 ? 'compact' : 'normal'
      );
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(container);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    if (!size) return;
    let disposed = false;
    setState('loading');
    onToken('');
    const renderWidget = () => {
      const turnstile = (window as typeof window & { turnstile?: TurnstileApi })
        .turnstile;
      if (
        disposed ||
        !turnstile ||
        !containerRef.current ||
        widgetIdRef.current
      ) {
        return;
      }
      try {
        setState('ready');
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: 'email-code',
          size,
          callback: (token) => {
            if (disposed) return;
            onToken(token);
            setState('verified');
          },
          'expired-callback': () => {
            if (disposed) return;
            onToken('');
            setState('expired');
          },
          'error-callback': () => {
            if (disposed) return;
            onToken('');
            setState('error');
          }
        });
      } catch {
        onToken('');
        setState('error');
      }
    };
    let existing = document.querySelector<HTMLScriptElement>(
      'script[data-openzcad-turnstile]'
    );
    if (existing?.dataset.openzcadTurnstileState === 'error') {
      existing.remove();
      existing = null;
    }
    const script =
      existing ??
      Object.assign(document.createElement('script'), {
        src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        async: true,
        defer: true
      });
    script.dataset.openzcadTurnstile = 'true';
    const markScriptLoaded = () => {
      script.dataset.openzcadTurnstileState = 'loaded';
      renderWidget();
    };
    const markScriptFailed = () => {
      script.dataset.openzcadTurnstileState = 'error';
      onToken('');
      setState('error');
    };
    script.addEventListener('load', markScriptLoaded);
    script.addEventListener('error', markScriptFailed);
    if (!existing) {
      document.head.append(script);
    }
    renderWidget();
    return () => {
      disposed = true;
      script.removeEventListener('load', markScriptLoaded);
      script.removeEventListener('error', markScriptFailed);
      const turnstile = (window as typeof window & { turnstile?: TurnstileApi })
        .turnstile;
      if (widgetIdRef.current && turnstile) {
        turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [loadAttempt, onToken, siteKey, size]);

  useEffect(() => {
    const turnstile = (window as typeof window & { turnstile?: TurnstileApi })
      .turnstile;
    if (resetSignal > 0 && widgetIdRef.current && turnstile) {
      turnstile.reset(widgetIdRef.current);
      onToken('');
      setState('ready');
    }
  }, [onToken, resetSignal]);

  return (
    <div className="settings-turnstile-shell">
      <div
        className="settings-turnstile"
        data-action="turnstile-spin-v1"
        ref={containerRef}
      />
      <div
        className={`settings-challenge-state ${state}`}
        role={state === 'error' ? 'alert' : 'status'}
        aria-live="polite"
      >
        <span>
          {state === 'loading'
            ? 'Loading security check…'
            : state === 'ready'
              ? 'Security check ready.'
              : state === 'verified'
                ? 'Security check complete.'
                : state === 'expired'
                  ? 'Security check expired. Complete it again.'
                  : 'Security check could not load. Check content blockers or your connection.'}
        </span>
        {state === 'error' ? (
          <button
            className="secondary"
            type="button"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            <RefreshCcw size={13} aria-hidden="true" />
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The signed-in Profile rows' shape, without their values, while a reload
 * restores the session this device last had. Drawing the sign-in form here
 * instead flashed a signed-out page at someone who never signed out, and the
 * real rows then pushed everything below them down.
 */
function RestoringProfileRows() {
  return (
    <>
      <SettingRow
        title="Restoring your sign-in…"
        hint="Reconnecting the session saved on this device."
      >
        <button className="secondary" type="button" disabled>
          <LogOut size={14} aria-hidden="true" />
          Sign out
        </button>
      </SettingRow>
      <SettingRow
        title="Membership"
        hint="Limits appear after your account reconnects."
      >
        <Status>—</Status>
      </SettingRow>
    </>
  );
}

export function SettingsPage({
  settings,
  cloudFunctionsEnabled,
  accountState,
  authConfig,
  authConfigStatus,
  accountResolving = false,
  health,
  session,
  busy,
  message,
  initialSection,
  projectInvitationPending = false,
  projectInvitationError = null,
  desktopAuthorizationAttempt = null,
  desktopAuthorizationApproved = false,
  desktopAuthorizationCode = '',
  workspaceOpen = true,
  documentUnits,
  onChange,
  onCloudFunctionsEnabledChange,
  onSaveCredential,
  onDeleteCredential,
  onTestAssistant,
  onRequestLoginCode,
  onVerifyLoginCode,
  onRefreshAuthConfig,
  onStartDesktopLogin,
  onDesktopAuthorizationCodeChange,
  onApproveDesktopLogin,
  onLogout,
  onDeleteCloudData,
  onReset,
  onApplyViewportDefaults,
  onExportDiagnostics,
  onExportInteractionLog,
  onDismissProjectInvitation,
  onClose
}: SettingsPageProps) {
  // The save key as the user has it, for copy that tells them how to save.
  const saveChord = resolveKeymap(settings.keymap.overrides).label('file-save');
  const saveKeyCopy = saveChord ? ` (${platformShortcutLabel(saveChord)})` : '';
  const [initialViewState] = useState(loadSettingsViewState);
  const [active, setActive] = useState<SectionId>(
    initialSection ?? initialViewState.activeSection
  );
  const desktopApp = isDesktopApp();
  // A caller-specified section is a task flow (currently desktop auth), so it
  // must not be hidden by a search left over from ordinary Settings browsing.
  const [query, setQuery] = useState(
    initialSection === undefined ? initialViewState.query : ''
  );
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const personalInfoVisible = usePersonalInfoVisible();
  const [loginCode, setLoginCode] = useState('');
  // A refused code is said at the field, not only in the page's status
  // line beside the title (13 November review I4).
  const [loginCodeError, setLoginCodeError] = useState<string | null>(null);
  const [loginChallengeId, setLoginChallengeId] = useState<string | null>(null);
  const loginCodeRef = useRef<HTMLInputElement>(null);
  // A new code can be asked for a short while after the last one was sent,
  // so a slow email is not answered with a flood of codes (I81).
  const [resendReady, setResendReady] = useState(false);
  useEffect(() => {
    setResendReady(false);
    if (!loginChallengeId) return;
    const timer = window.setTimeout(
      () => setResendReady(true),
      LOGIN_CODE_RESEND_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [loginChallengeId]);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [storageUsage, setStorageUsage] = useState<AccountStorageUsage | null>(
    null
  );
  const [deletionScope, setDeletionScope] =
    useState<AccountDeletionScope | null>(null);
  /** Null until the server answers, so a restored Encryption view waits. */
  const [encryptionAvailable, setEncryptionAvailable] = useState<
    boolean | null
  >(null);
  // The account's last known shape on this device, read once: while a reload
  // restores the session, Settings draws that shape rather than a signed-out
  // guess that rearranges itself when the server answers.
  const [accountHint] = useState(loadAccountShapeHint);
  /**
   * Set, to the account it was opened for, while sign-out asks whether to
   * keep this device unlocked; it never applies to an account that replaced
   * that one before the choice was made.
   */
  const [signOutChoiceUserId, setSignOutChoiceUserId] = useState<string | null>(
    null
  );
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOutSessionRef = useRef(session);
  signOutSessionRef.current = session;
  const contentRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollTopRef = useRef(
    initialSection === undefined ? initialViewState.scrollTop : 0
  );
  const activeRef = useRef(active);
  const queryRef = useRef(query);

  activeRef.current = active;
  queryRef.current = query;
  const changeQuery = (nextQuery: string) => {
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    updateSettingsViewState({ query: nextQuery });
  };

  const persistCurrentView = () =>
    updateSettingsViewState({
      activeSection: activeRef.current,
      query: queryRef.current,
      scrollTop: scrollTopRef.current
    });

  // Fetched only when the panel that shows it is open, and dropped on sign-out
  // so one account's totals never linger in front of another.
  useEffect(() => {
    if (active !== 'account' || !session || !cloudFunctionsEnabled) {
      setStorageUsage(null);
      return;
    }
    let cancelled = false;
    void api
      .storageUsage()
      .then((usage) => {
        if (!cancelled) {
          setStorageUsage(usage);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, cloudFunctionsEnabled, session]);

  /** The owner's one storage allowance; older servers name it otherwise. */
  const storageEntitlements =
    storageUsage?.entitlements ?? session?.entitlements;
  const storageLimit =
    storageUsage?.storageLimitBytes ??
    storageEntitlements?.storageLimitBytes ??
    storageEntitlements?.projectStorageLimitBytes ??
    (storageUsage as Partial<AccountStorageUsage> | null)?.artifactLimitBytes;

  // The Encryption section exists only for an account the server opened the
  // beta to; asked once per signed-in account while Settings is open.
  const sessionUserId = session?.userId;
  // No session yet, but one may still be restoring: the answer is pending,
  // not no, so the Encryption item is neither dropped nor inserted meanwhile.
  const awaitingSession =
    cloudFunctionsEnabled && accountResolving && !sessionUserId;
  useEffect(() => {
    if (!sessionUserId || !cloudFunctionsEnabled) {
      setEncryptionAvailable(awaitingSession ? null : false);
      return;
    }
    setEncryptionAvailable(null);
    let cancelled = false;
    void fetchEncryptionAvailability().then((available) => {
      if (cancelled) return;
      setEncryptionAvailable(available);
      rememberAccountShape({ signedIn: true, encryption: available });
    });
    return () => {
      cancelled = true;
    };
  }, [awaitingSession, cloudFunctionsEnabled, sessionUserId]);
  /**
   * Draw the signed-in shape (placeholders, not values) while the session a
   * signed-in device last had is still restoring.
   */
  const restoringSignedIn = awaitingSession && accountHint.signedIn && !session;
  /** Whether the account behind the cloud controls is still unknown. */
  const cloudPending =
    cloudFunctionsEnabled && accountResolving && !accountState;

  // A prompt opened for another account is withdrawn, never re-targeted.
  const signOutChoice =
    signOutChoiceUserId !== null && signOutChoiceUserId === sessionUserId
      ? signOutChoiceUserId
      : null;
  useEffect(() => {
    setSignOutChoiceUserId((pending) =>
      pending === sessionUserId ? pending : null
    );
  }, [sessionUserId]);

  // Sign-out asks whether to keep this device unlocked, but only when this
  // browser holds device keys for the account; otherwise it signs out at once.
  const signOut = async () => {
    if (signOutBusy) return;
    setSignOutBusy(true);
    setSignOutError(null);
    let failureMessage =
      "Could not check this browser's device keys. Try signing out again.";
    try {
      const inspectedSession = session;
      const userId = inspectedSession?.userId;
      if (!userId) return;
      const { hasStoredDevice } = await import('../lib/e2ee/deviceStore');
      const hasDevice = await hasStoredDevice(userId);
      if (signOutSessionRef.current !== inspectedSession) return;
      if (hasDevice) {
        setSignOutChoiceUserId(userId);
        return;
      }
      failureMessage = 'Could not complete sign-out. Try again.';
      await onLogout({ userId });
    } catch {
      setSignOutError(failureMessage);
    } finally {
      setSignOutBusy(false);
    }
  };
  // The app drains autosaves, completes this choice, then revokes the session.
  // A failed deletion leaves the choice visible so it can be retried.
  const finishSignOut = async (keepDevice: boolean) => {
    if (signOutBusy) return;
    setSignOutBusy(true);
    setSignOutError(null);
    try {
      const userId = signOutChoice;
      if (!userId) return;
      await onLogout({ userId, keepDevice });
      setSignOutChoiceUserId(null);
    } catch {
      setSignOutError(
        'Could not complete sign-out. Retry your device-key choice.'
      );
    } finally {
      setSignOutBusy(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The overlay's modal focus lands on the first control, the brand button,
  // which closes Settings: a first Enter dismissed the page. Start on the
  // heading instead, so restoring Settings does not paint a keyboard focus
  // ring on the active nav item. A passive effect runs after that hook has
  // recorded the opener, so focus still returns there on close.
  useEffect(() => {
    const current = document.activeElement;
    if (
      current instanceof HTMLElement &&
      current !== brandRef.current &&
      pageRef.current?.contains(current)
    ) {
      return;
    }
    headingRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }
    const stored = loadSettingsViewState();
    const scrollTop =
      initialSection === undefined && stored.activeSection === active
        ? stored.scrollTop
        : 0;
    const restoreScroll = () => {
      content.scrollTop = scrollTop;
      scrollTopRef.current = content.scrollTop;
    };
    restoreScroll();
    // Font metrics can change the scroll range after the first layout. Keep the
    // saved target intact and retry once that layout has settled instead of
    // permanently accepting a temporarily clamped position.
    void document.fonts?.ready.then(restoreScroll);
    scrollTopRef.current = scrollTop;
    updateSettingsViewState({
      open: true,
      activeSection: active,
      query: queryRef.current,
      scrollTop
    });
  }, [active, initialSection]);

  useEffect(() => {
    const onPageHide = () => persistCurrentView();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      persistCurrentView();
    };
  }, []);

  const visibleSections = useMemo(
    () =>
      visibleSettingsSections({
        cloudFunctionsEnabled,
        // Until the server answers, the item holds the place it had last
        // time on this device, so the rows below it do not shift under the
        // pointer when the answer lands.
        encryptionAvailable:
          encryptionAvailable === null
            ? cloudFunctionsEnabled &&
              (Boolean(session) || awaitingSession) &&
              accountHint.signedIn &&
              accountHint.encryption
            : encryptionAvailable && Boolean(session),
        query
      }),
    [
      accountHint,
      awaitingSession,
      cloudFunctionsEnabled,
      encryptionAvailable,
      query,
      session
    ]
  );

  // A search that matches somewhere other than the open section should take the
  // user there, otherwise the match stays invisible behind the current section.
  useEffect(() => {
    const first = visibleSections[0];
    if (!first) {
      return;
    }
    // A restored Encryption view waits for the server's answer rather than
    // falling back to General while that answer is in flight.
    if (active === 'encryption' && encryptionAvailable === null) {
      return;
    }
    if (!visibleSections.some((section) => section.id === active)) {
      setActive(first.id);
    }
  }, [active, encryptionAvailable, visibleSections]);

  useEffect(() => {
    if (session) {
      setLoginCode('');
      setLoginChallengeId(null);
      setTurnstileToken('');
    }
  }, [session]);

  const patch = (next: Partial<AppSettings>) =>
    onChange({ ...settings, ...next });
  const patchCollaboration = (next: Partial<AppSettings['collaboration']>) =>
    patch({ collaboration: { ...settings.collaboration, ...next } });
  const patchAssistant = (next: Partial<AppSettings['assistant']>) =>
    patch({ assistant: { ...settings.assistant, ...next } });

  const credential = accountState?.credential;
  const effective = accountState?.effectiveAssistant;
  const credentialValidated = Boolean(credential?.lastValidatedAt);
  // From the start screen there is no workspace behind Settings to go back to.
  const backLabel = workspaceOpen ? 'Back to workspace' : 'Back to projects';
  // A search with no match leaves nothing to show; the section that was open
  // before it must not linger as if it matched.
  const anyMatch = visibleSections.length > 0;

  return (
    <div
      ref={pageRef}
      className={`settings-page density-${settings.appearance.density}`}
      data-reduced-motion={settings.appearance.reducedMotion ? 'true' : 'false'}
    >
      <div className="settings-layout">
        <aside className="settings-nav" aria-label="Settings sections">
          {/* Column first, as the library: the logo heads the column (and
              goes back, as it does from every page). The labelled way out is
              in the head's corner, where Settings was opened from. */}
          <div className="settings-nav-head">
            <button
              ref={brandRef}
              className="brand"
              type="button"
              title={`${backLabel} (Esc)`}
              onClick={onClose}
            >
              <BrandMark compact />
              OpenZCAD <span className="beta-tag">Beta</span>
            </button>
          </div>
          <nav>
            {visibleSections.map((section, index) => (
              <Fragment key={section.id}>
                {section.group !== visibleSections[index - 1]?.group &&
                  (section.group ? (
                    <p className="settings-nav-group">{section.group}</p>
                  ) : (
                    <hr className="settings-nav-rule" />
                  ))}
                <button
                  type="button"
                  className={active === section.id ? 'active' : ''}
                  // Named outright: the label is a span beside a decorative
                  // icon, and a narrow rail once hid it entirely.
                  aria-label={section.label}
                  aria-current={active === section.id ? 'page' : undefined}
                  title={section.detail}
                  onClick={() => setActive(section.id)}
                >
                  {SECTION_ICONS[section.id]}
                  <span>{section.label}</span>
                </button>
              </Fragment>
            ))}
            {visibleSections.length === 0 && (
              <p className="settings-nav-empty" role="status">
                No settings match “{query.trim()}”.
              </p>
            )}
          </nav>
          <div className="settings-nav-status">
            {cloudFunctionsEnabled ? (
              <Database size={13} aria-hidden="true" />
            ) : (
              <CloudOff size={13} aria-hidden="true" />
            )}
            <span>
              <strong>
                {/*
                  Being signed in is not the same as being reachable. This read
                  only `session` and so announced "Cloud profile connected"
                  while the header of the same screen said the profile was
                  unavailable — two claims about one thing, on screen together.
                  Reachability decides first, and a session whose profile
                  could not be loaded is not connected either.
                */}
                {!cloudFunctionsEnabled
                  ? 'Offline mode'
                  : authConfigStatus === 'unavailable'
                    ? 'Cloud unavailable'
                    : accountResolving && !accountState
                      ? 'Checking account…'
                      : session
                        ? accountState
                          ? 'Cloud profile connected'
                          : 'Cloud profile unavailable'
                        : 'Device only'}
              </strong>
              <small>Changes save automatically</small>
            </span>
          </div>
        </aside>

        {/* The head stays put while a long page scrolls under it, as the
            workspace's top bar does. */}
        <header className="settings-head">
          <h1 ref={headingRef} className="settings-head-title" tabIndex={-1}>
            Settings
          </h1>
          <span className="settings-save-message" aria-live="polite">
            {message}
          </span>
          <label className="settings-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              placeholder="Find a setting"
              aria-label="Find a setting"
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={(event) => {
                // Escape clears a search before it closes Settings, as it
                // does in any search field; otherwise the filter outlived
                // the close and greeted the next visit.
                if (event.key === 'Escape' && query) {
                  event.stopPropagation();
                  changeQuery('');
                }
              }}
            />
          </label>
          {/* The library's and the workspace's Settings button sits in this
              corner; the way back takes its place. */}
          <div className="corner-slot">
            <button
              className="corner-action settings-close"
              type="button"
              aria-label={`Close settings and go ${backLabel.toLowerCase()}`}
              title={`${backLabel} (Esc)`}
              onClick={onClose}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              {backLabel}
            </button>
          </div>
        </header>
        <main
          className="settings-content"
          ref={contentRef}
          onScroll={(event: UIEvent<HTMLElement>) => {
            scrollTopRef.current = event.currentTarget.scrollTop;
          }}
        >
          {!anyMatch && (
            <p className="settings-empty">
              No settings match “{query.trim()}”. Clear the search to see every
              section.
            </p>
          )}
          {active === 'general' && anyMatch && (
            <Section title="General" intro="Startup and new-project defaults.">
              <Group>
                <SettingRow
                  title="Default units"
                  hint="For new projects. Existing ones keep theirs."
                >
                  <Segmented
                    label="Default units"
                    value={settings.general.defaultUnits}
                    options={UNIT_OPTIONS}
                    onChange={(defaultUnits) =>
                      patch({
                        general: { ...settings.general, defaultUnits }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Unitless imports"
                  hint="STL, OBJ, PLY and DXF without units: how to read them."
                >
                  <select
                    value={settings.files.unitlessImportUnits}
                    aria-label="Unitless imports"
                    onChange={(event) =>
                      patch({
                        files: {
                          ...settings.files,
                          unitlessImportUnits: event.target
                            .value as AppSettings['files']['unitlessImportUnits']
                        }
                      })
                    }
                  >
                    <option value="ask">Ask each time</option>
                    <option value="document">Project units</option>
                    <option value="mm">Millimeters</option>
                    <option value="cm">Centimeters</option>
                    <option value="m">Meters</option>
                    <option value="inch">Inches</option>
                  </select>
                </SettingRow>
                <SettingRow
                  title="Export units"
                  hint="STEP, mesh and DXF files. GLB is always meters."
                >
                  <select
                    value={settings.files.exportUnits}
                    aria-label="Export units"
                    onChange={(event) =>
                      patch({
                        files: {
                          ...settings.files,
                          exportUnits: event.target
                            .value as AppSettings['files']['exportUnits']
                        }
                      })
                    }
                  >
                    <option value="document">Project units</option>
                    <option value="mm">Millimeters</option>
                    <option value="cm">Centimeters</option>
                    <option value="m">Meters</option>
                    <option value="inch">Inches</option>
                  </select>
                </SettingRow>
                <SettingRow
                  title="Reopen the last project"
                  hint="Pick up where you left off on launch."
                >
                  <Toggle
                    checked={settings.general.reopenLastProject}
                    label="Reopen the last project"
                    onChange={(reopenLastProject) =>
                      patch({
                        general: { ...settings.general, reopenLastProject }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Confirm destructive actions"
                  hint="Ask before emptying the trash, resetting, or removing data."
                >
                  <Toggle
                    checked={settings.general.confirmDestructiveActions}
                    label="Confirm destructive actions"
                    onChange={(confirmDestructiveActions) =>
                      patch({
                        general: {
                          ...settings.general,
                          confirmDestructiveActions
                        }
                      })
                    }
                  />
                </SettingRow>
              </Group>
            </Section>
          )}

          {active === 'appearance' && anyMatch && (
            <Section title="Appearance" intro="How the interface looks.">
              <Group>
                <SettingRow title="Theme" hint="System follows your OS.">
                  <Segmented
                    label="Theme"
                    value={settings.appearance.theme}
                    options={THEME_OPTIONS}
                    onChange={(theme) =>
                      patch({ appearance: { ...settings.appearance, theme } })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Interface density"
                  hint="Comfortable adds spacing."
                >
                  <Segmented
                    label="Interface density"
                    value={settings.appearance.density}
                    options={DENSITY_OPTIONS}
                    onChange={(density) =>
                      patch({
                        appearance: { ...settings.appearance, density }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Library card size"
                  hint="How large projects show in the library's grid."
                >
                  <Segmented
                    label="Library card size"
                    value={settings.appearance.libraryCardSize}
                    options={LIBRARY_CARD_SIZE_OPTIONS}
                    onChange={(libraryCardSize) =>
                      patch({
                        appearance: { ...settings.appearance, libraryCardSize }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Reduce motion"
                  hint="Turn off non-essential animation."
                >
                  <Toggle
                    checked={settings.appearance.reducedMotion}
                    label="Reduce motion"
                    onChange={(reducedMotion) =>
                      patch({
                        appearance: { ...settings.appearance, reducedMotion }
                      })
                    }
                  />
                </SettingRow>
              </Group>
            </Section>
          )}

          {active === 'viewport' && anyMatch && (
            <Section title="Viewport" intro="How new views look.">
              <Group>
                <SettingRow title="Projection">
                  <Segmented
                    label="Default projection"
                    value={settings.viewport.defaultProjection}
                    options={PROJECTION_OPTIONS}
                    onChange={(defaultProjection) =>
                      patch({
                        viewport: { ...settings.viewport, defaultProjection }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow title="Display mode">
                  <Segmented
                    label="Default display mode"
                    value={settings.viewport.displayMode}
                    options={DISPLAY_OPTIONS}
                    onChange={(displayMode) =>
                      patch({
                        viewport: { ...settings.viewport, displayMode }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Tangent edges"
                  hint="Fillet and blend rims in Shaded + edges. Hovering one still shows it."
                >
                  <Segmented
                    label="Tangent edges"
                    value={settings.viewport.tangentEdges}
                    options={TANGENT_EDGE_OPTIONS}
                    onChange={(tangentEdges) =>
                      patch({
                        viewport: { ...settings.viewport, tangentEdges }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Show construction grid"
                  hint="A view aid; never part of the model."
                >
                  <Toggle
                    checked={settings.viewport.showGrid}
                    label="Show construction grid"
                    onChange={(showGrid) =>
                      patch({
                        viewport: { ...settings.viewport, showGrid }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Field of view"
                  hint="Perspective only. The part keeps its size on screen."
                >
                  <NumberSetting
                    min={VIEWPORT_FIELD_OF_VIEW_BOUNDS.min}
                    max={VIEWPORT_FIELD_OF_VIEW_BOUNDS.max}
                    integer
                    unit="°"
                    value={settings.viewport.fieldOfView}
                    label="Perspective field of view"
                    onCommit={(fieldOfView) =>
                      patch({
                        viewport: { ...settings.viewport, fieldOfView }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="X-ray opacity"
                  hint="How solid faces stay in X-ray."
                >
                  <NumberSetting
                    min={XRAY_OPACITY_BOUNDS.min}
                    max={XRAY_OPACITY_BOUNDS.max}
                    step={5}
                    integer
                    unit="%"
                    value={settings.viewport.xrayOpacity}
                    label="X-ray face opacity"
                    onCommit={(xrayOpacity) =>
                      patch({
                        viewport: { ...settings.viewport, xrayOpacity }
                      })
                    }
                  />
                </SettingRow>
              </Group>
              <Group>
                <SettingRow
                  title="Current view"
                  hint={
                    workspaceOpen
                      ? 'Apply these defaults to the open project.'
                      : 'Open a project to apply these defaults to its view.'
                  }
                >
                  <button
                    className="secondary"
                    type="button"
                    aria-label="Apply defaults to current view"
                    disabled={!workspaceOpen}
                    onClick={onApplyViewportDefaults}
                  >
                    <Eye size={14} aria-hidden="true" />
                    Apply defaults
                  </button>
                </SettingRow>
              </Group>
            </Section>
          )}

          {active === 'controls' && anyMatch && (
            <Section title="Controls" intro="Mouse, trackpad, and keyboard.">
              <Group title="Navigation">
                <SettingRow
                  title="Scroll wheel"
                  hint="Auto switches to trackpad after a pinch or diagonal swipe."
                >
                  <Segmented
                    label="Scroll wheel"
                    value={settings.viewport.pointerNavigation}
                    options={SCROLL_OPTIONS}
                    onChange={(pointerNavigation) =>
                      patch({
                        viewport: { ...settings.viewport, pointerNavigation }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Middle-button drag"
                  hint="Pan matches desktop CAD."
                >
                  <Segmented
                    label="Middle-button drag"
                    value={settings.viewport.middleDrag}
                    options={MIDDLE_DRAG_OPTIONS}
                    onChange={(middleDrag) =>
                      patch({
                        viewport: { ...settings.viewport, middleDrag }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Orbit"
                  hint="Free tumbles over the top and bottom. Turntable keeps the model upright and stops there."
                >
                  <Segmented
                    label="Orbit"
                    value={settings.viewport.orbitMode}
                    options={ORBIT_MODE_OPTIONS}
                    onChange={(orbitMode) =>
                      patch({
                        viewport: { ...settings.viewport, orbitMode }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Zoom toward the pointer"
                  hint="Off zooms toward the middle of the view."
                >
                  <Toggle
                    checked={settings.viewport.zoomToCursor}
                    label="Zoom toward the pointer"
                    onChange={(zoomToCursor) =>
                      patch({
                        viewport: { ...settings.viewport, zoomToCursor }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Undo with two fingers"
                  hint="On a touch screen, a two-finger tap undoes and a three-finger tap redoes."
                >
                  <Toggle
                    checked={settings.viewport.touchHistoryGestures}
                    label="Undo with two fingers"
                    onChange={(touchHistoryGestures) =>
                      patch({
                        viewport: { ...settings.viewport, touchHistoryGestures }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Only Apple Pencil draws"
                  hint="Once a Pencil is used, fingers move the view in a sketch and the Pencil places geometry."
                >
                  <Toggle
                    checked={settings.viewport.pencilDrawsOnly}
                    label="Only Apple Pencil draws"
                    onChange={(pencilDrawsOnly) =>
                      patch({
                        viewport: { ...settings.viewport, pencilDrawsOnly }
                      })
                    }
                  />
                </SettingRow>
              </Group>
              {/* A 3D mouse is navigation too, so its settings sit right
                  under it rather than past the keyboard reference. */}
              <Group title="3D mouse" note="Chrome and Edge">
                <SpaceMouseSettings />
                <SpaceMousePreferenceRows
                  value={settings.viewport.spaceMouse}
                  onChange={(spaceMouse) =>
                    patch({
                      viewport: { ...settings.viewport, spaceMouse }
                    })
                  }
                />
              </Group>
              <Group title="SpaceMouse keys">
                <ControlReferenceGroups groups={[SPACE_MOUSE_KEY_REFERENCE]} />
              </Group>
              {/* Every remappable command with its live keys. A key can mean
                  one thing per context (C is Cylinder in the workspace and
                  Circle in a sketch); the editor's groups are those contexts.
                  The overrides follow the account, never a project. */}
              <Group
                title="Keyboard"
                note="Workspace shortcuts pause while you type in a field"
              >
                <KeymapEditor
                  overrides={settings.keymap.overrides}
                  onChange={(overrides) =>
                    onChange({ ...settings, keymap: { overrides } })
                  }
                />
              </Group>
              <Group title="Fixed keys" note="Can’t be reassigned">
                <ControlReferenceGroups groups={FIXED_KEYBOARD_GROUPS} />
              </Group>
              <Group title="Mouse & pointer">
                <ControlReferenceGroups groups={POINTER_CONTROL_GROUPS} />
              </Group>
            </Section>
          )}

          {active === 'sketching' && anyMatch && (
            <Section title="Sketching" intro="Grid, snapping, and inferencing.">
              <Group title="Grid">
                <SettingRow title="Show sketch grid">
                  <Toggle
                    checked={settings.sketching.gridVisible}
                    label="Show sketch grid"
                    onChange={(gridVisible) =>
                      patch({
                        sketching: { ...settings.sketching, gridVisible }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Snap to sketch grid"
                  hint="Geometry snaps still win."
                >
                  <Toggle
                    checked={settings.sketching.snapEnabled}
                    label="Snap to sketch grid"
                    onChange={(snapEnabled) =>
                      patch({
                        sketching: { ...settings.sketching, snapEnabled }
                      })
                    }
                  />
                </SettingRow>
                {/* Named in the open project's unit: a bare number left the
                    reader to guess whether 0.5 was millimetres or inches. */}
                <SettingRow
                  title="Linear snap"
                  hint={
                    documentUnits
                      ? 'In this project’s units.'
                      : 'In each project’s own units.'
                  }
                >
                  <NumberSetting
                    {...APP_SETTINGS_NUMBER_BOUNDS.linearSnap}
                    step={0.1}
                    unit={documentUnits ? displayLengthName(documentUnits) : ''}
                    value={settings.sketching.linearSnap}
                    label="Linear snap increment"
                    onCommit={(linearSnap) =>
                      patch({
                        sketching: { ...settings.sketching, linearSnap }
                      })
                    }
                  />
                </SettingRow>
              </Group>
              <Group title="Snapping">
                <SettingRow
                  title="Geometry snapping"
                  hint="Endpoints, midpoints, centers, and intersections."
                >
                  <Toggle
                    checked={settings.sketching.geometrySnapEnabled}
                    label="Geometry snapping"
                    onChange={(geometrySnapEnabled) =>
                      patch({
                        sketching: {
                          ...settings.sketching,
                          geometrySnapEnabled
                        }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow title="Snap tolerance">
                  <NumberSetting
                    {...APP_SETTINGS_NUMBER_BOUNDS.snapTolerancePx}
                    unit="px"
                    value={settings.sketching.snapTolerancePx}
                    label="Sketch snap tolerance"
                    onCommit={(snapTolerancePx) =>
                      patch({
                        sketching: { ...settings.sketching, snapTolerancePx }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Automatic inferencing"
                  hint="Horizontal and vertical hints. Hold Shift to skip."
                >
                  <Toggle
                    checked={settings.sketching.inferenceEnabled}
                    label="Automatic inferencing"
                    onChange={(inferenceEnabled) =>
                      patch({
                        sketching: { ...settings.sketching, inferenceEnabled }
                      })
                    }
                  />
                </SettingRow>
              </Group>
              <Group title="Relations">
                <SettingRow
                  title="Relation glyphs"
                  hint="Marks on sketch geometry for each relation."
                >
                  <Segmented
                    label="Relation glyphs"
                    value={settings.sketching.relationGlyphs}
                    options={RELATION_GLYPH_OPTIONS}
                    onChange={(relationGlyphs) =>
                      patch({
                        sketching: { ...settings.sketching, relationGlyphs }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Glyph kinds"
                  hint="Which relations draw a glyph."
                >
                  <RelationGlyphFilter
                    hidden={settings.sketching.hiddenRelationGlyphs}
                    disabled={settings.sketching.relationGlyphs === 'hidden'}
                    onChange={(hiddenRelationGlyphs) =>
                      patch({
                        sketching: {
                          ...settings.sketching,
                          hiddenRelationGlyphs
                        }
                      })
                    }
                  />
                </SettingRow>
              </Group>
            </Section>
          )}

          {active === 'saving' && anyMatch && (
            <Section title="Saving" intro="Local saves are automatic.">
              <Group title="This device">
                <SettingRow
                  title="Local autosave"
                  hint="Every edit is saved in this browser."
                >
                  <Status tone="good">Always on</Status>
                </SettingRow>
              </Group>
              {/* Until the account is known these hold their saved values
                  but stay disabled: a live switch beside a footer that
                  still says "Device only" claimed a sync nothing runs. */}
              {/* Signed out, these are settings for later: they say so
                  rather than read as running (I8). */}
              <Group
                title="Cloud"
                note={
                  cloudPending
                    ? 'Checking account…'
                    : cloudFunctionsEnabled && !session
                      ? 'Applies after sign-in. Until then everything saves on this device only.'
                      : undefined
                }
              >
                <SettingRow
                  title="Cloud autosave"
                  hint={`Off: update the cloud copy only when you save a revision${saveKeyCopy}.`}
                >
                  <Toggle
                    label="Cloud autosave"
                    checked={settings.files.cloudAutosave}
                    disabled={!cloudFunctionsEnabled || cloudPending}
                    onChange={(cloudAutosave) =>
                      onChange({
                        ...settings,
                        files: { ...settings.files, cloudAutosave }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Cloud autosave delay"
                  hint="Quiet time before syncing."
                >
                  <NumberSetting
                    min={CLOUD_AUTOSAVE_DELAY_BOUNDS.min}
                    max={CLOUD_AUTOSAVE_DELAY_BOUNDS.max}
                    integer
                    unit="s"
                    label="Cloud autosave delay in seconds"
                    disabled={
                      !cloudFunctionsEnabled ||
                      cloudPending ||
                      !settings.files.cloudAutosave
                    }
                    value={settings.files.cloudAutosaveDelaySeconds}
                    onCommit={(cloudAutosaveDelaySeconds) =>
                      onChange({
                        ...settings,
                        files: { ...settings.files, cloudAutosaveDelaySeconds }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Cloud revisions"
                  hint={`Saving a revision${saveKeyCopy} adds a checkpoint.`}
                >
                  <Status>
                    {!cloudFunctionsEnabled
                      ? 'Disabled'
                      : cloudPending
                        ? '—'
                        : 'Manual'}
                  </Status>
                </SettingRow>
              </Group>
            </Section>
          )}

          {active === 'assistant' && cloudFunctionsEnabled && anyMatch && (
            <Section
              title="AI Assistant"
              intro="Every proposal is previewed before it changes your model."
            >
              <AssistantConnectionSettings
                assistant={settings.assistant}
                accountState={accountState}
                sessionUserId={session?.userId}
                onChange={patchAssistant}
              />

              {settings.assistant.credentialSource === 'personal' ? (
                <>
                  <Group title="Model">
                    <SettingRow
                      title="Provider"
                      hint="Changing provider removes the saved token."
                    >
                      <select
                        value={settings.assistant.provider}
                        aria-label="AI provider"
                        onChange={(event) => {
                          const provider = event.target
                            .value as AppSettings['assistant']['provider'];
                          setToken('');
                          patchAssistant({
                            provider,
                            ...providerDefaults(provider)
                          });
                        }}
                      >
                        <option value="openrouter">OpenRouter</option>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="responses-compatible">
                          Responses-compatible
                        </option>
                      </select>
                    </SettingRow>
                    {settings.assistant.provider === 'responses-compatible' ? (
                      <SettingRow
                        title="API endpoint"
                        hint="Public HTTPS only. Changing endpoint removes the saved token."
                      >
                        <input
                          className="settings-text-wide"
                          type="url"
                          value={settings.assistant.baseUrl}
                          placeholder="https://models.example.com/v1/responses"
                          aria-label="AI API endpoint"
                          onChange={(event) => {
                            setToken('');
                            patchAssistant({ baseUrl: event.target.value });
                          }}
                        />
                      </SettingRow>
                    ) : null}
                    <SettingRow title="Model" hint="The provider’s exact id.">
                      <input
                        className="settings-text-wide mono"
                        value={settings.assistant.model}
                        aria-label="AI model"
                        onChange={(event) => {
                          const model = event.target.value;
                          patchAssistant({
                            model,
                            ...(settings.assistant.provider === 'anthropic' &&
                            settings.assistant.reasoningEffort === 'off' &&
                            !anthropicThinkingOffType(model)
                              ? { reasoningEffort: 'provider-default' as const }
                              : {})
                          });
                        }}
                      />
                    </SettingRow>
                    <SettingRow
                      title="Reasoning level"
                      hint={
                        settings.assistant.provider === 'anthropic' &&
                        !anthropicThinkingOffType(settings.assistant.model)
                          ? 'Off isn’t available for this model.'
                          : 'Higher plans better, costs more.'
                      }
                    >
                      <select
                        value={settings.assistant.reasoningEffort}
                        aria-label="AI reasoning level"
                        onChange={(event) =>
                          patchAssistant({
                            reasoningEffort: event.target
                              .value as AppSettings['assistant']['reasoningEffort']
                          })
                        }
                      >
                        <option value="provider-default">
                          Provider default
                        </option>
                        <option
                          value="off"
                          disabled={
                            settings.assistant.provider === 'anthropic' &&
                            !anthropicThinkingOffType(settings.assistant.model)
                          }
                        >
                          Off
                        </option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">Extra high</option>
                      </select>
                    </SettingRow>
                  </Group>

                  <Group title="Token">
                    {!session && authConfigStatus === 'unavailable' ? (
                      // The same words and action Account shows: its Sign in
                      // led to a page that offered only Retry (I86).
                      <Notice
                        action={
                          <button
                            className="secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void onRefreshAuthConfig()}
                          >
                            <RefreshCcw size={13} aria-hidden="true" />
                            Retry
                          </button>
                        }
                      >
                        Sign-in could not be reached, so a personal token can’t
                        be stored right now.
                      </Notice>
                    ) : !session ? (
                      <Notice
                        action={
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => setActive('account')}
                          >
                            <LogIn size={14} aria-hidden="true" />
                            Sign in
                          </button>
                        }
                      >
                        Sign in to store a personal token.
                      </Notice>
                    ) : credential && !credential.storageAvailable ? (
                      <Notice>
                        Personal token storage isn’t available on this server
                        yet.
                      </Notice>
                    ) : null}
                    <SettingRow
                      title="Personal API token"
                      hint={
                        credential?.stored
                          ? `Saved as ${credential.hint}. Encrypted; it can’t be shown again.`
                          : 'Encrypted on the server, never kept in the browser.'
                      }
                    >
                      <form
                        className="settings-token-control"
                        onSubmit={(event) => {
                          event.preventDefault();
                          onSaveCredential(token.trim());
                          setToken('');
                        }}
                      >
                        <input
                          type={showToken ? 'text' : 'password'}
                          value={token}
                          disabled={!session}
                          autoComplete="off"
                          placeholder={
                            credential?.stored ? credential.hint : 'API token'
                          }
                          aria-label="Personal API token"
                          onChange={(event) => setToken(event.target.value)}
                        />
                        {/* The label carries the state, as Show/Hide personal
                            info does; the icon and tooltip follow it so sighted
                            users see the state too. */}
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={showToken ? 'Hide token' : 'Show token'}
                          title={showToken ? 'Hide token' : 'Show token'}
                          onClick={() => setShowToken((current) => !current)}
                        >
                          {showToken ? (
                            <EyeOff size={14} aria-hidden="true" />
                          ) : (
                            <Eye size={14} aria-hidden="true" />
                          )}
                        </button>
                        <button
                          className="secondary"
                          type="submit"
                          disabled={
                            busy ||
                            !session ||
                            token.trim().length < 8 ||
                            !credential?.storageAvailable
                          }
                        >
                          Save token
                        </button>
                      </form>
                    </SettingRow>
                    <SettingRow
                      title="Connection"
                      hint={
                        <Status
                          tone={
                            effective?.configured && credentialValidated
                              ? 'good'
                              : 'warning'
                          }
                        >
                          {!session
                            ? 'Sign in to use a personal credential'
                            : effective?.configured
                              ? `${credentialValidated ? 'Validated' : 'Configured'} · ${effective.model} · ${effective.reasoningEffort}${credentialValidated ? '' : ' · run Test connection'}`
                              : 'Personal assistant is not ready'}
                        </Status>
                      }
                    >
                      <span className="settings-button-row">
                        <button
                          className="secondary"
                          type="button"
                          disabled={busy || !session || !credential?.stored}
                          onClick={onTestAssistant}
                        >
                          <Bot size={14} aria-hidden="true" />
                          Test connection
                        </button>
                        <button
                          className="danger-ghost"
                          type="button"
                          disabled={busy || !session || !credential?.stored}
                          onClick={onDeleteCredential}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          Remove token
                        </button>
                      </span>
                    </SettingRow>
                  </Group>

                  <Group title="Limits">
                    <SettingRow
                      title="Output budget"
                      hint="Shared by reasoning and the proposal."
                    >
                      <NumberSetting
                        {...APP_SETTINGS_NUMBER_BOUNDS.maxOutputTokens}
                        step={1000}
                        integer
                        value={settings.assistant.maxOutputTokens}
                        label="Output budget (tokens)"
                        onCommit={(maxOutputTokens) =>
                          patchAssistant({ maxOutputTokens })
                        }
                      />
                    </SettingRow>
                    <SettingRow title="Request timeout">
                      <NumberSetting
                        min={APP_SETTINGS_NUMBER_BOUNDS.timeoutMs.min / 1000}
                        max={APP_SETTINGS_NUMBER_BOUNDS.timeoutMs.max / 1000}
                        unit="s"
                        value={settings.assistant.timeoutMs / 1000}
                        label="Request timeout (seconds)"
                        onCommit={(seconds) =>
                          patchAssistant({ timeoutMs: seconds * 1000 })
                        }
                      />
                    </SettingRow>
                  </Group>

                  <Group title="Instructions">
                    <label className="settings-long-field">
                      <strong>CAD assistant preferences</strong>
                      <small>
                        Manufacturing context and typical clearances. Can’t
                        override review rules.
                      </small>
                      <textarea
                        rows={4}
                        maxLength={4000}
                        value={settings.assistant.customInstructions}
                        onChange={(event) =>
                          patchAssistant({
                            customInstructions: event.target.value
                          })
                        }
                      />
                    </label>
                  </Group>
                </>
              ) : null}

              <p className="settings-footnote">
                <ShieldCheck size={14} aria-hidden="true" />
                The assistant receives feature history, model summaries, your
                selection, and attachments you choose to send. Raw STEP files
                and meshes are not sent.
              </p>
            </Section>
          )}

          {active === 'account' && anyMatch && (
            <Section
              title="Account"
              intro="Optional. Everything works offline without one."
            >
              {cloudFunctionsEnabled && projectInvitationPending ? (
                <Group>
                  <Notice
                    tone="info"
                    role={projectInvitationError ? 'alert' : 'status'}
                    action={
                      <button
                        className="secondary"
                        type="button"
                        disabled={busy}
                        onClick={onDismissProjectInvitation}
                      >
                        Not now
                      </button>
                    }
                  >
                    {projectInvitationError ??
                      'Project invitation ready. Sign in with the email address that received the link and the project will open automatically.'}
                    {projectInvitationError && session
                      ? ' Sign out below to try a different email address.'
                      : ''}
                  </Notice>
                </Group>
              ) : null}
              <Group>
                {cloudFunctionsEnabled ? null : (
                  <Notice>
                    Cloud features are off on this device. Turn them on to sign
                    in, share, or see your storage.
                  </Notice>
                )}
                <SettingRow
                  title="Cloud features"
                  hint="Sign-in, sync, sharing, and AI. Local modeling works either way."
                >
                  <Toggle
                    checked={cloudFunctionsEnabled}
                    label="Cloud features"
                    onChange={onCloudFunctionsEnabledChange}
                  />
                </SettingRow>
              </Group>
              {cloudFunctionsEnabled ? (
                <>
                  <Group title="Profile">
                    {session ? (
                      <>
                        <SettingRow
                          title={
                            <PrivateText
                              value={session.displayName}
                              visible={personalInfoVisible}
                              onChange={setPersonalInfoVisible}
                            />
                          }
                          hint={
                            <PrivateText
                              value={session.email ?? session.userId}
                              visible={personalInfoVisible}
                              onChange={setPersonalInfoVisible}
                            />
                          }
                        >
                          <button
                            className="secondary"
                            type="button"
                            disabled={busy || signOutBusy}
                            onClick={() => void signOut()}
                          >
                            <LogOut size={14} aria-hidden="true" />
                            Sign out
                          </button>
                        </SettingRow>
                        {signOutError ? (
                          <Notice tone="warning" role="alert">
                            {signOutError}
                          </Notice>
                        ) : null}
                        {signOutChoice ? (
                          <Notice
                            tone="info"
                            role="alert"
                            action={
                              <span className="settings-button-row">
                                <button
                                  className="primary"
                                  type="button"
                                  disabled={busy || signOutBusy}
                                  onClick={() => void finishSignOut(true)}
                                >
                                  Keep unlocked
                                </button>
                                <button
                                  className="secondary"
                                  type="button"
                                  disabled={busy || signOutBusy}
                                  onClick={() => void finishSignOut(false)}
                                >
                                  Remove device keys
                                </button>
                                <button
                                  className="secondary"
                                  type="button"
                                  disabled={busy || signOutBusy}
                                  onClick={() => {
                                    setSignOutChoiceUserId(null);
                                    setSignOutError(null);
                                  }}
                                >
                                  Cancel
                                </button>
                              </span>
                            }
                          >
                            Keep this device unlocked for your next sign-in?
                            Removing its keys means approving it again or
                            entering your recovery key; it stays in your device
                            list until another device removes it.
                          </Notice>
                        ) : null}
                        <SettingRow
                          title="Membership"
                          hint={
                            session.entitlements
                              ? `${countLabel(session.entitlements.projectLimit, 'cloud project', 'cloud projects')} · ${formatBytes(session.entitlements.storageLimitBytes ?? session.entitlements.projectStorageLimitBytes)} storage · ${session.entitlements.ai.requestLimit.toLocaleString()} hosted AI requests per ${(session.entitlements.ai.windowSeconds / 60).toLocaleString()} minutes`
                              : 'Limits appear after your account reconnects.'
                          }
                          details={
                            session.entitlements
                              ? {
                                  summary: 'AI limits',
                                  body: `${session.entitlements.ai.costLimitUnits} weighted AI units per window · ${session.entitlements.ai.concurrencyLimit} concurrent requests. Hosted AI is subject to service availability and deployment budgets.`
                                }
                              : undefined
                          }
                        >
                          <Status
                            tone={
                              session.entitlements?.tier === 'premium'
                                ? 'good'
                                : undefined
                            }
                          >
                            {session.entitlements?.tier === 'premium'
                              ? 'Premium'
                              : 'Free'}
                          </Status>
                        </SettingRow>
                        {desktopAuthorizationAttempt ? (
                          <Notice
                            tone={
                              desktopAuthorizationApproved ? 'success' : 'info'
                            }
                            action={
                              desktopAuthorizationApproved ? null : (
                                <span className="settings-button-row">
                                  <label className="settings-field-inline">
                                    <span>Desktop code</span>
                                    <input
                                      type="text"
                                      value={desktopAuthorizationCode}
                                      inputMode="text"
                                      autoComplete="one-time-code"
                                      maxLength={11}
                                      placeholder="ABCD1234"
                                      onChange={(event) =>
                                        onDesktopAuthorizationCodeChange(
                                          event.currentTarget.value.toUpperCase()
                                        )
                                      }
                                    />
                                  </label>
                                  <button
                                    className="primary"
                                    type="button"
                                    disabled={
                                      busy ||
                                      desktopAuthorizationCode.trim().length < 8
                                    }
                                    onClick={() =>
                                      void onApproveDesktopLogin().catch(
                                        () => undefined
                                      )
                                    }
                                  >
                                    <LogIn size={14} aria-hidden="true" />
                                    Continue in OpenZCAD
                                  </button>
                                </span>
                              )
                            }
                          >
                            {desktopAuthorizationApproved
                              ? 'OpenZCAD for macOS is connected. You can return to the app.'
                              : 'Enter the 8-character code shown in your OpenZCAD for macOS window before connecting this cloud profile.'}
                          </Notice>
                        ) : null}
                      </>
                    ) : restoringSignedIn ? (
                      <RestoringProfileRows />
                    ) : awaitingSession ? (
                      <Notice tone="neutral">Checking your account…</Notice>
                    ) : authConfigStatus === 'loading' ? (
                      <Notice tone="neutral">
                        Checking whether sign-in is available…
                      </Notice>
                    ) : authConfigStatus === 'unavailable' ? (
                      <Notice
                        role="alert"
                        action={
                          <button
                            className="secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void onRefreshAuthConfig()}
                          >
                            <RefreshCcw size={13} aria-hidden="true" />
                            Retry
                          </button>
                        }
                      >
                        Cloud unavailable: sign-in could not be reached.
                        Projects keep saving on this device.
                      </Notice>
                    ) : desktopApp ? (
                      authConfig?.desktopAuthEnabled ? (
                        <div className="settings-auth-form">
                          <span>
                            <strong>Sign in with your browser</strong>
                            <small>
                              The security check and email code stay in your
                              browser. macOS stores only the rotating refresh
                              credential in Keychain.
                            </small>
                          </span>
                          <div className="settings-auth-controls">
                            <button
                              className="primary"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void onStartDesktopLogin().catch(
                                  () => undefined
                                )
                              }
                            >
                              <LogIn size={14} aria-hidden="true" />
                              Continue in browser
                            </button>
                          </div>
                        </div>
                      ) : (
                        <Notice>
                          Desktop sign-in isn’t available on this server yet.
                        </Notice>
                      )
                    ) : authConfig?.emailCodeEnabled &&
                      authConfig.turnstileSiteKey ? (
                      loginChallengeId ? (
                        <form
                          className="settings-auth-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            setLoginCodeError(null);
                            void onVerifyLoginCode(
                              loginChallengeId,
                              loginCode.trim()
                            ).catch((error: unknown) => {
                              setLoginCodeError(
                                describeFailure(error, {
                                  fallback:
                                    'That code did not work. Check it and try again.'
                                }).message
                              );
                              // A wrong code is cleared for the next try
                              // rather than left to be edited (I81).
                              setLoginCode('');
                              loginCodeRef.current?.focus();
                            });
                          }}
                        >
                          <span>
                            <strong>Enter the email code</strong>
                            <small>
                              Sent to{' '}
                              <PrivateText
                                value={loginEmail}
                                visible={personalInfoVisible}
                                onChange={setPersonalInfoVisible}
                              />
                              . It expires in 10 minutes.
                            </small>
                          </span>
                          <div className="settings-auth-controls">
                            <input
                              className="mono"
                              value={loginCode}
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              pattern="[0-9]{6}"
                              aria-label="Email sign-in code"
                              ref={loginCodeRef}
                              aria-invalid={loginCodeError ? true : undefined}
                              aria-describedby={
                                loginCodeError
                                  ? 'settings-login-code-error'
                                  : undefined
                              }
                              // Digits looked already typed (design review I81).
                              placeholder="6-digit code"
                              // No maxLength: it cuts a pasted " 730418" before
                              // the digit filter runs and drops the last digit.
                              onChange={(event) => {
                                setLoginCodeError(null);
                                setLoginCode(
                                  event.target.value
                                    .replace(/\D/g, '')
                                    .slice(0, 6)
                                );
                              }}
                            />
                            {loginCodeError ? (
                              <small
                                id="settings-login-code-error"
                                className="settings-field-error"
                                role="alert"
                              >
                                {loginCodeError}
                              </small>
                            ) : null}
                            <span className="settings-button-row">
                              <button
                                className="primary"
                                type="submit"
                                disabled={busy || loginCode.length !== 6}
                              >
                                <LogIn size={14} aria-hidden="true" />
                                Sign in
                              </button>
                              <button
                                className="secondary"
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setLoginChallengeId(null);
                                  setLoginCode('');
                                  setLoginCodeError(null);
                                }}
                              >
                                Use another email
                              </button>
                            </span>
                            {/* Resend (design review I81): the email form's
                              security check, then a new code to the same
                              address, after a short wait. */}
                            <div className="settings-auth-resend">
                              <TurnstileWidget
                                siteKey={authConfig.turnstileSiteKey}
                                resetSignal={turnstileReset}
                                onToken={setTurnstileToken}
                              />
                              <button
                                className="secondary"
                                type="button"
                                disabled={
                                  busy || !resendReady || !turnstileToken
                                }
                                onClick={() => {
                                  void onRequestLoginCode(
                                    loginEmail.trim(),
                                    turnstileToken
                                  )
                                    .then((response) => {
                                      setLoginCode('');
                                      setLoginChallengeId(response.challengeId);
                                    })
                                    .catch(() => undefined)
                                    .finally(() => {
                                      setTurnstileToken('');
                                      setTurnstileReset((value) => value + 1);
                                    });
                                }}
                              >
                                <Mail size={14} aria-hidden="true" />
                                {resendReady
                                  ? 'Send a new code'
                                  : 'Send a new code (in a moment)'}
                              </button>
                            </div>
                          </div>
                        </form>
                      ) : (
                        <form
                          className="settings-auth-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void onRequestLoginCode(
                              loginEmail.trim(),
                              turnstileToken
                            )
                              .then((response) =>
                                setLoginChallengeId(response.challengeId)
                              )
                              .catch(() => undefined)
                              .finally(() => {
                                setTurnstileToken('');
                                setTurnstileReset((value) => value + 1);
                              });
                          }}
                        >
                          <span>
                            <strong>Email sign-in</strong>
                            <small>
                              No password. We email you a code.{' '}
                              <ExternalAnchor href={privacyPolicyHref()}>
                                Privacy policy
                              </ExternalAnchor>
                            </small>
                          </span>
                          <div className="settings-auth-controls">
                            <label>
                              <span>Email</span>
                              <PrivateEmailInput
                                visible={personalInfoVisible}
                                value={loginEmail}
                                autoComplete="email"
                                aria-label="Email address"
                                placeholder="you@example.com"
                                onChange={(event) =>
                                  setLoginEmail(event.target.value)
                                }
                              />
                            </label>
                            <TurnstileWidget
                              siteKey={authConfig.turnstileSiteKey}
                              resetSignal={turnstileReset}
                              onToken={setTurnstileToken}
                            />
                            <button
                              className="primary"
                              type="submit"
                              disabled={
                                busy || !loginEmail.trim() || !turnstileToken
                              }
                            >
                              <Mail size={14} aria-hidden="true" />
                              Email me a code
                            </button>
                          </div>
                        </form>
                      )
                    ) : (
                      <Notice>
                        Email sign-in isn’t available on this server yet.
                      </Notice>
                    )}
                    <SettingRow
                      title="Preference synchronization"
                      hint={
                        session
                          ? 'Preferences follow your account.'
                          : 'After sign-in, preferences follow your account. Until then they stay on this device.'
                      }
                    >
                      {cloudPending ? (
                        <Status>Checking…</Status>
                      ) : (
                        <Status
                          tone={session && accountState ? 'good' : 'warning'}
                        >
                          {session && accountState?.synced
                            ? 'Available'
                            : session
                              ? 'Ready to save'
                              : 'Device only'}
                        </Status>
                      )}
                    </SettingRow>
                  </Group>
                  <Group title="Sharing">
                    <SettingRow
                      title="Project sharing"
                      hint="Invitations and live collaboration."
                    >
                      <Toggle
                        checked={settings.collaboration.enabled}
                        label="Project sharing"
                        onChange={(enabled) => patchCollaboration({ enabled })}
                      />
                    </SettingRow>
                  </Group>
                  {/* Usage belongs to a signed-in profile; signed out there
                      is nothing to measure, so the group would be two dashes. */}
                  {session || restoringSignedIn ? (
                    <Group title="Storage">
                      <SettingRow
                        title="Storage"
                        hint={storageHint(storageUsage)}
                        details={
                          (storageUsage?.trashedProjectCount ?? 0) > 0
                            ? {
                                summary: 'Trash counts toward storage',
                                body: 'Projects in the trash are still stored, so they count until they are deleted.'
                              }
                            : undefined
                        }
                      >
                        {storageUsage && storageLimit ? (
                          <span className="settings-meter-figure">
                            <Meter
                              used={storedBytes(storageUsage)}
                              limit={storageLimit}
                              label="Storage used"
                              valueText={allowanceFigure(
                                storedBytes(storageUsage),
                                storageLimit
                              )}
                            />
                            <span>
                              {allowanceFigure(
                                storedBytes(storageUsage),
                                storageLimit
                              )}
                            </span>
                          </span>
                        ) : (
                          <Status>
                            {storageUsage
                              ? formatBytes(storedBytes(storageUsage))
                              : '—'}
                          </Status>
                        )}
                      </SettingRow>
                    </Group>
                  ) : null}
                </>
              ) : null}
            </Section>
          )}

          {active === 'encryption' &&
            anyMatch &&
            encryptionAvailable === null &&
            (Boolean(session) || awaitingSession) && (
              <Section
                title="Encryption"
                intro="Beta. Encrypted cloud projects can be read only on your devices."
              >
                <p className="encryption-loading" role="status">
                  Loading encryption keys…
                </p>
              </Section>
            )}
          {active === 'encryption' &&
            anyMatch &&
            session &&
            encryptionAvailable && (
              <Section
                title="Encryption"
                intro="Beta. Encrypted cloud projects can be read only on your devices."
              >
                <ErrorBoundary label="Encryption settings">
                  <Suspense
                    fallback={
                      <p className="encryption-loading" role="status">
                        Loading encryption keys…
                      </p>
                    }
                  >
                    <EncryptionSettings userId={session.userId} />
                  </Suspense>
                </ErrorBoundary>
              </Section>
            )}

          {active === 'privacy' && anyMatch && (
            <Section
              title="Privacy & data"
              intro="What leaves this device, and how to take it back."
            >
              <Group title="Analytics">
                <AnalyticsConsent />
                {session && !desktopApp ? (
                  <CloudStatisticsConsent
                    key={session.userId}
                    accountKey={session.userId}
                    cloudEnabled={cloudFunctionsEnabled}
                  />
                ) : null}
                <SettingRow
                  title="Privacy policy"
                  hint="What the hosted service collects and shares."
                >
                  <ExternalAnchor
                    className="secondary"
                    href={privacyPolicyHref()}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    Read the policy
                  </ExternalAnchor>
                </SettingRow>
              </Group>
              <Group title="Your data">
                <DataDownload
                  settings={settings}
                  session={session}
                  cloudFunctionsEnabled={cloudFunctionsEnabled}
                  busy={busy}
                />
                <SettingRow
                  title="Local project data"
                  hint={
                    session
                      ? 'Stays in this browser until you empty it from Trash. Cloud deletion never touches it.'
                      : 'Stays in this browser until you empty it from Trash.'
                  }
                >
                  <Status>This device</Status>
                </SettingRow>
                {session ? null : (
                  <SettingRow
                    title="Cloud data"
                    hint="Sign in to download or delete cloud data."
                  />
                )}
              </Group>
              {session ? (
                <CloudDeletion
                  health={health}
                  busy={busy}
                  onDelete={setDeletionScope}
                />
              ) : null}
            </Section>
          )}

          {active === 'activity' && anyMatch && (
            <ActivityLogSettings
              confirmDestructive={settings.general.confirmDestructiveActions}
            />
          )}

          {active === 'advanced' && anyMatch && (
            <Section
              title="Advanced"
              intro="Editing fallback, diagnostics, build details, and reset."
            >
              <Group title="Editing">
                <SettingRow
                  title="Direct manipulation"
                  hint="Click a face and drag its handle. Off restores the earlier editing flow."
                >
                  <Toggle
                    checked={settings.experiments.directManipulation}
                    label="Direct manipulation"
                    onChange={(directManipulation) =>
                      patch({
                        experiments: {
                          ...settings.experiments,
                          directManipulation
                        }
                      })
                    }
                  />
                </SettingRow>
              </Group>
              <Group title="Diagnostics">
                <SettingRow
                  title="Frame rate overlay"
                  hint="A movable panel over the viewport: FPS over time, 1% and 0.1% lows, frame times and draw load."
                >
                  <Toggle
                    checked={settings.experiments.frameRateOverlay}
                    label="Frame rate overlay"
                    onChange={(frameRateOverlay) =>
                      patch({
                        experiments: {
                          ...settings.experiments,
                          frameRateOverlay
                        }
                      })
                    }
                  />
                </SettingRow>
                <SettingRow
                  title="Export diagnostics"
                  hint={
                    workspaceOpen
                      ? "A sanitized snapshot of the open project's feature history, to send with a problem report."
                      : 'Open a project to export a sanitized snapshot of its feature history.'
                  }
                >
                  <button
                    className="secondary"
                    type="button"
                    disabled={!workspaceOpen}
                    onClick={onExportDiagnostics}
                  >
                    <Download size={14} aria-hidden="true" />
                    Export diagnostics
                  </button>
                </SettingRow>
                <SettingRow
                  title="Export interaction log"
                  hint="This device's log of direct-edit attempts and refusals. It stays here unless you export it."
                >
                  <button
                    className="secondary"
                    type="button"
                    onClick={onExportInteractionLog}
                  >
                    <Download size={14} aria-hidden="true" />
                    Export interaction log
                  </button>
                </SettingRow>
              </Group>
              <Group title="About this build">
                <SettingRow compact title="Geometry kernel">
                  <Status tone="good">Exact</Status>
                </SettingRow>
                <SettingRow compact title="Kernel version">
                  <Status title={kernelBuildDetail(KERNEL_BUILD)}>
                    {kernelBuildLabel(KERNEL_BUILD)}
                  </Status>
                </SettingRow>
                <SettingRow compact title="Document authority">
                  <Status tone="good">History</Status>
                </SettingRow>
                <SettingRow compact title="Exports">
                  <Status tone="good">Exact</Status>
                </SettingRow>
                <SettingRow compact title="Settings schema">
                  <Status>v{settings.schemaVersion}</Status>
                </SettingRow>
                <SettingRow compact title="Cloud project storage">
                  <Status
                    tone={
                      health?.documentStorageAccountingReady === true &&
                      health.projectObjectStorageReady === true
                        ? 'good'
                        : 'warning'
                    }
                  >
                    {health === null
                      ? 'Unavailable'
                      : health.documentStorageAccountingReady === true &&
                          health.projectObjectStorageReady === true
                        ? 'Ready'
                        : 'Not ready'}
                  </Status>
                </SettingRow>
              </Group>
              <Group title="Reset">
                <SettingRow
                  title="Reset application settings"
                  hint="Restore defaults on this device. Projects are kept."
                >
                  <button
                    className="danger-ghost"
                    type="button"
                    onClick={onReset}
                  >
                    <RefreshCcw size={14} aria-hidden="true" />
                    Reset settings
                  </button>
                </SettingRow>
              </Group>
            </Section>
          )}
        </main>
      </div>
      {deletionScope ? (
        <CloudDataDeletionDialog
          scope={deletionScope}
          onConfirm={async (scope, confirmation) => {
            await onDeleteCloudData(scope, confirmation);
            setDeletionScope(null);
          }}
          onClose={() => setDeletionScope(null)}
          onDownloadFirst={() => {
            setDeletionScope(null);
            // To the control that keeps a copy (design review I84).
            requestAnimationFrame(() => {
              const download = document.querySelector<HTMLElement>(
                '[data-download-all-data]'
              );
              download?.scrollIntoView({ block: 'center' });
              download?.focus();
            });
          }}
        />
      ) : null}
    </div>
  );
}
