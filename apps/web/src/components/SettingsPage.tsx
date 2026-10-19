import { AnalyticsConsent, CloudStatisticsConsent } from './AnalyticsConsent';
import {
  MIDDLE_DRAG_LABELS,
  POINTER_NAVIGATION_LABELS
} from '@openzcad/viewport/input-bindings';
import {
  Fragment,
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
  Bot,
  ChevronDown,
  ChevronLeft,
  CloudOff,
  Cpu,
  Database,
  Eye,
  EyeOff,
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
  Search,
  SearchX,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound
} from 'lucide-react';
import {
  CLOUD_AUTOSAVE_DELAY_BOUNDS,
  VIEWPORT_FIELD_OF_VIEW_BOUNDS,
  XRAY_OPACITY_BOUNDS,
  type AccountDeletionScope,
  type AccountStorageUsage,
  type AppSettings,
  type AppSettingsResponse,
  type AuthConfigResponse,
  type AuthSession,
  type HealthResponse
} from '@openzcad/shared';
import { countLabel } from '../lib/toasts';
import { api } from '../lib/api';
import { APP_SETTINGS_NUMBER_BOUNDS } from '../lib/appSettings';
import { isDesktopApp } from '../lib/desktopBridge';
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
import { resolveKeymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';
import { BrandMark } from './BrandMark';
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
import { CloudDataDeletionDialog } from './CloudDataDeletionDialog';
import {
  PersonalInfoToggle,
  PrivateEmailInput,
  setPersonalInfoVisible,
  usePersonalInfoVisible
} from './PersonalInfoToggle';

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1
    ? `${megabytes.toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Names the ceiling even before anyone is near it. A limit discovered only at
 * the moment a save is refused reads as a bug; a limit stated up front reads as
 * a limit.
 */
function storageHint(usage: AccountStorageUsage | null): string {
  if (!usage) {
    return 'Projects and revisions saved to your account.';
  }
  return `${countLabel(usage.projectCount, 'project', 'projects')} · ${countLabel(usage.revisionCount, 'revision', 'revisions')}. Up to ${formatBytes(usage.documentLimitBytes)} and ${usage.maxRevisionsPerProject} revisions per project.`;
}

/** Cloud file usage against the allowance, naming an overage outright. */
function fileStorageFigure(usage: AccountStorageUsage): string {
  const figure = `${formatBytes(usage.artifactBytes)} of ${formatBytes(usage.artifactLimitBytes)}`;
  return usage.artifactBytes > usage.artifactLimitBytes
    ? `${figure} · over allowance`
    : figure;
}

type SectionId = SettingsSectionId;

interface SettingsPageProps {
  settings: AppSettings;
  cloudFunctionsEnabled: boolean;
  accountState: AppSettingsResponse | null;
  authConfig: AuthConfigResponse | null;
  authConfigStatus: AuthConfigStatus;
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
  onLogout(): Promise<void>;
  onDeleteCloudData(
    scope: AccountDeletionScope,
    confirmation: string
  ): Promise<void>;
  onReset(): void;
  onApplyViewportDefaults(): void;
  onDismissProjectInvitation(): void;
  onClose(): void;
}

export type AuthConfigStatus = 'loading' | 'ready' | 'unavailable';

const SECTION_ICONS: Record<SectionId, ReactNode> = {
  general: <Settings2 size={15} aria-hidden="true" />,
  appearance: <Palette size={15} aria-hidden="true" />,
  viewport: <Move3d size={15} aria-hidden="true" />,
  controls: <Mouse size={15} aria-hidden="true" />,
  sketching: <PencilRuler size={15} aria-hidden="true" />,
  saving: <HardDrive size={15} aria-hidden="true" />,
  account: <UserRound size={15} aria-hidden="true" />,
  assistant: <Bot size={15} aria-hidden="true" />,
  privacy: <LockKeyhole size={15} aria-hidden="true" />,
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

const CREDENTIAL_OPTIONS: readonly SegmentOption<
  AppSettings['assistant']['credentialSource']
>[] = [
  { value: 'deployment', label: 'Built-in' },
  { value: 'personal', label: 'Personal token' }
];

function providerDefaults(provider: AppSettings['assistant']['provider']) {
  if (provider === 'openai') {
    return { model: 'gpt-6-luna', baseUrl: '' };
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

  useEffect(() => {
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
          callback: (token) => {
            onToken(token);
            setState('verified');
          },
          'expired-callback': () => {
            onToken('');
            setState('expired');
          },
          'error-callback': () => {
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
  }, [loadAttempt, onToken, siteKey]);

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

export function SettingsPage({
  settings,
  cloudFunctionsEnabled,
  accountState,
  authConfig,
  authConfigStatus,
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
  const [loginChallengeId, setLoginChallengeId] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [storageUsage, setStorageUsage] = useState<AccountStorageUsage | null>(
    null
  );
  const [deletionScope, setDeletionScope] =
    useState<AccountDeletionScope | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
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
  // which closes Settings: a first Enter dismissed the page. Start on the open
  // section instead. A passive effect runs after that hook has recorded the
  // opener, so focus still returns there on close.
  useEffect(() => {
    const current = document.activeElement;
    if (
      current instanceof HTMLElement &&
      current !== brandRef.current &&
      pageRef.current?.contains(current)
    ) {
      return;
    }
    const nav = navRef.current;
    (
      nav?.querySelector<HTMLElement>('[aria-current="page"]') ??
      nav?.querySelector<HTMLElement>('button')
    )?.focus();
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
        query
      }),
    [cloudFunctionsEnabled, query]
  );

  // A search that matches somewhere other than the open section should take the
  // user there, otherwise the match stays invisible behind the current section.
  useEffect(() => {
    const first = visibleSections[0];
    if (!first) {
      return;
    }
    if (!visibleSections.some((section) => section.id === active)) {
      setActive(first.id);
    }
  }, [active, visibleSections]);

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
      <header className="settings-topbar">
        <button
          ref={brandRef}
          className="brand"
          type="button"
          onClick={onClose}
        >
          <BrandMark compact />
          OpenZCAD <span className="beta-tag">Beta</span>
        </button>
        <h1 className="settings-topbar-title">Settings</h1>
        <span className="settings-save-message" aria-live="polite">
          {message}
        </span>
        <button
          className="settings-back-action"
          type="button"
          aria-label={backLabel}
          title={backLabel}
          onClick={onClose}
        >
          <ChevronLeft size={14} aria-hidden="true" />
          Back
        </button>
      </header>

      <div className="settings-layout">
        <aside className="settings-nav" aria-label="Settings sections">
          <label className="settings-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              placeholder="Find a setting"
              aria-label="Find a setting"
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={(event) => {
                // Escape clears a search before it closes Settings, as it
                // does in any search field; otherwise the filter outlived the
                // close and greeted the next visit.
                if (event.key === 'Escape' && query) {
                  event.stopPropagation();
                  changeQuery('');
                }
              }}
            />
          </label>
          {/* The narrow layout has no room for the field, so while a filter
              is narrowing the sections it shows this way out of it instead;
              without it a filter typed in a wider window stranded the rail on
              its matches. */}
          {query.trim() !== '' && (
            <button
              type="button"
              className="settings-search-clear"
              aria-label={`Clear the filter “${query.trim()}”`}
              title={`Clear the filter “${query.trim()}”`}
              onClick={() => changeQuery('')}
            >
              <SearchX size={16} aria-hidden="true" />
            </button>
          )}
          <nav ref={navRef}>
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
                  // Below 580px the label text is hidden and the icon is
                  // decorative, which would otherwise leave the button unnamed.
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
                    ? 'Cloud unreachable'
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
            <Section
              title="Controls"
              intro="Mouse, trackpad, and keyboard."
              wide
            >
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
              </Group>
              {/* Every remappable command with its live keys. A key can mean
                  one thing per context (C is Cylinder in the workspace and
                  Circle in a sketch); the editor's groups are those contexts.
                  The overrides follow the account, never a project. */}
              <Group title="Keyboard" note="Paused while you type">
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
                <SettingRow title="Linear snap" hint="In the document’s units.">
                  <NumberSetting
                    {...APP_SETTINGS_NUMBER_BOUNDS.linearSnap}
                    step={0.1}
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
              <Group title="Cloud">
                <SettingRow
                  title="Cloud autosave"
                  hint={`Off: update the cloud copy only when you save a revision${saveKeyCopy}.`}
                >
                  <Toggle
                    label="Cloud autosave"
                    checked={settings.files.cloudAutosave}
                    disabled={!cloudFunctionsEnabled}
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
                      !cloudFunctionsEnabled || !settings.files.cloudAutosave
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
                    {cloudFunctionsEnabled ? 'Manual' : 'Disabled'}
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
              <Group>
                <SettingRow
                  title="AI assistant"
                  hint="Off removes it from the workspace."
                >
                  <Toggle
                    checked={settings.assistant.enabled}
                    label="AI assistant"
                    onChange={(enabled) => patchAssistant({ enabled })}
                  />
                </SettingRow>
                <SettingRow title="Credential source">
                  <Segmented
                    label="AI credential source"
                    value={settings.assistant.credentialSource}
                    options={CREDENTIAL_OPTIONS}
                    onChange={(credentialSource) =>
                      patchAssistant({ credentialSource })
                    }
                  />
                </SettingRow>
                {settings.assistant.credentialSource === 'personal' ? null : (
                  <SettingRow
                    title="Built-in assistant"
                    hint={
                      effective
                        ? `${effective.provider} · ${effective.model} · ${effective.reasoningEffort} reasoning`
                        : 'Status appears when the server is reachable.'
                    }
                  >
                    <Status tone={effective?.configured ? 'good' : 'warning'}>
                      {effective?.configured ? 'Ready' : 'Not configured'}
                    </Status>
                  </SettingRow>
                )}
              </Group>

              {settings.assistant.credentialSource === 'personal' ? (
                <>
                  <Group title="Model">
                    <SettingRow title="Provider">
                      <select
                        value={settings.assistant.provider}
                        aria-label="AI provider"
                        onChange={(event) => {
                          const provider = event.target
                            .value as AppSettings['assistant']['provider'];
                          patchAssistant({
                            provider,
                            ...providerDefaults(provider)
                          });
                        }}
                      >
                        <option value="openrouter">OpenRouter</option>
                        <option value="openai">OpenAI</option>
                        <option value="responses-compatible">
                          Responses-compatible
                        </option>
                      </select>
                    </SettingRow>
                    {settings.assistant.provider === 'responses-compatible' ? (
                      <SettingRow
                        title="API endpoint"
                        hint="Public HTTPS only."
                      >
                        <input
                          className="settings-text-wide"
                          type="url"
                          value={settings.assistant.baseUrl}
                          placeholder="https://models.example.com/v1/responses"
                          aria-label="AI API endpoint"
                          onChange={(event) =>
                            patchAssistant({ baseUrl: event.target.value })
                          }
                        />
                      </SettingRow>
                    ) : null}
                    <SettingRow title="Model" hint="The provider’s exact id.">
                      <input
                        className="settings-text-wide mono"
                        value={settings.assistant.model}
                        aria-label="AI model"
                        onChange={(event) =>
                          patchAssistant({ model: event.target.value })
                        }
                      />
                    </SettingRow>
                    <SettingRow
                      title="Reasoning level"
                      hint="Higher plans better, costs more."
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
                        <option value="off">Off</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">Extra high</option>
                      </select>
                    </SettingRow>
                  </Group>

                  <Group title="Token">
                    {!session ? (
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
                The assistant sees feature history and your selection, never
                STEP text or meshes.
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
                            personalInfoVisible
                              ? session.displayName
                              : 'Name hidden'
                          }
                          hint={
                            personalInfoVisible
                              ? (session.email ?? session.userId)
                              : 'Email hidden'
                          }
                        >
                          <button
                            className="secondary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void onLogout().catch(() => undefined)
                            }
                          >
                            <LogOut size={14} aria-hidden="true" />
                            Sign out
                          </button>
                        </SettingRow>
                        <SettingRow
                          title="Membership"
                          hint={
                            session.entitlements
                              ? `${countLabel(session.entitlements.projectLimit, 'cloud project', 'cloud projects')} · ${formatBytes(session.entitlements.projectStorageLimitBytes)} project storage · ${formatBytes(session.entitlements.artifactLimitBytes)} cloud file storage · ${session.entitlements.ai.requestLimit} hosted AI requests per ${session.entitlements.ai.windowSeconds / 60} minutes`
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
                    ) : authConfigStatus === 'loading' ? (
                      <Notice>Checking whether sign-in is available…</Notice>
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
                        Sign-in could not be reached. Local projects are
                        unaffected.
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
                            void onVerifyLoginCode(
                              loginChallengeId,
                              loginCode.trim()
                            ).catch(() => undefined);
                          }}
                        >
                          <span>
                            <strong>Enter the email code</strong>
                            <small>
                              Sent to{' '}
                              {personalInfoVisible
                                ? loginEmail
                                : 'your email address'}
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
                              placeholder="000000"
                              // No maxLength: it cuts a pasted " 730418" before
                              // the digit filter runs and drops the last digit.
                              onChange={(event) =>
                                setLoginCode(
                                  event.target.value
                                    .replace(/\D/g, '')
                                    .slice(0, 6)
                                )
                              }
                            />
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
                                }}
                              >
                                Use another email
                              </button>
                            </span>
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
                            <small>No password. We email you a code.</small>
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
                      title="Personal information"
                      hint="Names and emails stay hidden for screenshots until you reload."
                    >
                      <PersonalInfoToggle
                        visible={personalInfoVisible}
                        onChange={setPersonalInfoVisible}
                      />
                    </SettingRow>
                    <SettingRow
                      title="Preference synchronization"
                      hint="Preferences follow your account."
                    >
                      <Status
                        tone={session && accountState ? 'good' : 'warning'}
                      >
                        {session && accountState?.synced
                          ? 'Available'
                          : session
                            ? 'Ready to save'
                            : 'Device only'}
                      </Status>
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
                  {session ? (
                    <Group title="Storage">
                      <SettingRow
                        title="Account storage"
                        hint={storageHint(storageUsage)}
                      >
                        <Status>
                          {storageUsage
                            ? formatBytes(
                                storageUsage.documentBytes +
                                  storageUsage.revisionBytes
                              )
                            : '—'}
                        </Status>
                      </SettingRow>
                      <SettingRow
                        title="Cloud file storage"
                        hint="Imports and exports. Existing files stay if you go over."
                      >
                        {storageUsage ? (
                          <span className="settings-meter-figure">
                            <Meter
                              used={storageUsage.artifactBytes}
                              limit={storageUsage.artifactLimitBytes}
                              label="Cloud file storage used"
                              valueText={fileStorageFigure(storageUsage)}
                            />
                            <span>{fileStorageFigure(storageUsage)}</span>
                          </span>
                        ) : (
                          <Status>—</Status>
                        )}
                      </SettingRow>
                    </Group>
                  ) : null}
                </>
              ) : null}
            </Section>
          )}

          {active === 'privacy' && anyMatch && (
            <Section title="Privacy & data" intro="What leaves this device.">
              <Group title="Analytics">
                <AnalyticsConsent />
                {session && !desktopApp ? (
                  <CloudStatisticsConsent
                    key={session.userId}
                    accountKey={session.userId}
                    cloudEnabled={cloudFunctionsEnabled}
                  />
                ) : null}
              </Group>
              <Group title="Your data">
                <SettingRow
                  title="Local project data"
                  hint={
                    session
                      ? 'Stays in this browser; delete it from the Trash on the start screen. The cloud deletions below never touch it.'
                      : 'Stays in this browser; delete it from the Trash on the start screen.'
                  }
                />
                {session ? null : (
                  <SettingRow
                    title="Cloud data"
                    hint="Sign in to review or delete cloud data."
                  />
                )}
              </Group>
              {session ? (
                <Group title="Delete cloud data" tone="danger">
                  {health?.accountErasureReady !== true ? (
                    <Notice>
                      Cloud data deletion isn’t available on this server yet.
                    </Notice>
                  ) : health?.projectErasureReady !== true ? (
                    <Notice>
                      Project deletion is unavailable until storage cleanup is
                      ready. Profile-only deletion remains available.
                    </Notice>
                  ) : null}
                  <SettingRow
                    title="Delete all cloud projects"
                    hint="Every project you own, with its revisions and files. Your profile stays."
                  >
                    <button
                      className="secondary danger"
                      type="button"
                      disabled={busy || health?.projectErasureReady !== true}
                      onClick={() => setDeletionScope('projects')}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Delete projects
                    </button>
                  </SettingRow>
                  <SettingRow
                    title="Delete cloud profile"
                    hint="Your email profile, synced settings, AI credential, and sessions. Projects stay, owned anonymously."
                  >
                    <button
                      className="secondary danger"
                      type="button"
                      disabled={busy || health?.accountErasureReady !== true}
                      onClick={() => setDeletionScope('profile')}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Delete profile
                    </button>
                  </SettingRow>
                  <SettingRow
                    title="Delete all cloud data"
                    hint="Profile and every project. Collaborators lose access. Can’t be undone."
                  >
                    <button
                      className="secondary danger"
                      type="button"
                      disabled={busy || health?.projectErasureReady !== true}
                      onClick={() => setDeletionScope('all')}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Delete all data
                    </button>
                  </SettingRow>
                </Group>
              ) : null}
            </Section>
          )}

          {active === 'advanced' && anyMatch && (
            <Section
              title="Advanced"
              intro="Editing fallback, build details, and reset."
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
        />
      ) : null}
    </div>
  );
}
