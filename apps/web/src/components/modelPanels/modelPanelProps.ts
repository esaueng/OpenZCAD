import type { ReactNode } from 'react';
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
import type { DiagnosticRow } from '../../lib/diagnosticsRows';
import type { HistoryRowActions } from '../HistoryTimeline';

/**
 * Everything the five model panels read from the open document and the
 * workspace, and every action they offer. Each panel picks what it needs.
 */
export interface ModelPanelSource {
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
}
