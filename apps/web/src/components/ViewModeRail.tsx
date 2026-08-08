import { Eye, EyeOff, Layers3, PanelLeftClose, Scan } from 'lucide-react';
import type { BodyRepresentation } from '@openzcad/shared';

interface ViewModeRailProps {
  /** Live bodies, hidden ones included — this is the list that unhides them. */
  bodies: BodyRepresentation[];
  hiddenBodyIds: ReadonlySet<string>;
  selectedBodyIds: string[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelectBody(bodyId: string, additive: boolean): void;
  onToggleVisibility(bodyId: string): void;
  /** Hides every other body; running it on the only visible body undoes it. */
  onIsolate(bodyId: string): void;
  onShowAll(): void;
}

/**
 * View mode's parts list: what the model is made of, and which parts are on
 * screen. Visibility is viewport state rather than a document edit, so this is
 * the one panel View mode can offer without contradicting its read-only
 * promise — there is no history, no parameters and no reordering here.
 *
 * Collapses to a launcher, which is what leaves a single-body model with the
 * bare viewport it deserves.
 */
export function ViewModeRail({
  bodies,
  hiddenBodyIds,
  selectedBodyIds,
  open,
  onOpenChange,
  onSelectBody,
  onToggleVisibility,
  onIsolate,
  onShowAll
}: ViewModeRailProps) {
  const hiddenCount = bodies.filter((body) =>
    hiddenBodyIds.has(body.bodyId)
  ).length;

  if (!open) {
    return (
      <button
        type="button"
        className="view-mode-rail-launcher"
        title="Show the parts list"
        aria-label="Show the parts list"
        onClick={() => onOpenChange(true)}
      >
        <Layers3 size={14} aria-hidden="true" />
        {bodies.length}
      </button>
    );
  }

  return (
    <aside className="view-mode-rail" aria-label="Parts">
      <header className="view-mode-rail-head">
        <h2>Parts</h2>
        <span className="view-mode-rail-count">{bodies.length}</span>
        <button
          type="button"
          className="view-mode-rail-collapse"
          title="Hide the parts list"
          aria-label="Hide the parts list"
          onClick={() => onOpenChange(false)}
        >
          <PanelLeftClose size={13} aria-hidden="true" />
        </button>
      </header>
      <div className="view-mode-rail-list" role="list">
        {bodies.length === 0 && (
          <p className="view-mode-rail-empty">
            This project has no bodies yet.
          </p>
        )}
        {bodies.map((body) => {
          const hidden = hiddenBodyIds.has(body.bodyId);
          const selected = selectedBodyIds.includes(body.bodyId);
          return (
            <div
              key={body.bodyId}
              className={`view-mode-rail-row${selected ? ' selected' : ''}${
                hidden ? ' hidden-body' : ''
              }`}
              role="listitem"
            >
              <button
                type="button"
                className="view-mode-rail-name"
                aria-pressed={selected}
                title={`${body.name} — click to select, ⇧click to add`}
                onClick={(event) =>
                  onSelectBody(
                    body.bodyId,
                    event.shiftKey || event.metaKey || event.ctrlKey
                  )
                }
              >
                <span
                  className="view-mode-rail-swatch"
                  style={{ background: body.color }}
                  aria-hidden="true"
                />
                <span className="view-mode-rail-label">{body.name}</span>
              </button>
              <button
                type="button"
                className="view-mode-rail-action"
                title={`Show only ${body.name}`}
                aria-label={`Show only ${body.name}`}
                onClick={() => onIsolate(body.bodyId)}
              >
                <Scan size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`view-mode-rail-action${hidden ? ' is-hidden' : ''}`}
                title={hidden ? `Show ${body.name}` : `Hide ${body.name}`}
                aria-label={hidden ? `Show ${body.name}` : `Hide ${body.name}`}
                aria-pressed={hidden}
                onClick={() => onToggleVisibility(body.bodyId)}
              >
                {hidden ? (
                  <EyeOff size={12} aria-hidden="true" />
                ) : (
                  <Eye size={12} aria-hidden="true" />
                )}
              </button>
            </div>
          );
        })}
      </div>
      <footer className="view-mode-rail-foot">
        {hiddenCount > 0 ? (
          <button type="button" onClick={onShowAll}>
            Show all ({hiddenCount} hidden)
          </button>
        ) : (
          <span>Visibility only — geometry is locked in View mode.</span>
        )}
      </footer>
    </aside>
  );
}
