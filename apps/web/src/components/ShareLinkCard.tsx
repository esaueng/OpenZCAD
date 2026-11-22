import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, Copy, Link2 } from 'lucide-react';
import type { ProjectShareLinkMode } from '@openzcad/shared';
import { StableLabel } from './StableLabel';
import {
  SHARE_LINK_MODE_HINT,
  SHARE_LINK_NO_HISTORY_HINT,
  ShareLinkModePicker
} from './ShareLinkModePicker';

/**
 * The building blocks of the sharing dialog's Links tab, shared by plaintext
 * and end-to-end encrypted projects: one card per link (its name and a
 * one-line summary, opening onto its settings and actions), the card that
 * makes a new link, and a Copy button that can name the configuration the
 * copied link opens on (F06).
 */

export interface ShareLinkCardProps {
  name: string;
  /** The name is a stand-in (mode and date), not one the owner gave. */
  unnamed?: boolean;
  /** Access, history, comments and expiry, on one line. */
  summary: string;
  /** The summary reports something that needs the owner (needs confirming). */
  attention?: boolean;
  /** `frozen`: a link without history. */
  mode: ProjectShareLinkMode | 'frozen';
  expanded: boolean;
  onToggle(): void;
  /** The card's Copy control, beside its toggle. */
  copy?: ReactNode;
  /** The link's settings and actions, shown while it is open. */
  children: ReactNode;
}

export function ShareLinkCard({
  name,
  unnamed = false,
  summary,
  attention = false,
  mode,
  expanded,
  onToggle,
  copy,
  children
}: ShareLinkCardProps) {
  const bodyId = useId();
  const summaryId = useId();
  return (
    <li className="share-link-card" data-expanded={expanded || undefined}>
      <div className="share-link-card-head">
        <button
          type="button"
          className="share-link-card-toggle"
          aria-label={name}
          aria-describedby={summaryId}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="share-link-card-icon" data-mode={mode}>
            <Link2 size={14} aria-hidden="true" />
          </span>
          <span className="share-link-card-text">
            <span
              className="share-link-card-name"
              data-unnamed={unnamed || undefined}
            >
              {name}
            </span>
            <span
              id={summaryId}
              className="share-link-card-summary"
              data-attention={attention || undefined}
            >
              {summary}
            </span>
          </span>
          <ChevronDown
            className="share-link-card-chevron"
            size={14}
            aria-hidden="true"
          />
        </button>
        {copy}
      </div>
      {expanded ? (
        <div id={bodyId} className="share-link-card-body">
          {children}
        </div>
      ) : null}
    </li>
  );
}

