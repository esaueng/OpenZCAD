import { useState, type KeyboardEvent } from 'react';
import { RefreshCcw, X } from 'lucide-react';
import type { KeymapOverrides } from '@openzcad/shared';
import {
  bindingRefusal,
  chordFromEvent,
  KEYMAP_COMMANDS,
  KEYMAP_GROUPS,
  referenceKeyLabel,
  resolveKeymap,
  withBindings,
  withoutOverride,
  type KeymapCommand
} from '../lib/keymap';

interface KeymapEditorProps {
  overrides: KeymapOverrides;
  onChange(overrides: KeymapOverrides): void;
}

/**
 * Settings' remapping table: every command in the keymap registry, with its
 * live keys, a way to add or remove one, and a reset per command and for all
 * of them. A key that is already taken is refused with the command that holds
 * it named, rather than silently moved: taking a key from another command is
 * a decision the user makes by removing it there.
 */
export function KeymapEditor({ overrides, onChange }: KeymapEditorProps) {
  const keymap = resolveKeymap(overrides);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const customized = Object.keys(overrides).length;

  const capture = (command: KeymapCommand, event: KeyboardEvent) => {
    if (event.key === 'Tab') {
      // Focus moves on; the capture ends with it (onBlur).
      return;
    }
    // Settings closes on Escape and the workspace never sees these keys
    // while it is open; here they belong to the capture alone.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setCapturing(null);
      return;
    }
    const chord = chordFromEvent(event.nativeEvent);
    if (!chord) {
      // A modifier on its own: wait for the key it modifies.
      return;
    }
    const refused = bindingRefusal(keymap, command.id, chord);
    if (refused) {
      setRefusal({ id: command.id, message: refused });
      return;
    }
    setCapturing(null);
    setRefusal(null);
    onChange(
      withBindings(overrides, command.id, [
        ...keymap.bindings(command.id),
        chord
      ])
    );
  };

  return (
    <div className="keymap-editor">
      <div className="keymap-editor-bar">
        <p role="status">
          {customized === 0
            ? 'Every shortcut is at its default.'
            : `${customized} ${customized === 1 ? 'command has' : 'commands have'} a custom shortcut.`}
        </p>
        <button
          type="button"
          className="secondary"
          disabled={customized === 0}
          onClick={() => {
            setCapturing(null);
            setRefusal(null);
            onChange({});
          }}
        >
          <RefreshCcw size={14} aria-hidden="true" />
          Reset all shortcuts
        </button>
      </div>
      <div className="settings-control-groups">
        {KEYMAP_GROUPS.map((group) => {
          const commands = KEYMAP_COMMANDS.filter(
            (command) => command.group === group.id
          );
          return (
            <section className="settings-control-group" key={group.id}>
              <header>
                <h4>{group.title}</h4>
                <span>{commands.length} commands</span>
              </header>
              <dl>
                {commands.map((command) => {
                  const bindings = keymap.bindings(command.id);
                  const active = capturing === command.id;
                  const refused =
                    refusal?.id === command.id ? refusal.message : null;
                  return (
                    <div
                      className="settings-control-row"
                      key={command.id}
                      data-keymap-command={command.id}
                    >
                      <dt>
                        <span className="settings-control-keys">
                          {bindings.length === 0 ? (
                            <span className="keymap-unbound">Unassigned</span>
                          ) : (
                            bindings.map((chord) => (
                              <span className="keymap-chip" key={chord}>
                                <kbd>{referenceKeyLabel(chord)}</kbd>
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={`Remove ${referenceKeyLabel(chord)} from ${command.label}`}
                                  onClick={() => {
                                    setRefusal(null);
                                    onChange(
                                      withBindings(
                                        overrides,
                                        command.id,
                                        bindings.filter(
                                          (bound) => bound !== chord
                                        )
                                      )
                                    );
                                  }}
                                >
                                  <X size={12} aria-hidden="true" />
                                </button>
                              </span>
                            ))
                          )}
                        </span>
                      </dt>
                      <dd>
                        <strong>{command.label}</strong>
                        {refused ? (
                          <small className="keymap-refusal" role="alert">
                            {refused}
                          </small>
                        ) : active ? (
                          <small>Press the new shortcut · Esc cancels</small>
                        ) : null}
                        <span className="keymap-actions">
                          <button
                            type="button"
                            className={`secondary${active ? ' is-capturing' : ''}`}
                            aria-pressed={active}
                            aria-label={`Add a shortcut for ${command.label}`}
                            onClick={() => {
                              setRefusal(null);
                              setCapturing(active ? null : command.id);
                            }}
                            onKeyDown={
                              active
                                ? (event) => capture(command, event)
                                : undefined
                            }
                            onBlur={() => {
                              if (active) setCapturing(null);
                            }}
                          >
                            {active ? 'Press keys…' : 'Add key'}
                          </button>
                          {command.id in overrides && (
                            <button
                              type="button"
                              className="secondary"
                              aria-label={`Reset ${command.label}`}
                              onClick={() => {
                                setRefusal(null);
                                onChange(
                                  withoutOverride(overrides, command.id)
                                );
                              }}
                            >
                              Reset
                            </button>
                          )}
                        </span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          );
        })}
      </div>
    </div>
  );
}
