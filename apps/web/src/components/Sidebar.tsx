import type { DiagnosticRow } from '../lib/diagnosticsRows';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type {
  BodyId,
  BodyRepresentation,
  FeatureId,
  FeatureNode,
  ParameterKind,
  ParameterNode,
  ProjectCheckpoint,
  ProjectDocument,
  UnitSystem
} from '@openzcad/shared';
import type { PanelState, SidebarSectionId } from '../lib/panelState';
import type { HistoryRowActions } from './HistoryTimeline';
import {
  DiagnosticsPanel,
  diagnosticCount
} from './modelPanels/DiagnosticsPanel';
import {
  HistoryFindToggle,
  HistoryPanel,
  historyCount,
  historyScrub,
  useHistoryFind
} from './modelPanels/HistoryPanel';
import {
  modelBodies,
  ObjectsPanel,
  objectCount,
  useObjectsView
} from './modelPanels/ObjectsPanel';
import { ParametersPanel, parameterCount } from './modelPanels/ParametersPanel';
import {
  RevisionsPanel,
  revisionCount,
  useRevisionCheckpoints
} from './modelPanels/RevisionsPanel';

/**
 * One collapsible browser section. The count is on the header so a collapsed
 * section still says how much it is hiding — otherwise collapsing loses
 * information rather than just space.
 */
function SidebarSection({
  id,
  title,
  count,
  open,
  className,
  summary,
  actions,
  onToggle,
  children
}: {
  id: SidebarSectionId;
  title: string;
  count: number | null;
  open: boolean;
  className?: string;
  /**
   * What the header shows instead of the count while collapsed — the
   * History line, which says where in the history the model sits and not
   * just how long the history is.
   */
  summary?: ReactNode;
  /** Controls beside the header, outside its toggle button. */
  actions?: ReactNode;
  onToggle(id: SidebarSectionId): void;
  children: ReactNode;
}) {
  const showSummary = !open && summary !== undefined;
  const header = (
    <button
      type="button"
      className="section-title"
      aria-expanded={open}
      onClick={() => onToggle(id)}
      title={open ? `Collapse ${title}` : `Expand ${title}`}
    >
      <ChevronRight
        size={12}
        className="disclosure-chevron"
        aria-hidden="true"
      />
      <span>{title}</span>
      {showSummary && summary}
      {!showSummary && count !== null && count > 0 && (
        <small className="section-count">{count}</small>
      )}
    </button>
  );
  return (
    <section
      className={`sidebar-section${className ? ` ${className}` : ''}${open ? '' : ' collapsed'}`}
    >
      {actions ? (
        <div className="section-head">
          {header}
          {actions}
        </div>
      ) : (
        header
      )}
      {open && children}
    </section>
  );
}

export interface SidebarProps {
  parameters: ParameterNode[];
  parameterValues: Record<string, number>;
  features: FeatureNode[];
  representations: Record<string, BodyRepresentation>;
  failedFeatureIds?: ReadonlySet<FeatureId>;
  relatedFeatureIds?: ReadonlySet<FeatureId> | null;
  geometryPending?: boolean;
  selectedFeatureNodeId: string | null;
  selectedSketchProfileId: string | null;
  selectedBodyIds: string[];
  hiddenBodyIds: ReadonlySet<string>;
  /** Sketches currently hidden — consumed by default, or by the eye toggle. */
  hiddenSketchIds: ReadonlySet<string>;
  /**
   * The open document, for its R01 datum plane rows (source and dependents).
   * Absent, Items lists no planes.
   */
  document?: ProjectDocument;
  /** Datum planes hidden by their eye toggle: view state, as sketches' is. */
  hiddenDatumIds?: ReadonlySet<string>;
  onHiddenDatumIdsChange?(hidden: ReadonlySet<string>): void;
  /** I05 reference images hidden by their eye toggle: view state too. */
  hiddenReferenceImageIds?: ReadonlySet<string>;
  onHiddenReferenceImageIdsChange?(hidden: ReadonlySet<string>): void;
  /** The reference image whose card is open, drawn selected. */
  selectedReferenceImageId?: string | null;
  /** Opens a reference image's card. */
  onSelectReferenceImage?(imageId: string): void;
  warnings: DiagnosticRow[];
  historyDetails?: ReactNode;
  checkpoints: ProjectCheckpoint[];
  projectId?: string;
  /** The open document's version, to mark the save point it sits on. */
  documentVersion: number;
  /**
   * Checkpoints whose model can actually be opened, from this device or the
   * account. The rest are listed as history without an action.
   */
  restorableCheckpointIds: ReadonlySet<string>;
  onSelectFeature(nodeId: string): void;
  onSelectBody(bodyId: string, additive: boolean): void;
  onToggleBodyVisibility(bodyId: string): void;
  onToggleSketchVisibility(sketchId: string): void;
  /** Opens the feature menu at a point: a right-click, or a row's ⋯ button. */
  onFeatureContextMenu(
    at: { clientX: number; clientY: number },
    feature: FeatureNode,
    row?: HistoryRowActions
  ): void;
  onToggleFeatureSuppression(feature: FeatureNode): void;
  onRollbackAfterFeature(featureId: FeatureId, name: string): void;
  onResumeHistory(): void;
  /** Renames a history feature in place, from its row's menu. */
  onRenameFeature?(featureId: FeatureId, name: string): void;
  /** The document's length unit, for the value each history row shows. */
  units: UnitSystem;
  onConfigureToggle?: (name: string, bodyIds: BodyId[]) => void;
  onPreviewParameter?(name: string, expression: string | null): void;
  onSetParameter(
    name: string,
    expression: string
  ): void | Promise<string | null>;
  /** F05: retypes a parameter; answers with a refusal. */
  onSetParameterQuantity?(
    name: string,
    quantity: ParameterKind | null,
    /** The row's unsaved or still-committing expression draft. */
    expression?: string
  ): void | Promise<string | null>;
  /** F05: each unitless parameter's suggested quantity, by name. */
  parameterQuantitySuggestions?: Readonly<Record<string, ParameterKind>>;
  onViewActivityLog(): void;
  parameterMinimums?: Record<string, number>;
  onDeleteParameter(name: string): void;
  onRenameParameter(name: string, newName: string): string | null;
  onExposeParameter(name: string, exposed: boolean): void;
  onDescribeParameter(name: string, description: string): void;
  /** Names currently offered in Tweak, from `listExposedParameters`. */
  exposedParameterNames: ReadonlySet<string>;
  onReorderFeature(featureId: FeatureId, toIndex: number): void;
  onRestoreCheckpoint(checkpoint: ProjectCheckpoint): void;
  onBranchCheckpoint(checkpoint: ProjectCheckpoint): void;
  panelState: PanelState;
  onToggleSection(id: SidebarSectionId): void;
  /** Closes the drawer; a double-click on its empty space calls it. */
  onClose?(): void;
}

