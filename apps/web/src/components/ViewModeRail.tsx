import { Eye, EyeOff, Layers3, Scan } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BodyRepresentation } from '@openzcad/shared';
import { Tooltip } from './Tooltip';

interface PartsProps {
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
 * The rail's Parts button: opens the parts list beside the rail and wears
 * the part count. With parts hidden, a second button brings them all back
 * without opening the list.
 */
export function PartsRailButtons({
  bodies,
  hiddenBodyIds,
  open,
  onOpenChange,
  onShowAll
}: Pick<
  PartsProps,
  'bodies' | 'hiddenBodyIds' | 'open' | 'onOpenChange' | 'onShowAll'
>) {
  const hiddenCount = bodies.filter((body) =>
    hiddenBodyIds.has(body.bodyId)
  ).length;
  return (
    <>
      <Tooltip
        label="Parts"
        description={
          open
            ? 'Hide the parts list'
            : `Show the parts list — ${bodies.length} ${bodies.length === 1 ? 'part' : 'parts'}`
        }
      >
        <button
          type="button"
          className={open ? 'active' : undefined}
          aria-label={open ? 'Hide the parts list' : 'Show the parts list'}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <Layers3 size={16} aria-hidden="true" />
          <span className="rail-count" aria-hidden="true">
            {bodies.length}
          </span>
        </button>
      </Tooltip>
      {hiddenCount > 0 && (
        <Tooltip
          label="Show all"
          description={`${hiddenCount} ${hiddenCount === 1 ? 'part is' : 'parts are'} hidden`}
        >
          <button
            type="button"
            aria-label={`Show all (${hiddenCount} hidden)`}
            onClick={onShowAll}
          >
            <EyeOff size={16} aria-hidden="true" />
            <span className="rail-count" aria-hidden="true">
              {hiddenCount}
            </span>
          </button>
        </Tooltip>
      )}
    </>
  );
}

/**
 * The parts list itself: what the model is made of, and which parts are on
 * screen. Visibility is viewport state rather than a document edit, so this
 * is the one panel View mode can offer without contradicting its read-only
 * promise — there is no history, no parameters and no reordering here.
 */
export function PartsList({
  bodies,
  hiddenBodyIds,
  selectedBodyIds,
  onSelectBody,
  onToggleVisibility,
  onIsolate,
  onShowAll
}: Omit<PartsProps, 'open' | 'onOpenChange'>) {
  const hiddenCount = bodies.filter((body) =>
    hiddenBodyIds.has(body.bodyId)
  ).length;
  return (
    <aside className="view-mode-rail" aria-label="Parts">
      <header className="view-mode-rail-head">
        <h2>Parts</h2>
        <span className="view-mode-rail-count">{bodies.length}</span>
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

/**
 * View mode's left side: the same thin icon rail as Build, sketching and
 * Tweak, holding the Parts button (and Show all while parts are hidden),
 * with the parts list as a flyout beside it. Closing the list is what
 * leaves a single-body model with the bare viewport it deserves. Tweak
 * puts the same button on its own rail instead (TweakPanel's `parts`).
 */
export function ViewModeRail(props: PartsProps) {
  const flyout: ReactNode = props.open ? <PartsList {...props} /> : null;
  return (
    <div className="view-rail" role="toolbar" aria-label="Parts tools">
      <PartsRailButtons {...props} />
      <div className="view-flyouts">{flyout}</div>
    </div>
  );
}
