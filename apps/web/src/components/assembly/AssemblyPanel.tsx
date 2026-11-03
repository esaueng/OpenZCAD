import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  Bookmark,
  Link2,
  Pause,
  Pin,
  Play,
  TriangleAlert,
  X
} from 'lucide-react';
import { commandFactories } from '@openzcad/command-system';
import type { ProjectDocument } from '@openzcad/shared';
import {
  toggleComponentGrounded,
  toggleJointPlayback,
  type AssemblyExecute
} from '../../lib/assembly/assembleWorkspace';
import {
  assemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import {
  assemblyStatusChip,
  jointValueSummary,
  JOINT_KIND_META,
  sweepUnavailableReason,
  unsolvedReasonText
} from '../../lib/assembly/assemblyUi';
import { ContextMenu, type ContextMenuState } from '../ContextMenu';
import { AssemblyNameField } from './AssemblyNameField';
import { AssemblyStudiesSection } from './AssemblyStudiesSection';
import { JointKindIcon } from './JointKindIcon';
import { useAssemblyModel } from './useAssemblyModel';

export interface AssemblyPanelProps {
  document: ProjectDocument;
  execute: AssemblyExecute;
  onStatus(message: string): void;
  /** The Motion studies section; the stub until the timeline lands. */
  studies?: ReactNode;
}

type MenuTarget =
  { kind: 'component'; id: string } | { kind: 'joint'; id: string };

/**
 * Assemble's left panel (AS01/AS02/AS06): the assembly's health, its
 * components, joints, named positions and motion studies. Selecting a row
 * selects it on the model and opens it in the Inspector.
 */
export function AssemblyPanel({
  document,
  execute,
  onStatus,
  studies
}: AssemblyPanelProps) {
  const model = useAssemblyModel(document);
  const selectedComponentId = useAssemblyRuntime((s) => s.selectedComponentId);
  const selectedJointId = useAssemblyRuntime((s) => s.selectedJointId);
  const playback = useAssemblyRuntime((s) => s.playback);
  const [menu, setMenu] = useState<
    (ContextMenuState & { target: MenuTarget }) | null
  >(null);
  const [renaming, setRenaming] = useState<MenuTarget | null>(null);
  if (!model) return null;
  const { set, solution, bodyByComponent } = model;
  const app = { document, execute, onStatus };
  const chip = assemblyStatusChip(set, solution);
  const firstComponent = set.components[0];
  const playingJointId = playback?.kind === 'joint' ? playback.jointId : null;

  const openMenu = (event: MouseEvent, target: MenuTarget, heading: string) => {
    event.preventDefault();
    const component =
      target.kind === 'component'
        ? set.components.find((c) => c.id === target.id)
        : undefined;
    setMenu({
      x: event.clientX,
      y: event.clientY,
      heading,
      target,
      items:
        target.kind === 'component'
          ? [
              {
                id: 'ground',
                label: component?.grounded ? 'Unground' : 'Ground',
                shortcut: 'G'
              },
              { id: 'rename', label: 'Rename' },
              { id: 'remove', label: 'Remove', danger: true, section: true }
            ]
          : [
              { id: 'rename', label: 'Rename' },
              { id: 'delete', label: 'Delete', danger: true, section: true }
            ]
    });
  };

  const runMenu = (itemId: string) => {
    const target = menu?.target;
    setMenu(null);
    if (!target) return;
    if (itemId === 'rename') {
      setRenaming(target);
      return;
    }
    if (target.kind === 'component') {
      if (itemId === 'ground') toggleComponentGrounded(app, target.id);
      if (itemId === 'remove') {
        if (
          execute(
            commandFactories.deleteAssemblyComponent({ componentId: target.id })
          ) &&
          selectedComponentId === target.id
        )
          assemblyRuntime.selectComponent(null);
      }
      return;
    }
    if (itemId === 'delete') {
      if (playingJointId === target.id) assemblyRuntime.stop();
      if (
        execute(commandFactories.deleteAssemblyJoint({ jointId: target.id })) &&
        selectedJointId === target.id
      )
        assemblyRuntime.selectJoint(null);
    }
  };

  const isRenaming = (kind: MenuTarget['kind'], id: string) =>
    renaming?.kind === kind && renaming.id === id;

  return (
    <aside className="assembly-panel" aria-label="Assembly">
      <header className="assembly-panel-header">
        <h2 className="assembly-panel-title">Assembly</h2>
        <span
          className={`assembly-chip is-${chip.tone}`}
          role="status"
          aria-label={`Assembly status: ${chip.label}`}
        >
          {chip.label}
        </span>
        <button
          type="button"
          className="assembly-tool-button"
          title="Add a joint (J)"
          disabled={set.components.length < 2}
          onClick={() => {
            assemblyRuntime.openJointTool();
            onStatus('Joint · pick the part that moves.');
          }}
        >
          <Link2 size={13} aria-hidden="true" />
          Joint
        </button>
      </header>
      {solution.grounded === 0 && firstComponent ? (
        <div className="assembly-banner" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>Nothing is grounded, so every part floats.</span>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              execute(
                commandFactories.updateAssemblyComponent({
                  componentId: firstComponent.id,
                  grounded: true
                })
              )
            }
          >
            Ground {firstComponent.name}
          </button>
        </div>
      ) : null}
      <div className="assembly-panel-body">
        <section className="assembly-section" aria-label="Components">
          <h3 className="assembly-section-title">
            Components
            <span className="assembly-count">{set.components.length}</span>
          </h3>
          <ul className="assembly-list">
            {set.components.map((component) => {
              const missing = bodyByComponent.get(component.id) === null;
              const selected = component.id === selectedComponentId;
              return (
                <li
                  key={component.id}
                  className={`assembly-row${selected ? ' is-selected' : ''}`}
                  onContextMenu={(event) =>
                    openMenu(
                      event,
                      { kind: 'component', id: component.id },
                      component.name
                    )
                  }
                >
                  {isRenaming('component', component.id) ? (
                    <AssemblyNameField
                      value={component.name}
                      label={`Rename ${component.name}`}
                      autoFocus
                      onCommit={(name) =>
                        execute(
                          commandFactories.updateAssemblyComponent(
                            { componentId: component.id, name },
                            'Rename component'
                          )
                        )
                      }
                      onDone={() => setRenaming(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="assembly-row-main"
                      aria-pressed={selected}
                      onClick={() =>
                        assemblyRuntime.selectComponent(
                          selected ? null : component.id
                        )
                      }
                    >
                      <span className="assembly-row-name">
                        {component.name}
                      </span>
                      {missing ? (
                        <span
                          className="assembly-row-flag"
                          title="Its body was deleted"
                        >
                          <TriangleAlert size={12} aria-hidden="true" />
                          Body deleted
                        </span>
                      ) : null}
                      {component.grounded ? (
                        <Pin
                          className="assembly-row-pin"
                          size={12}
                          aria-label="Grounded"
                        />
                      ) : null}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="assembly-section" aria-label="Joints">
          <h3 className="assembly-section-title">
            Joints
            <span className="assembly-count">{set.joints.length}</span>
          </h3>
          {set.joints.length === 0 ? (
            <p className="assembly-muted">
              {set.components.length < 2
                ? 'Add a second component to join it.'
                : 'Press J to join two components.'}
            </p>
          ) : (
            <ul className="assembly-list">
              {set.joints.map((joint) => {
                const unsolved = solution.unsolved.get(joint.id) ?? null;
                const selected = joint.id === selectedJointId;
                const playing = joint.id === playingJointId;
                const reason = sweepUnavailableReason(joint);
                const values = solution.values.get(joint.id) ?? joint.values;
                return (
                  <li
                    key={joint.id}
                    className={`assembly-row${selected ? ' is-selected' : ''}${
                      unsolved ? ' is-unsolved' : ''
                    }`}
                    onContextMenu={(event) =>
                      openMenu(
                        event,
                        { kind: 'joint', id: joint.id },
                        joint.name
                      )
                    }
                  >
                    {isRenaming('joint', joint.id) ? (
                      <AssemblyNameField
                        value={joint.name}
                        label={`Rename ${joint.name}`}
                        autoFocus
                        onCommit={(name) =>
                          execute(
                            commandFactories.updateAssemblyJoint(
                              { jointId: joint.id, name },
                              'Rename joint'
                            )
                          )
                        }
                        onDone={() => setRenaming(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="assembly-row-main"
                        aria-pressed={selected}
                        onClick={() =>
                          assemblyRuntime.selectJoint(
                            selected ? null : joint.id
                          )
                        }
                      >
                        <JointKindIcon kind={joint.kind} />
                        <span className="assembly-row-name">{joint.name}</span>
                        {unsolved ? (
                          <span
                            className="assembly-row-flag"
                            title={unsolvedReasonText(unsolved)}
                          >
                            <TriangleAlert size={12} aria-hidden="true" />
                            {unsolved === 'loop'
                              ? 'Not solved · loop'
                              : 'Not solved · both grounded'}
                          </span>
                        ) : (
                          <span
                            className="assembly-row-value"
                            title={JOINT_KIND_META[joint.kind].label}
                          >
                            {jointValueSummary(joint.kind, values)}
                          </span>
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="assembly-row-action"
                      aria-label={`${playing ? 'Pause' : 'Play'} ${joint.name}`}
                      title={reason ?? (playing ? 'Pause' : 'Play')}
                      disabled={
                        !playing && (reason !== null || unsolved !== null)
                      }
                      onClick={() => toggleJointPlayback(app, joint.id)}
                    >
                      {playing ? (
                        <Pause size={12} aria-hidden="true" />
                      ) : (
                        <Play size={12} aria-hidden="true" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="assembly-section" aria-label="Named positions">
          <h3 className="assembly-section-title">
            Named positions
            <span className="assembly-count">{set.positions.length}</span>
          </h3>
          {set.positions.length === 0 ? (
            <p className="assembly-muted">
              Save where the joints are from a joint&apos;s Inspector.
            </p>
          ) : (
            <ul className="assembly-list">
              {set.positions.map((position) => (
                <li key={position.id} className="assembly-row">
                  <button
                    type="button"
                    className="assembly-row-main"
                    title={`Move the joints to ${position.name}`}
                    onClick={() => {
                      assemblyRuntime.stop();
                      execute(
                        commandFactories.setAssemblyPose(
                          { values: position.values },
                          `Apply position ${position.name}`
                        )
                      );
                    }}
                  >
                    <Bookmark
                      className="assembly-row-icon"
                      size={12}
                      aria-hidden="true"
                    />
                    <span className="assembly-row-name">{position.name}</span>
                  </button>
                  <button
                    type="button"
                    className="assembly-row-action"
                    aria-label={`Delete ${position.name}`}
                    title="Delete"
                    onClick={() =>
                      execute(
                        commandFactories.deleteAssemblyPosition({
                          positionId: position.id
                        })
                      )
                    }
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {studies ?? (
          <section className="assembly-section" aria-label="Motion studies">
            <h3 className="assembly-section-title">
              Motion studies
              <span className="assembly-count">{set.studies.length}</span>
            </h3>
            <AssemblyStudiesSection
              assembly={document.assembly}
              execute={execute}
            />
          </section>
        )}
      </div>
      {menu ? (
        <ContextMenu
          menu={menu}
          onSelect={runMenu}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </aside>
  );
}
