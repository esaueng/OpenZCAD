import {
  Suspense,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode
} from 'react';
import {
  Cog,
  Download,
  Link2,
  MoveVertical,
  Pause,
  Pin,
  Play,
  Plus,
  TriangleAlert
} from 'lucide-react';
import { commandFactories } from '@openzcad/command-system';
import { assemblyBomToCsv, deriveAssemblyBom } from '@openzcad/document-core';
import {
  ASSEMBLY_JOINT_DOFS,
  createId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
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
import { downloadText, exportFileStem } from '../../lib/model';
import { ContextMenu, type ContextMenuState } from '../ContextMenu';
import { lazyWithStaleChunkNotice } from '../../lib/staleChunk';
import {
  AssemblyFirstRunCard,
  assemblyCandidateBodies
} from './AssemblyFirstRunCard';
import { ComponentDetails, JointDetails } from './AssemblyDetails';
import { AssemblyNameField } from './AssemblyNameField';
import {
  AddStudyButton,
  AssemblyStudiesSection
} from './AssemblyStudiesSection';
import { JointKindIcon } from './JointKindIcon';
import { JointToolCard } from './JointToolCard';
import {
  assemblyGearCount,
  openGearMesh,
  selectedGearMesh
} from './gearMeshEntry';
import { MotionSetupCard, openMotionSetup } from './MotionSetupCard';
import type { MotionSetupBounds } from '../../lib/assembly/motionSetup';
import { useAssemblyModel } from './useAssemblyModel';

// Mesh gears and its pair math load when the card first opens; the entry
// chunk runs at its budget and keeps only the gear check.
const GearMeshCard = lazyWithStaleChunkNotice(() =>
  import('./GearMeshCard').then((module) => ({ default: module.GearMeshCard }))
);

export interface AssemblyPanelProps {
  document: ProjectDocument;
  execute: AssemblyExecute;
  onStatus(message: string): void;
  /** A notice after parts are first made (the toast). */
  onAnnounce?(message: string): void;
  /** Replaces the Motion section (tests). */
  studies?: ReactNode;
  /** Body boxes in modelled coordinates, for Set up motion's axis and range. */
  bodyBounds?: MotionSetupBounds;
  /** Set up motion opens with its preview paused. */
  reducedMotion?: boolean;
  /** Saves the BOM CSV; a browser download unless replaced (tests). */
  saveBomCsv?(fileName: string, csv: string): void;
}

type MenuTarget =
  { kind: 'component'; id: string } | { kind: 'joint'; id: string };

/**
 * Assemble's one sidebar (AS01/AS02/AS06/AS07), on the left like every
 * other workspace's panels: the parts, the joints and the motion studies,
 * each opening its controls right under its row. Bodies not yet in the
 * assembly are listed with Add; the joint tool takes the sidebar while it
 * is open, and an empty assembly starts from its first-run choice.
 */
export function AssemblyPanel(props: AssemblyPanelProps) {
  const { document, execute, onStatus, onAnnounce } = props;
  const tool = useAssemblyRuntime((s) => s.jointTool !== null);
  const setup = useAssemblyRuntime((s) => s.motionSetup !== null);
  const gearMesh = useAssemblyRuntime((s) => s.gearMesh !== null);
  const hasParts = (document.assembly?.components.length ?? 0) > 0;
  return (
    <aside className="assembly-panel" aria-label="Assembly">
      {tool ? (
        <JointToolCard document={document} />
      ) : setup ? (
        <MotionSetupCard
          document={document}
          execute={execute}
          onStatus={onStatus}
          {...(props.bodyBounds ? { bounds: props.bodyBounds } : {})}
        />
      ) : gearMesh ? (
        <Suspense fallback={null}>
          <GearMeshCard
            document={document}
            execute={execute}
            onStatus={onStatus}
          />
        </Suspense>
      ) : hasParts ? (
        <AssemblyLists {...props} />
      ) : (
        <AssemblyFirstRunCard
          document={document}
          execute={execute}
          onAnnounce={onAnnounce ?? onStatus}
        />
      )}
    </aside>
  );
}

function Section({
  title,
  count,
  action,
  children
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="assembly-section" aria-label={title}>
      <div className="assembly-section-head">
        <h3 className="assembly-section-title">
          {title}
          {count !== undefined ? (
            <span className="assembly-count">{count}</span>
          ) : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function AssemblyLists({
  document,
  execute,
  onStatus,
  studies,
  bodyBounds,
  reducedMotion,
  saveBomCsv
}: AssemblyPanelProps) {
  const model = useAssemblyModel(document);
  const selectedComponentId = useAssemblyRuntime((s) => s.selectedComponentId);
  const selectedComponentIds = useAssemblyRuntime(
    (s) => s.selectedComponentIds
  );
  const selectedJointId = useAssemblyRuntime((s) => s.selectedJointId);
  const playback = useAssemblyRuntime((s) => s.playback);
  const [menu, setMenu] = useState<
    (ContextMenuState & { target: MenuTarget }) | null
  >(null);
  const [renaming, setRenaming] = useState<MenuTarget | null>(null);
  const candidates = useMemo(
    () => assemblyCandidateBodies(document),
    [document]
  );
  const gearCount = useMemo(() => assemblyGearCount(document), [document]);
  const selectedPair = useMemo(
    () => selectedGearMesh(document, selectedComponentIds),
    [document, selectedComponentIds]
  );
  if (!model) return null;
  const { set, solution, bodyByComponent } = model;
  const app = { document, execute, onStatus };
  const chip = assemblyStatusChip(set, solution);
  const firstComponent = set.components[0];
  const playingJointId = playback?.kind === 'joint' ? playback.jointId : null;
  const used = new Set<BodyId>([
    ...set.components.map((c) => c.bodyId),
    ...[...bodyByComponent.values()].filter((id): id is BodyId => id !== null)
  ]);
  const addable = candidates.filter((body) => !used.has(body.bodyId));
  const bom = deriveAssemblyBom(document);
  const missingQuantity = bom.rows.reduce(
    (count, row) => count + (row.status === 'missing' ? row.quantity : 0),
    0
  );

  const downloadBom = () => {
    const fileName = `${exportFileStem(document.name)}.bom.csv`;
    const csv = `${assemblyBomToCsv(bom)}\n`;
    if (saveBomCsv) saveBomCsv(fileName, csv);
    else downloadText(fileName, csv, 'text/csv');
    onStatus(
      `Exported the bill of materials (${bom.rows.length} part${
        bom.rows.length === 1 ? '' : 's'
      }) to ${fileName}.${missingQuantity > 0 ? ` Includes ${missingQuantity} missing part${missingQuantity === 1 ? '' : 's'}.` : ''}`
    );
  };

  const addParts = (bodies: { bodyId: BodyId; name: string }[]) => {
    if (bodies.length === 0) return;
    const ok = execute(
      commandFactories.addAssemblyComponents({
        components: bodies.map((body) => ({
          componentId: createId<'AssemblyComponent'>('comp'),
          name: body.name,
          bodyId: body.bodyId,
          grounded: false
        }))
      })
    );
    if (ok)
      onStatus(
        bodies.length === 1
          ? `Added ${bodies[0]?.name ?? 'the part'}. Press J to join it.`
          : `Added ${bodies.length} parts. Press J to join them.`
      );
  };

  const startMotionSetup = () => {
    if (
      openMotionSetup(document, {
        ...(bodyBounds ? { bounds: bodyBounds } : {}),
        reducedMotion: reducedMotion ?? false
      })
    )
      onStatus('Set up motion · choose what moves and how.');
  };

  const startGearMesh = () => {
    if (openGearMesh(document, selectedComponentIds))
      onStatus('Place gears · choose the gear that stays put and its mate.');
  };

  const openJointTool = () => {
    assemblyRuntime.openJointTool();
    onStatus('Joint · click the part that moves.');
  };

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
                label: component?.grounded ? 'Unfix' : 'Fix in place',
                shortcut: 'G'
              },
              { id: 'rename', label: 'Rename' },
              {
                id: 'remove',
                label: 'Remove from assembly',
                danger: true,
                section: true
              }
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
          selectedComponentIds.includes(target.id)
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
  const detailProps = { document, execute, onStatus, model };

  return (
    <>
      <header className="assembly-panel-header">
        <h2 className="assembly-panel-title">Assembly</h2>
        <span
          className={`assembly-chip is-${chip.tone}`}
          role="status"
          aria-label={`Assembly status: ${chip.label}`}
        >
          {chip.label}
        </span>
        {/* With no joints yet, the Joints section offers Set up motion. */}
        {set.joints.length > 0 ? (
          <button
            type="button"
            className="assembly-tool-button"
            title="Make another part slide or turn"
            onClick={startMotionSetup}
          >
            <MoveVertical size={13} aria-hidden="true" />
            Motion
          </button>
        ) : null}
        <button
          type="button"
          className="assembly-tool-button"
          title="Join two parts (J)"
          disabled={set.components.length < 2}
          onClick={openJointTool}
        >
          <Link2 size={13} aria-hidden="true" />
          Joint
        </button>
      </header>
      {solution.grounded === 0 && firstComponent ? (
        <div className="assembly-banner" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>Nothing is fixed, so everything floats.</span>
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
            Fix {firstComponent.name}
          </button>
        </div>
      ) : null}
      <div className="assembly-panel-body">
        <Section title="Parts" count={set.components.length}>
          <ul className="assembly-list">
            {set.components.map((component) => {
              const missing = bodyByComponent.get(component.id) === null;
              const selected = selectedComponentIds.includes(component.id);
              const expanded = component.id === selectedComponentId;
              const role = solution.roles.get(component.id) ?? 'free';
              const link = solution.links.get(component.id);
              const via = link
                ? set.joints.find((j) => j.id === link.jointId)?.name
                : undefined;
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
                  <div className="assembly-row-line">
                    {isRenaming('component', component.id) ? (
                      <AssemblyNameField
                        value={component.name}
                        label={`Rename ${component.name}`}
                        autoFocus
                        onCommit={(name) =>
                          execute(
                            commandFactories.updateAssemblyComponent(
                              { componentId: component.id, name },
                              'Rename part'
                            )
                          )
                        }
                        onDone={() => setRenaming(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="assembly-row-main"
                        aria-expanded={expanded}
                        aria-pressed={selected}
                        title="Ctrl or Command-click to select more than one part"
                        aria-controls={`assembly-details-${component.id}`}
                        onClick={(event) => {
                          // A double-click renames: its second click must
                          // not close the row the first one opened.
                          if (event.detail > 1) return;
                          assemblyRuntime.selectComponent(
                            event.ctrlKey || event.metaKey
                              ? component.id
                              : expanded
                                ? null
                                : component.id,
                            event.ctrlKey || event.metaKey
                          );
                        }}
                        onDoubleClick={() =>
                          setRenaming({ kind: 'component', id: component.id })
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
                        ) : role === 'driven' && via ? (
                          <span className="assembly-row-value">{via}</span>
                        ) : role === 'free' ? (
                          <span className="assembly-row-value">Not joined</span>
                        ) : null}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`assembly-row-action assembly-row-pin${
                        component.grounded ? ' is-on' : ''
                      }`}
                      aria-pressed={component.grounded}
                      aria-label={
                        component.grounded
                          ? `${component.name} is fixed`
                          : `Fix ${component.name} in place`
                      }
                      title={
                        component.grounded ? 'Fixed (G)' : 'Fix in place (G)'
                      }
                      onClick={() => toggleComponentGrounded(app, component.id)}
                    >
                      <Pin size={12} aria-hidden="true" />
                    </button>
                  </div>
                  {expanded ? (
                    <ComponentDetails {...detailProps} component={component} />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {selectedPair ? (
            <div className="assembly-actions">
              <button
                type="button"
                className="secondary"
                onClick={startGearMesh}
              >
                <Cog size={13} aria-hidden="true" />
                Place selected gears
              </button>
            </div>
          ) : null}
          {addable.length > 0 ? (
            <div
              className="assembly-addable"
              role="group"
              aria-label="Not in the assembly"
            >
              <div className="assembly-addable-head">
                <span>Not in the assembly</span>
                {addable.length > 1 ? (
                  <button
                    type="button"
                    className="assembly-link-button"
                    onClick={() => addParts(addable)}
                  >
                    Add all
                  </button>
                ) : null}
              </div>
              <ul className="assembly-list">
                {addable.map((body) => (
                  <li key={body.bodyId} className="assembly-row is-addable">
                    <div className="assembly-row-line">
                      <span className="assembly-row-main is-static">
                        <span className="assembly-row-name">{body.name}</span>
                      </span>
                      <button
                        type="button"
                        className="assembly-add-button"
                        aria-label={`Add ${body.name}`}
                        onClick={() => addParts([body])}
                      >
                        <Plus size={12} aria-hidden="true" />
                        Add
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>

        <Section
          title="Joints"
          count={set.joints.length}
          action={
            set.components.length >= 2 ? (
              <button
                type="button"
                className="assembly-link-button"
                onClick={openJointTool}
              >
                <Plus size={12} aria-hidden="true" />
                Add
              </button>
            ) : null
          }
        >
          {gearCount >= 2 ? (
            <div className="assembly-actions">
              <button
                type="button"
                className="secondary"
                onClick={startGearMesh}
              >
                <Cog size={13} aria-hidden="true" />
                Place gears
              </button>
            </div>
          ) : null}
          {set.joints.length === 0 ? (
            set.components.length < 2 ? (
              <p className="assembly-muted">Add a second part to join it.</p>
            ) : (
              <div className="assembly-setup-cta">
                <p className="assembly-muted">
                  Make one part slide or turn against a fixed one, with its
                  range and cycle, and play it.
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={startMotionSetup}
                >
                  <MoveVertical size={13} aria-hidden="true" />
                  Set up motion
                </button>
                <p className="assembly-muted">
                  Or press J to join on picked holes, faces or edges.
                </p>
              </div>
            )
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
                    <div className="assembly-row-line">
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
                          aria-expanded={selected}
                          aria-controls={`assembly-details-${joint.id}`}
                          title={JOINT_KIND_META[joint.kind].label}
                          onClick={(event) => {
                            if (event.detail > 1) return;
                            assemblyRuntime.selectJoint(
                              selected ? null : joint.id
                            );
                          }}
                          onDoubleClick={() =>
                            setRenaming({ kind: 'joint', id: joint.id })
                          }
                        >
                          <JointKindIcon kind={joint.kind} />
                          <span className="assembly-row-name">
                            {joint.name}
                          </span>
                          {unsolved ? (
                            <span
                              className="assembly-row-flag"
                              title={unsolvedReasonText(unsolved)}
                            >
                              <TriangleAlert size={12} aria-hidden="true" />
                              Can’t move
                            </span>
                          ) : (
                            <span className="assembly-row-value">
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
                    </div>
                    {selected ? (
                      <JointDetails {...detailProps} joint={joint} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {studies ??
          ((set.studies.length > 0 ||
            set.joints.some(
              (joint) => ASSEMBLY_JOINT_DOFS[joint.kind].length > 0
            )) && (
            <Section
              title="Motion"
              count={set.studies.length}
              action={
                <AddStudyButton
                  assembly={document.assembly}
                  execute={execute}
                />
              }
            >
              <AssemblyStudiesSection
                assembly={document.assembly}
                execute={execute}
              />
            </Section>
          ))}

        <Section
          title="Bill of materials"
          count={bom.rows.length}
          action={
            bom.rows.length > 0 ? (
              <button
                type="button"
                className="assembly-link-button"
                aria-label="Download bill of materials as CSV"
                title="Download as CSV"
                onClick={downloadBom}
              >
                <Download size={12} aria-hidden="true" />
                CSV
              </button>
            ) : null
          }
        >
          {bom.rows.length === 0 ? (
            <p className="assembly-muted">No parts to list.</p>
          ) : (
            <ul className="assembly-list" aria-label="Bill of materials">
              {bom.rows.map((row) => (
                <li
                  key={`${row.status}:${row.bodyId}`}
                  className="assembly-row"
                >
                  <div
                    className="assembly-row-line"
                    title={row.instances.map((i) => i.name).join(', ')}
                  >
                    <span className="assembly-row-main is-static">
                      <span className="assembly-row-name">{row.name}</span>
                      {row.status === 'missing' && (
                        <span
                          className="assembly-row-flag"
                          title="The part's body cannot be found"
                        >
                          <TriangleAlert size={12} aria-hidden="true" />
                          Missing
                        </span>
                      )}
                      <span
                        className="assembly-row-value"
                        aria-label={`Quantity ${row.quantity}`}
                      >
                        &times;{row.quantity}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      {menu ? (
        <ContextMenu
          menu={menu}
          onSelect={runMenu}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}
