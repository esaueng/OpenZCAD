import { MIDDLE_DRAG_LABELS } from '@openzcad/viewport/input-bindings';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent
} from 'react';
import {
  Accessibility,
  Bot,
  Box,
  ChevronLeft,
  CircleUserRound,
  Database,
  Eye,
  FileCog,
  Grid3x3,
  Info,
  KeyRound,
  Keyboard,
  LogIn,
  LogOut,
  Mail,
  Monitor,
  MousePointer2,
  RefreshCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2
} from 'lucide-react';
import {
  CLOUD_AUTOSAVE_DELAY_BOUNDS,
  type AccountStorageUsage,
  type AppSettings,
  type AppSettingsResponse,
  type AuthConfigResponse,
  type AuthSession,
  type HealthResponse
} from '@openzcad/shared';

/**
 * A typed number input still hands back NaN for an empty field, and the bounds
 * are the store's rather than a suggestion — a delay outside them is normalized
 * away on the way to the account, so it should never be reachable here.
 */
function clampAutosaveDelay(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return CLOUD_AUTOSAVE_DELAY_BOUNDS.default;
  }
  return Math.round(
    Math.min(
      Math.max(seconds, CLOUD_AUTOSAVE_DELAY_BOUNDS.min),
      CLOUD_AUTOSAVE_DELAY_BOUNDS.max
    )
  );
}
import { api } from '../lib/api';
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
import { BrandMark } from './BrandMark';

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
function storageDescription(usage: AccountStorageUsage | null): string {
  if (!usage) {
    return 'Sign in to see what your account is storing.';
  }
  return `${usage.projectCount} project(s) · ${formatBytes(usage.documentBytes)} current, ${formatBytes(usage.revisionBytes)} across ${usage.revisionCount} saved revision(s). Each project may be up to ${formatBytes(usage.documentLimitBytes)} and keeps its last ${usage.maxRevisionsPerProject} revisions.`;
}

type SectionId = SettingsSectionId;

interface SettingsPageProps {
  settings: AppSettings;
  accountState: AppSettingsResponse | null;
  authConfig: AuthConfigResponse | null;
  authConfigStatus: AuthConfigStatus;
  health: HealthResponse | null;
  session: AuthSession | null;
  busy: boolean;
  message: string;
  initialSection?: SectionId;
  desktopAuthorizationAttempt?: string | null;
  desktopAuthorizationApproved?: boolean;
  desktopAuthorizationCode?: string;
  onChange(settings: AppSettings): void;
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
  onReset(): void;
  onApplyViewportDefaults(): void;
  onClose(): void;
}

export type AuthConfigStatus = 'loading' | 'ready' | 'unavailable';

const SECTION_ICONS: Record<SectionId, ReactNode> = {
  general: <SlidersHorizontal size={15} aria-hidden="true" />,
  appearance: <Accessibility size={15} aria-hidden="true" />,
  viewport: <Monitor size={15} aria-hidden="true" />,
  sketching: <Grid3x3 size={15} aria-hidden="true" />,
  files: <FileCog size={15} aria-hidden="true" />,
  assistant: <Sparkles size={15} aria-hidden="true" />,
  account: <CircleUserRound size={15} aria-hidden="true" />,
  shortcuts: <Keyboard size={15} aria-hidden="true" />,
  privacy: <ShieldCheck size={15} aria-hidden="true" />,
  advanced: <Info size={15} aria-hidden="true" />
};

function Scope({ children }: { children: ReactNode }) {
  return <span className="settings-scope">{children}</span>;
}

function SettingRow({
  title,
  description,
  scope,
  children
}: {
  title: string;
  description: string;
  scope: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <span className="setting-title">
          <strong>{title}</strong>
          <Scope>{scope}</Scope>
        </span>
        <small>{description}</small>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange
}: {
  checked: boolean;
  label: string;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true" />
    </label>
  );
}

