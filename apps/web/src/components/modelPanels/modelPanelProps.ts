import type { LocalHistoryAppend } from '../../lib/localHistoryAppend';
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
import type { ObjectFolderActions } from './ObjectsPanel';
import type { BodyAppearancePreview } from '../ModelViewer';
import type { BodyAppearancePatch } from './BodyAppearanceEditor';

/**
 * Everything the five model panels read from the open document and the
 * workspace, and every action they offer. Each panel picks what it needs.
 */
/** A refused, uncommitted operation, as History's transient last row. */
export interface PendingHistoryStep {
  title: string;
  message: string;
}

export interface ModelPanelSource {
  parameters: ParameterNode[];
  parameterValues: Record<string, number>;
  features: FeatureNode[];
  localAppend?: LocalHistoryAppend | null;
  representations: Record<string, BodyRepresentation>;
  failedFeatureIds?: ReadonlySet<FeatureId>;
  relatedFeatureIds?: ReadonlySet<FeatureId> | null;
  geometryPending?: boolean;
  /**
   * Whether to say so: `geometryPending` held long enough to be worth
   * announcing. Stale-state guards read `geometryPending` itself, so a brief
   * gap neither flashes "preparing" nor shows a failure that is not one.
   * Defaults to `geometryPending`.
   */
  geometryPendingShown?: boolean;
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
  /**
   * The operation on the model that the kernel just refused, shown as a
   * transient last row in History so a failed step is not silently missing
   * from the list. Never a feature: it goes when the operation re-arms or
   * ends.
   */
  pendingHistoryStep?: PendingHistoryStep | null;
  /** The existing feature a running command edits (`editedFeatureIdFor`). */
  editingHistoryFeatureId?: string | null;
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
  /** Isolate a live result body, or restore its prior visibility. */
  onIsolateBody?(bodyId: string): void;
  isolatedBodyId?: string | null;
  /** Renames a body in place from Objects (ZC-127): one undoable step. */
  onRenameBody?(bodyId: BodyId, name: string): void;
  bodyAppearancePreview?: BodyAppearancePreview | null;
  onPreviewBodyAppearance?(preview: BodyAppearancePreview | null): void;
  /** Absent when model edits are unavailable; swatches still show the colors. */
  onCommitBodyAppearance?(bodyId: BodyId, patch: BodyAppearancePatch): void;
  /** Objects folders (ZC-128); absent, folders list but cannot be edited. */
  objectFolderActions?: ObjectFolderActions;
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
  /**
   * Deletes a History multi-selection as one undoable step. Without it the
   * rows select one at a time, as before.
   */
  onDeleteFeatures?(featureIds: readonly FeatureId[]): void;
  /** The document's length unit, for the value each history row shows. */
  units: UnitSystem;
  onConfigureToggle?: (name: string, bodyIds: BodyId[]) => void;
  onPreviewParameter?(name: string, expression: string | null): void;
  onSetParameter(
    name: string,
    expression: string
  ): void | Promise<string | null>;
  /** A new parameter the add row refused before setting it (a taken name). */
  onParameterAddRefused?(name: string, message: string): void;
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
  /** Saves the held refused rebuild as a reproduction; absent when none is. */
  refusalReproductionFor?:
    ((name: string, message: string) => (() => void) | undefined) | undefined;
  parameterMinimums?: Record<string, number>;
  onDeleteParameter(name: string): void;
  onRenameParameter(name: string, newName: string): string | null;
  onExposeParameter(name: string, exposed: boolean): void;
  onDescribeParameter(name: string, description: string): void;
  /** Names currently offered in Tweak, from `listExposedParameters`. */
  exposedParameterNames: ReadonlySet<string>;
  onReorderFeature(featureId: FeatureId, toIndex: number): void;
  /** An exact operation is running; History holds its reorder grips. */
  reorderBusy?: boolean;
  onRestoreCheckpoint(checkpoint: ProjectCheckpoint): void;
  onBranchCheckpoint(checkpoint: ProjectCheckpoint): void;
}