/** A link's fixed settings, as label and value pairs. */
export function ShareLinkFacts({
  facts
}: {
  facts: readonly (readonly [label: string, value: string])[];
}) {
  return (
    <dl className="share-link-facts">
      {facts.map(([label, value]) => (
        <div key={label} className="share-link-fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface ShareLinkCopyButtonProps {
  url: string;
  /**
   * Names the link in the button's accessible name ("Copy Client review");
   * without it the button reads as its label.
   */
  name?: string;
  disabled?: boolean;
  primary?: boolean;
  /**
   * F06: the model's configurations. With any, a menu beside Copy copies a
   * link that opens on one of them.
   */
  configurations?: readonly { id: string; name: string }[];
  /** Copies `url` as given; false when the clipboard refused it. */
  onCopy(url: string, configurationId: string | null): Promise<boolean>;
}

const COPIED_MS = 2000;

export function ShareLinkCopyButton({
  url,
  name,
  disabled = false,
  primary = false,
  configurations = [],
  onCopy
}: ShareLinkCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!menuOpen) return;
    wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  const copy = (configurationId: string | null) => {
    // Picked from the menu: the keyboard goes back to the control that
    // opened it, not to the top of the dialog.
    if (menuOpen) caretRef.current?.focus();
    setMenuOpen(false);
    void onCopy(url, configurationId).then(setCopied);
  };
  const hasMenu = configurations.length > 0;

  return (
    <div
      ref={wrapRef}
      className="share-link-copy"
      data-split={hasMenu || undefined}
    >
      <button
        type="button"
        className={`share-link-copy-main${primary ? ' primary' : ''}`}
        disabled={disabled}
        {...(name ? { 'aria-label': `Copy ${name}` } : {})}
        onClick={() => copy(null)}
      >
        <Copy size={13} aria-hidden="true" />
        <StableLabel reserve={['Copied', 'Copy']} align="center">
          {copied ? 'Copied' : 'Copy'}
        </StableLabel>
      </button>
      {hasMenu ? (
        <button
          ref={caretRef}
          type="button"
          className={`share-link-copy-caret${primary ? ' primary' : ''}`}
          disabled={disabled}
          aria-label={`Copy ${name ?? 'link'} opening on a configuration`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      ) : null}
      {menuOpen ? (
        <div
          id={menuId}
          className="share-link-copy-menu"
          role="menu"
          aria-label="Copy a link that opens on"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // Closes the menu only, not the whole dialog.
              event.preventDefault();
              event.stopPropagation();
              setMenuOpen(false);
              caretRef.current?.focus();
              return;
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="menuitem"]'
              )
            ];
            const at = items.indexOf(document.activeElement as HTMLElement);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            items[(at + step + items.length) % items.length]?.focus();
          }}
        >
          <p className="share-link-copy-menu-label" aria-hidden="true">
            Copy a link that opens on
          </p>
          <button type="button" role="menuitem" onClick={() => copy(null)}>
            The saved configuration
          </button>
          {configurations.map((row) => (
            <button
              key={row.id}
              type="button"
              role="menuitem"
              onClick={() => copy(row.id)}
            >
              {row.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface ShareLinkDraft {
  mode: ProjectShareLinkMode;
  comments: boolean;
  /** L08: false shares the finished model without its history. */
  history: boolean;
  /** The owner's name for the link, as typed; empty leaves it unnamed. */
  name: string;
}

export interface ShareLinkComposerProps {
  /** L08: whether a link may leave the project's history out. */
  canExcludeHistory: boolean;
  /** The access a new link starts with. */
  defaultMode?: ProjectShareLinkMode;
  /** Whether the link can be named here. */
  nameable: boolean;
  nameMaxLength?: number;
  disabled?: boolean;
  /** Create link alone waits (links still loading); the options stay usable. */
  createDisabled?: boolean;
  /** What visitors of a commenter link see of the comments. */
  commentsHint: string;
  /** One closing line under the options, e.g. when links expire. */
  footnote: string;
  /**
   * Why a link that keeps its history cannot be made yet. Create link
   * waits on it unless history is left out.
   */
  historyBlocker?: ReactNode;
  /** Shown when the card can be closed without making a link. */
  onCancel?(): void;
  onCreate(draft: ShareLinkDraft): void;
}

export function ShareLinkComposer({
  canExcludeHistory,
  defaultMode = 'view',
  nameable,
  nameMaxLength,
  disabled = false,
  createDisabled = false,
  commentsHint,
  footnote,
  historyBlocker,
  onCancel,
  onCreate
}: ShareLinkComposerProps) {
  // Tweak includes View.
  const [mode, setMode] = useState<ProjectShareLinkMode>(defaultMode);
  const [history, setHistory] = useState(true);
  const [comments, setComments] = useState(false);
  const [name, setName] = useState('');
  const withoutHistory = canExcludeHistory && !history;
  const modeHintId = useId();
  const historyId = useId();
  const commentsId = useId();
  const blocked = Boolean(historyBlocker) && !withoutHistory;

  return (
    <form
      className="share-link-composer"
      aria-label="New link"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || createDisabled || blocked) return;
        onCreate({
          mode: withoutHistory ? 'view' : mode,
          comments,
          history: !withoutHistory,
          name
        });
      }}
    >
      <p className="share-link-composer-title">New link</p>
      {nameable ? (
        <input
          className="share-link-name-input"
          type="text"
          aria-label="Link name"
          placeholder="Who is it for? For example, Client review"
          autoComplete="off"
          maxLength={nameMaxLength}
          value={name}
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
        />
      ) : null}
      <div className="share-link-composer-mode">
        <ShareLinkModePicker
          value={mode}
          viewOnly={withoutHistory}
          disabled={disabled}
          describedBy={modeHintId}
          onChange={setMode}
        />
        <p id={modeHintId} className="sharing-hint">
          {withoutHistory
            ? 'View only: a link without history has nothing to tweak.'
            : SHARE_LINK_MODE_HINT[mode]}
        </p>
      </div>
      <div className="share-link-options">
        {canExcludeHistory ? (
          <ShareLinkOption
            id={historyId}
            label="Include history"
            hint={
              history
                ? 'Visitors see every feature and always get the latest model.'
                : SHARE_LINK_NO_HISTORY_HINT
            }
            checked={history}
            disabled={disabled}
            onChange={setHistory}
          />
        ) : null}
        <ShareLinkOption
          id={commentsId}
          label="Visitors can comment"
          hint={commentsHint}
          checked={comments}
          disabled={disabled}
          onChange={setComments}
        />
      </div>
      {blocked ? historyBlocker : null}
      <div className="share-link-composer-actions">
        <p className="sharing-hint">{footnote}</p>
        {onCancel ? (
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          className="primary"
          disabled={disabled || createDisabled || blocked}
        >
          Create link
        </button>
      </div>
    </form>
  );
}

function ShareLinkOption({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div className="share-link-option">
      <label htmlFor={id} className="share-link-option-label">
        {label}
      </label>
      <input
        id={id}
        className="share-link-switch"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.checked)}
      />
      <p id={`${id}-hint`} className="sharing-hint">
        {hint}
      </p>
    </div>
  );
}

/** Writes `url` to the clipboard; false when the page may not. */
export async function writeClipboard(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}