function Section({
  title,
  intro,
  wide = false,
  children
}: {
  title: string;
  intro: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`settings-section${wide ? ' settings-section-wide' : ''}`}
    >
      <header>
        <h2>{title}</h2>
        <p>{intro}</p>
      </header>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function ControlReferenceGroups({
  groups
}: {
  groups: readonly ControlReferenceGroup[];
}) {
  return (
    <div className="settings-control-groups">
      {groups.map((group) => (
        <section className="settings-control-group" key={group.id}>
          <header>
            <h4>{group.title}</h4>
            <span>{group.items.length} controls</span>
          </header>
          <p>{group.description}</p>
          <dl>
            {group.items.map((item) => (
              <div className="settings-control-row" key={item.id}>
                <dt>
                  <span className="settings-control-keys">
                    {item.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                </dt>
                <dd>
                  <strong>{item.action}</strong>
                  <small>{item.detail}</small>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function ControlReferenceCollection({
  icon,
  title,
  description,
  groups
}: {
  icon: ReactNode;
  title: string;
  description: string;
  groups: readonly ControlReferenceGroup[];
}) {
  return (
    <section className="settings-control-collection">
      <header>
        <span className="settings-control-collection-icon">{icon}</span>
        <span>
          <h3>{title}</h3>
          <p>{description}</p>
        </span>
      </header>
      <ControlReferenceGroups groups={groups} />
    </section>
  );
}

function providerDefaults(provider: AppSettings['assistant']['provider']) {
  if (provider === 'openai') {
    return { model: 'gpt-5.6-sol', baseUrl: '' };
  }
  if (provider === 'openrouter') {
    return { model: 'openai/gpt-5.6-sol', baseUrl: '' };
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
  accountState,
  authConfig,
  authConfigStatus,
  health,
  session,
  busy,
  message,
  initialSection,
  desktopAuthorizationAttempt = null,
  desktopAuthorizationApproved = false,
  desktopAuthorizationCode = '',
  onChange,
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
  onReset,
  onApplyViewportDefaults,
  onClose
}: SettingsPageProps) {
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
  const [loginCode, setLoginCode] = useState('');
  const [loginChallengeId, setLoginChallengeId] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [storageUsage, setStorageUsage] = useState<AccountStorageUsage | null>(
    null
  );
  const contentRef = useRef<HTMLElement>(null);
  const scrollTopRef = useRef(
    initialSection === undefined ? initialViewState.scrollTop : 0
  );
  const activeRef = useRef(active);
  const queryRef = useRef(query);

  activeRef.current = active;
  queryRef.current = query;

  const persistCurrentView = () =>
    updateSettingsViewState({
      activeSection: activeRef.current,
      query: queryRef.current,
      scrollTop: scrollTopRef.current
    });

  // Fetched only when the panel that shows it is open, and dropped on sign-out
  // so one account's totals never linger in front of another.
  useEffect(() => {
    if (active !== 'files' || !session) {
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
  }, [active, session]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
    () => visibleSettingsSections({ query }),
    [query]
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

  return (
    <div
      className={`settings-page density-${settings.appearance.density}`}
      data-reduced-motion={settings.appearance.reducedMotion ? 'true' : 'false'}
    >
      <header className="settings-topbar">
        <button className="brand" type="button" onClick={onClose}>
          <BrandMark compact />
          OpenZCAD <span className="beta-tag">Beta</span>
        </button>
        <h1 className="settings-topbar-title">Settings</h1>
        <span className="settings-save-message" aria-live="polite">
          {message}
        </span>
        <button className="primary" type="button" onClick={onClose}>
          <ChevronLeft size={14} aria-hidden="true" />
          Back to workspace
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
              onChange={(event) => {
                const nextQuery = event.target.value;
                queryRef.current = nextQuery;
                setQuery(nextQuery);
                updateSettingsViewState({ query: nextQuery });
              }}
            />
          </label>
          <nav>
            {visibleSections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={active === section.id ? 'active' : ''}
                // Below 580px the label text is hidden and the icon is
                // decorative, which would otherwise leave the button unnamed.
                aria-label={section.label}
                aria-current={active === section.id ? 'page' : undefined}
                onClick={() => setActive(section.id)}
              >
                {SECTION_ICONS[section.id]}
                <span>
                  <strong>{section.label}</strong>
                  <small>{section.detail}</small>
                </span>
              </button>
            ))}
            {visibleSections.length === 0 && (
              <p className="settings-nav-empty" role="status">
                No settings match “{query.trim()}”.
              </p>
            )}
          </nav>
          <div className="settings-nav-status">
            <Database size={13} aria-hidden="true" />
            <span>
              <strong>
                {session ? 'Cloud profile connected' : 'Device only'}
              </strong>
              <small>Local changes save immediately</small>
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
          {active === 'general' && (
            <Section
              title="General"
              intro="Choose how OpenZCAD starts and what a new project inherits. Existing document units are never reinterpreted."
            >
              <SettingRow
                title="Reopen the last project"
                description="Return to the most recently active model when OpenZCAD starts."
                scope="This device"
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
                title="Default units"
                description="Used only when creating a new project."
                scope="New projects"
              >
                <select
                  value={settings.general.defaultUnits}
                  aria-label="Default units"
                  onChange={(event) =>
                    patch({
                      general: {
                        ...settings.general,
                        defaultUnits: event.target
                          .value as AppSettings['general']['defaultUnits']
                      }
                    })
                  }
                >
                  <option value="mm">Millimeters</option>
                  <option value="cm">Centimeters</option>
                  <option value="m">Meters</option>
                  <option value="inch">Inches</option>
                </select>
              </SettingRow>
              <SettingRow
                title="Confirm destructive actions"
                description="Ask before clearing saved preferences or removing a personal credential."
                scope="All devices"
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
            </Section>
          )}

          {active === 'appearance' && (
            <Section
              title="Appearance & accessibility"
              intro="Keep the engineering workspace dense, readable, and predictable."
            >
              <SettingRow
                title="Theme"
                description="OpenZCAD currently uses its exact-workspace dark palette; System follows dark-capable hosts."
                scope="This device"
              >
                <select
                  value={settings.appearance.theme}
                  aria-label="Theme"
                  onChange={(event) =>
                    patch({
                      appearance: {
                        ...settings.appearance,
                        theme: event.target
                          .value as AppSettings['appearance']['theme']
                      }
                    })
                  }
                >
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                </select>
              </SettingRow>
              <SettingRow
                title="Interface density"
                description="Comfortable adds breathing room without changing modeling behavior."
                scope="This device"
              >
                <select
                  value={settings.appearance.density}
                  aria-label="Interface density"
                  onChange={(event) =>
                    patch({
                      appearance: {
                        ...settings.appearance,
                        density: event.target
                          .value as AppSettings['appearance']['density']
                      }
                    })
                  }
                >
                  <option value="compact">Compact</option>
                  <option value="comfortable">Comfortable</option>
                </select>
              </SettingRow>
              <SettingRow
                title="Reduce motion"
                description="Suppress non-essential panel and selection animations."
                scope="This device"
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
            </Section>
          )}

          {active === 'viewport' && (
            <Section
              title="Viewport"
              intro="Set defaults for new or previously unopened project views. Per-project camera state remains local."
            >
              <SettingRow
                title="Projection"
                description="Perspective reads naturally; orthographic is useful for measured views."
                scope="View default"
              >
                <select
                  value={settings.viewport.defaultProjection}
                  aria-label="Default projection"
                  onChange={(event) =>
                    patch({
                      viewport: {
                        ...settings.viewport,
                        defaultProjection: event.target
                          .value as AppSettings['viewport']['defaultProjection']
                      }
                    })
                  }
                >
                  <option value="perspective">Perspective</option>
                  <option value="orthographic">Orthographic</option>
                </select>
              </SettingRow>
              <SettingRow
                title="Show construction grid"
                description="The grid is a viewport aid and never becomes document geometry."
                scope="View default"
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
                title="Zoom toward the pointer"
                description="Wheel zoom moves toward whatever is under the cursor, the way Fusion and SolidWorks do. Turn this off to zoom toward the middle of the view instead."
                scope="Navigation"
              >
                <Toggle
                  checked={settings.viewport.zoomToCursor}
                  label="Zoom to cursor"
                  onChange={(zoomToCursor) =>
                    patch({
                      viewport: { ...settings.viewport, zoomToCursor }
                    })
                  }
                />
              </SettingRow>
              <SettingRow
                title="Middle-button drag"
                description="What dragging with the middle mouse button does. Pan matches Fusion, SolidWorks, and Onshape; zoom is the three.js default."
                scope="Navigation"
              >
                <select
                  aria-label="Middle-button drag"
                  value={settings.viewport.middleDrag}
                  onChange={(event) =>
                    patch({
                      viewport: {
                        ...settings.viewport,
                        middleDrag: event.target
                          .value as AppSettings['viewport']['middleDrag']
                      }
                    })
                  }
                >
                  {(['pan', 'orbit', 'zoom'] as const).map((action) => (
                    <option key={action} value={action}>
                      {MIDDLE_DRAG_LABELS[action]}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow
                title="Display mode"
                description="Choose the default solid and edge presentation."
                scope="View default"
              >
                <select
                  value={settings.viewport.displayMode}
                  aria-label="Default display mode"
                  onChange={(event) =>
                    patch({
                      viewport: {
                        ...settings.viewport,
                        displayMode: event.target
                          .value as AppSettings['viewport']['displayMode']
                      }
                    })
                  }
                >
                  <option value="shaded-edges">Shaded + edges</option>
                  <option value="shaded">Shaded</option>
                  <option value="wireframe">Wireframe</option>
                </select>
              </SettingRow>
              <div className="settings-card-action">
                <button
                  className="secondary"
                  type="button"
                  onClick={onApplyViewportDefaults}
                >
                  <Eye size={14} aria-hidden="true" />
                  Apply defaults to current view
                </button>
              </div>
            </Section>
          )}

          {active === 'sketching' && (
            <Section
              title="Sketching & snapping"
              intro="Grid placement, geometry snapping, and temporary inferencing are independent. Stored dimensions remain exact document values."
            >
              <SettingRow
                title="Show sketch grid"
                description="Display an adaptive grid on the active sketch plane."
                scope="This device"
              >
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
                description="Quantize sketch points to the configured linear increment. Geometry snaps still take priority."
                scope="This device"
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
              <SettingRow
                title="Geometry snapping"
                description="Snap to exact origins, endpoints, midpoints, centers, quadrants, and intersections."
                scope="This device"
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
              <SettingRow
                title="Automatic inferencing"
                description="Offer horizontal and vertical alignment while drawing. Hold Shift to suppress it temporarily."
                scope="This device"
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
              <SettingRow
                title="Linear snap"
                description="Increment in the current document unit."
                scope="This device"
              >
                <input
                  className="settings-number"
                  type="number"
                  min="0.001"
                  max="10000"
                  step="0.1"
                  value={settings.sketching.linearSnap}
                  aria-label="Linear snap increment"
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    if (
                      Number.isFinite(value) &&
                      value >= 0.001 &&
                      value <= 10_000
                    ) {
                      patch({
                        sketching: {
                          ...settings.sketching,
                          linearSnap: value
                        }
                      });
                    }
                  }}
                />
              </SettingRow>
              <SettingRow
                title="Snap tolerance"
                description="Screen-space radius around exact sketch candidates."
                scope="This device"
              >
                <div className="settings-unit-input">
                  <input
                    className="settings-number"
                    type="number"
                    min="4"
                    max="24"
                    step="1"
                    value={settings.sketching.snapTolerancePx}
                    aria-label="Sketch snap tolerance"
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (Number.isFinite(value) && value >= 4 && value <= 24) {
                        patch({
                          sketching: {
                            ...settings.sketching,
                            snapTolerancePx: value
                          }
                        });
                      }
                    }}
                  />
                  <span>px</span>
                </div>
              </SettingRow>
              <SettingRow
                title="Angular snap"
                description="Reserved for rotate and future sketch constraint tools."
                scope="Input default"
              >
                <div className="settings-unit-input">
                  <input
                    className="settings-number"
                    type="number"
                    min="1"
                    max="90"
                    step="1"
                    value={settings.sketching.angleSnap}
                    aria-label="Angular snap increment"
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (Number.isFinite(value)) {
                        patch({
                          sketching: {
                            ...settings.sketching,
                            angleSnap: value
                          }
                        });
                      }
                    }}
                  />
                  <span>°</span>
                </div>
              </SettingRow>
              <SettingRow
                title="Direct manipulation (experimental)"
                description="Selection-first editing: click a face to arm an offset handle and drag it on the model."
                scope="This device"
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
            </Section>
          )}

          {active === 'files' && (
            <Section
              title="Files & autosave"
              intro="Recovery behavior is visible here, but durability protections are not optional toggles."
            >
              <SettingRow
                title="Local autosave"
                description="Canonical documents are saved to IndexedDB shortly after every edit."
                scope="Always on"
              >
                <span className="settings-state good">Active</span>
              </SettingRow>
              <SettingRow
                title="Cloud autosave"
                description="Copy a project your account holds to the account shortly after you stop editing. Turn it off to update your account only with Ctrl/Cmd+S."
                scope="Account"
              >
                <Toggle
                  label="Cloud autosave"
                  checked={settings.files.cloudAutosave}
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
                description="Quiet time before the copy is written. A continuous edit is still written at least once a minute."
                scope="Account"
              >
                <input
                  type="number"
                  aria-label="Cloud autosave delay in seconds"
                  disabled={!settings.files.cloudAutosave}
                  min={CLOUD_AUTOSAVE_DELAY_BOUNDS.min}
                  max={CLOUD_AUTOSAVE_DELAY_BOUNDS.max}
                  step={1}
                  value={settings.files.cloudAutosaveDelaySeconds}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      files: {
                        ...settings.files,
                        cloudAutosaveDelaySeconds: clampAutosaveDelay(
                          event.target.valueAsNumber
                        )
                      }
                    })
                  }
                />
              </SettingRow>
              <SettingRow
                title="Cloud revisions"
                description="Ctrl/Cmd+S creates an explicit owner-scoped checkpoint. Autosave does not add to this history."
                scope="Current project"
              >
                <span className="settings-state">Manual</span>
              </SettingRow>
              <SettingRow
                title="Account storage"
                description={storageDescription(storageUsage)}
                scope="Account"
              >
                <span className="settings-state">
                  {storageUsage
                    ? formatBytes(
                        storageUsage.documentBytes + storageUsage.revisionBytes
                      )
                    : '—'}
                </span>
              </SettingRow>
              <SettingRow
                title="STEP and STL exports"
                description="Exports are generated and validated by the same browser geometry worker as the viewport."
                scope="Exact pipeline"
              >
                <Box size={16} aria-hidden="true" />
              </SettingRow>
            </Section>
          )}

          {active === 'assistant' && (
            <Section
              title="AI Assistant"
              intro="Choose a deployment-managed assistant or store an encrypted personal credential. Proposals remain previewable and explicitly applied."
            >
              <SettingRow
                title="AI assistant"
                description="When off, the assistant is removed from the workspace and the server refuses assistant requests."
                scope="All devices"
              >
                <Toggle
                  checked={settings.assistant.enabled}
                  label="AI assistant"
                  onChange={(enabled) => patchAssistant({ enabled })}
                />
              </SettingRow>
              <SettingRow
                title="Credential source"
                description="Deployment credentials are managed by the operator; personal tokens are owner-scoped."
                scope="Account"
              >
                <select
                  value={settings.assistant.credentialSource}
                  aria-label="AI credential source"
                  onChange={(event) =>
                    patchAssistant({
                      credentialSource: event.target
                        .value as AppSettings['assistant']['credentialSource']
                    })
                  }
                >
                  <option value="deployment">Deployment default</option>
                  <option value="personal">Personal token</option>
                </select>
              </SettingRow>

              {settings.assistant.credentialSource === 'personal' ? (
                <>
                  <SettingRow
                    title="Provider"
                    description="Known providers use their official Responses endpoint automatically."
                    scope="Account"
                  >
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
                      description="Beta requires a public HTTPS Responses endpoint; private-network targets are rejected."
                      scope="Account"
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
                  <SettingRow
                    title="Model"
                    description="Use the provider's exact model identifier."
                    scope="Account"
                  >
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
                    description="Higher levels can improve complex CAD planning at greater cost and latency."
                    scope="Account"
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
                      <option value="provider-default">Provider default</option>
                      <option value="off">Off</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="xhigh">XHigh</option>
                    </select>
                  </SettingRow>
                  <SettingRow
                    title="Output budget"
                    description="Reasoning and patch output share this token ceiling."
                    scope="Advanced AI"
                  >
                    <input
                      className="settings-number"
                      type="number"
                      min="1024"
                      max="128000"
                      step="1024"
                      value={settings.assistant.maxOutputTokens}
                      aria-label="Maximum output tokens"
                      onChange={(event) => {
                        const value = event.currentTarget.valueAsNumber;
                        if (Number.isFinite(value)) {
                          patchAssistant({ maxOutputTokens: value });
                        }
                      }}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Request timeout"
                    description="Bounded between 5 and 300 seconds."
                    scope="Advanced AI"
                  >
                    <div className="settings-unit-input">
                      <input
                        className="settings-number"
                        type="number"
                        min="5"
                        max="300"
                        value={settings.assistant.timeoutMs / 1000}
                        aria-label="AI timeout seconds"
                        onChange={(event) => {
                          const value = event.currentTarget.valueAsNumber;
                          if (Number.isFinite(value)) {
                            patchAssistant({ timeoutMs: value * 1000 });
                          }
                        }}
                      />
                      <span>s</span>
                    </div>
                  </SettingRow>
                  <SettingRow
                    title="Personal API token"
                    description={
                      credential?.stored
                        ? `Saved as ${credential.hint}. The token cannot be revealed after saving.`
                        : 'Sent once to the Worker and encrypted before storage. Never stored in the browser.'
                    }
                    scope="Encrypted"
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
                        aria-label="Personal AI API token"
                        onChange={(event) => setToken(event.target.value)}
                      />
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={showToken ? 'Hide token' : 'Show token'}
                        onClick={() => setShowToken((current) => !current)}
                      >
                        <KeyRound size={14} aria-hidden="true" />
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
                  {!session ? (
                    <div className="settings-warning settings-sign-in-warning">
                      <span>
                        Sign in to store a personal token in your encrypted
                        cloud profile.
                      </span>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => setActive('account')}
                      >
                        <LogIn size={14} aria-hidden="true" />
                        Sign in
                      </button>
                    </div>
                  ) : credential && !credential.storageAvailable ? (
                    <div className="settings-warning">
                      Personal credential storage requires the D1 migration and
                      SETTINGS_ENCRYPTION_KEY Worker secret.
                    </div>
                  ) : null}
                  <div className="settings-card-action split">
                    <span
                      className={
                        effective?.configured
                          ? 'settings-state good'
                          : 'settings-state warning'
                      }
                    >
                      {!session
                        ? 'Sign in to use a personal credential'
                        : effective?.configured
                          ? `Ready · ${effective.model} · ${effective.reasoningEffort}`
                          : 'Personal assistant is not ready'}
                    </span>
                    <span>
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
                  </div>
                  <label className="settings-long-field">
                    <span>
                      <strong>CAD assistant preferences</strong>
                      <Scope>Account</Scope>
                    </span>
                    <small>
                      Optional manufacturing context and typical clearances. It
                      cannot override schema, safety, or review rules.
                    </small>
                    <textarea
                      rows={5}
                      maxLength={4000}
                      value={settings.assistant.customInstructions}
                      onChange={(event) =>
                        patchAssistant({
                          customInstructions: event.target.value
                        })
                      }
                    />
                  </label>
                </>
              ) : (
                <div className="settings-deployment-summary">
                  <Bot size={18} aria-hidden="true" />
                  <span>
                    <strong>
                      {effective?.configured
                        ? 'Deployment assistant ready'
                        : 'Deployment assistant not configured'}
                    </strong>
                    <small>
                      {effective
                        ? `${effective.provider} · ${effective.model} · ${effective.reasoningEffort} reasoning`
                        : 'Configuration status will appear when the API is available.'}
                    </small>
                  </span>
                </div>
              )}

              <div className="settings-privacy-note">
                <ShieldCheck size={15} aria-hidden="true" />
                <span>
                  <strong>Review boundary stays on</strong>
                  <small>
                    The assistant receives compact feature history and active
                    selection, never embedded STEP text or mesh arrays. Every
                    proposal must still be previewed or explicitly applied.
                  </small>
                </span>
              </div>
            </Section>
          )}

          {active === 'account' && (
            <Section
              title="Account & collaboration"
              intro="The CAD workspace stays local and usable without an account. Sign in only when you want a cloud profile."
            >
              <SettingRow
                title="Project sharing"
                description="Allow invitations and live collaboration. Turning this off stops collaboration connections; cloud autosave remains separate."
                scope="Account preference"
              >
                <Toggle
                  checked={settings.collaboration.enabled}
                  label="Project sharing"
                  onChange={(enabled) => patchCollaboration({ enabled })}
                />
              </SettingRow>
              {session ? (
                <>
                  <SettingRow
                    title={session.displayName}
                    description={session.email ?? session.userId}
                    scope={
                      session.mode === 'email-code'
                        ? 'Email profile'
                        : 'Development'
                    }
                  >
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => void onLogout().catch(() => undefined)}
                    >
                      <LogOut size={14} aria-hidden="true" />
                      Sign out
                    </button>
                  </SettingRow>
                  {desktopAuthorizationAttempt ? (
                    <div
                      className={
                        desktopAuthorizationApproved
                          ? 'settings-state good'
                          : 'settings-warning settings-sign-in-warning'
                      }
                      role="status"
                    >
                      <span>
                        {desktopAuthorizationApproved
                          ? 'OpenZCAD for macOS is connected. You can return to the app.'
                          : 'Enter the 8-character code shown in your OpenZCAD for macOS window before connecting this cloud profile.'}
                      </span>
                      {!desktopAuthorizationApproved ? (
                        <>
                          <label className="settings-field settings-field-inline">
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
                              busy || desktopAuthorizationCode.trim().length < 8
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
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <SettingRow
                    title="Cloud profile"
                    description="Your projects and device settings remain available locally when signed out."
                    scope="Optional"
                  >
                    <CircleUserRound size={18} aria-hidden="true" />
                  </SettingRow>
                  {authConfigStatus === 'loading' ? (
                    <div className="settings-warning" role="status">
                      Checking beta email sign-in readiness. Device settings and
                      local CAD projects remain available.
                    </div>
                  ) : authConfigStatus === 'unavailable' ? (
                    <div
                      className="settings-warning settings-sign-in-warning"
                      role="alert"
                    >
                      <span>
                        Beta sign-in configuration could not be reached. Check
                        the connection or retry; local CAD remains available.
                      </span>
                      <button
                        className="secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => void onRefreshAuthConfig()}
                      >
                        <RefreshCcw size={13} aria-hidden="true" />
                        Retry
                      </button>
                    </div>
                  ) : desktopApp ? (
                    authConfig?.desktopAuthEnabled ? (
                      <div className="settings-auth-form">
                        <span>
                          <strong>Sign in with your browser</strong>
                          <small>
                            Turnstile and the email code stay in your browser.
                            macOS stores only the rotating refresh credential in
                            Keychain.
                          </small>
                        </span>
                        <div className="settings-auth-controls">
                          <button
                            className="primary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void onStartDesktopLogin().catch(() => undefined)
                            }
                          >
                            <LogIn size={14} aria-hidden="true" />
                            Continue in browser
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="settings-warning" role="status">
                        Desktop sign-in is not ready on this beta Worker. Device
                        settings and local CAD projects remain available.
                      </div>
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
                            We sent a six-digit code to {loginEmail}. It expires
                            in 10 minutes.
                          </small>
                        </span>
                        <div className="settings-auth-controls">
                          <input
                            className="mono"
                            value={loginCode}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            aria-label="Email sign-in code"
                            placeholder="000000"
                            onChange={(event) =>
                              setLoginCode(
                                event.target.value
                                  .replace(/\D/g, '')
                                  .slice(0, 6)
                              )
                            }
                          />
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
                            No password required. We will send a single-use
                            code.
                          </small>
                        </span>
                        <div className="settings-auth-controls">
                          <label>
                            <span>Email</span>
                            <input
                              type="email"
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
                    <div className="settings-warning" role="status">
                      Email sign-in is not ready on this beta Worker. Device
                      settings and local CAD projects remain available.
                    </div>
                  )}
                </>
              )}
              <SettingRow
                title="Preference synchronization"
                description="Non-secret preferences can follow this account; local persistence remains the offline fallback."
                scope="Account"
              >
                <span
                  className={
                    session && accountState
                      ? 'settings-state good'
                      : 'settings-state warning'
                  }
                >
                  {session && accountState?.synced
                    ? 'Available'
                    : session
                      ? 'Ready to save'
                      : 'Device only'}
                </span>
              </SettingRow>
            </Section>
          )}

          {active === 'shortcuts' && (
            <Section
              title="Controls & shortcuts"
              intro="A complete reference for keyboard commands, viewport navigation, selection, sketching, and direct modeling."
              wide
            >
              <div className="settings-controls-note">
                <Keyboard size={18} aria-hidden="true" />
                <span>
                  <strong>Shortcuts are fixed and context-aware.</strong>
                  <small>
                    Workspace commands pause while you type or while Settings is
                    open. Sketch mode reuses C and R for Circle and Rectangle.
                  </small>
                </span>
              </div>
              <ControlReferenceCollection
                icon={<Keyboard size={18} aria-hidden="true" />}
                title="Keyboard"
                description="Commands are grouped by the part of the workspace that owns them."
                groups={KEYBOARD_CONTROL_GROUPS}
              />
              <ControlReferenceCollection
                icon={<MousePointer2 size={18} aria-hidden="true" />}
                title="Mouse & pointer"
                description="Directional gestures matter: selection-box behavior changes with drag direction."
                groups={POINTER_CONTROL_GROUPS}
              />
            </Section>
          )}

          {active === 'privacy' && (
            <Section
              title="Privacy & data"
              intro="Device preferences are separate from canonical project documents, exports, and collaboration messages."
            >
              <SettingRow
                title="Reset application settings"
                description="Restore defaults on this device. Projects and their revision history are not deleted."
                scope="This device"
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
              <SettingRow
                title="Project data"
                description="Local projects remain in IndexedDB until a dedicated project deletion flow is used."
                scope="Protected"
              >
                <ShieldCheck size={17} aria-hidden="true" />
              </SettingRow>
            </Section>
          )}

          {active === 'advanced' && (
            <Section
              title="Advanced & diagnostics"
              intro="These architectural guarantees are intentionally visible and non-configurable."
            >
              <SettingRow
                title="Geometry kernel"
                description="Exact B-rep rebuilds and exports run in a dedicated browser worker."
                scope="Required"
              >
                <span className="settings-state good">Exact</span>
              </SettingRow>
              <SettingRow
                title="Kernel version"
                description="The pinned kernel build this app was compiled against. Quote it when reporting a geometry defect."
                scope="Diagnostics"
              >
                <span className="mono" title={kernelBuildDetail(KERNEL_BUILD)}>
                  {kernelBuildLabel(KERNEL_BUILD)}
                </span>
              </SettingRow>
              <SettingRow
                title="Document authority"
                description="Canonical feature history is the source of truth; viewport meshes are disposable projections."
                scope="Required"
              >
                <span className="settings-state good">History</span>
              </SettingRow>
              <SettingRow
                title="Settings schema"
                description="Versioned independently from the project document schema."
                scope="Diagnostics"
              >
                <span className="mono">v{settings.schemaVersion}</span>
              </SettingRow>
              <SettingRow
                title="Cloud project storage"
                description="Migrations 0010 and 0011 plus private R2 project storage must be ready before personal device sync can be enabled."
                scope="Diagnostics"
              >
                <span
                  className={`settings-state ${health?.documentStorageAccountingReady === true && health.projectObjectStorageReady === true ? 'good' : 'warning'}`}
                >
                  {health === null
                    ? 'Unavailable'
                    : health.documentStorageAccountingReady === true &&
                        health.projectObjectStorageReady === true
                      ? 'Ready'
                      : 'Not ready'}
                </span>
              </SettingRow>
            </Section>
          )}
        </main>
      </div>
    </div>
  );
}