/**
 * Double-clicks that belong to something inside the drawer — a row, a field,
 * a header — rather than to the drawer itself. Rows are listed as well as
 * controls so a fast double-select on a feature never closes the drawer.
 */
const DOUBLE_CLICK_OWNERS =
  'button, a, input, textarea, select, label, summary, [contenteditable], [role="listitem"], [role="button"], [role="slider"], .feature-row, .body-row, .revision-row, .diagnostic-row, .param-row, .history-rollback, .feature-history-panel';

export function Sidebar(props: SidebarProps) {
  const { features, panelState, onToggleSection, onClose } = props;
  const objectsView = useObjectsView();
  const historyFind = useHistoryFind();
  const revisions = useRevisionCheckpoints(props);
  const liveBodies = modelBodies(props).filter((body) => !body.consumed);
  const summary = historyScrub(props);
  return (
    <aside
      className="sidebar"
      aria-label="Model browser"
      onDoubleClick={(event) => {
        if (
          onClose &&
          event.target instanceof Element &&
          !event.target.closest(DOUBLE_CLICK_OWNERS)
        ) {
          onClose();
        }
      }}
    >
      <SidebarSection
        id="parameters"
        title="Parameters"
        count={parameterCount(props.parameters)}
        open={panelState.sidebarSections.parameters}
        onToggle={onToggleSection}
      >
        <ParametersPanel {...props} bodies={liveBodies} />
      </SidebarSection>

      <SidebarSection
        id="bodies"
        title="Objects"
        count={objectCount(props)}
        open={panelState.sidebarSections.bodies}
        onToggle={onToggleSection}
      >
        <ObjectsPanel {...props} view={objectsView} />
      </SidebarSection>

      <SidebarSection
        id="history"
        title="History"
        count={historyCount(features)}
        open={panelState.sidebarSections.history}
        className="grow"
        {...(summary !== undefined ? { summary } : {})}
        actions={
          panelState.sidebarSections.history && features.length > 0 ? (
            <HistoryFindToggle find={historyFind} />
          ) : undefined
        }
        onToggle={onToggleSection}
      >
        <HistoryPanel {...props} find={historyFind} />
      </SidebarSection>

      {revisionCount(revisions) > 0 && (
        <SidebarSection
          id="revisions"
          title="Revisions"
          count={revisionCount(revisions)}
          open={panelState.sidebarSections.revisions}
          className="revisions"
          onToggle={onToggleSection}
        >
          <RevisionsPanel {...props} revisions={revisions} />
        </SidebarSection>
      )}

      {diagnosticCount(props.warnings) > 0 && (
        <SidebarSection
          id="diagnostics"
          title="Diagnostics"
          count={diagnosticCount(props.warnings)}
          open={panelState.sidebarSections.diagnostics}
          className="diagnostics"
          onToggle={onToggleSection}
        >
          <DiagnosticsPanel {...props} />
        </SidebarSection>
      )}
    </aside>
  );
}
