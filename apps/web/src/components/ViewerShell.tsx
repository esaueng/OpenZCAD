import type { MutableRefObject } from 'react';
import { Box, Cylinder, Globe, Sparkles } from 'lucide-react';
import {
  ModelViewer,
  type ExtrudePreview,
  type AxisProjection,
  type FaceResizeCommit,
  type EdgeHandleTarget,
  type MovePreview,
  type RegionHandleTarget,
  type SketchModeState,
  type SketchViewData,
  type MoveSnap,
  type OffsetHandleTarget,
  type PickDetail,
  type ProjectionMode,
  type SketchOverlay,
  type StandardView,
  type ViewerSettings
} from './ModelViewer';
import type { ReactNode } from 'react';
import { ViewerToolbar } from './ViewerToolbar';
import { OrientationWidget } from './OrientationWidget';
import type {
  BodyRepresentation,
  SketchObjectData,
  TopologySelection
} from '@openzcad/shared';
import type { ViewportCameraState } from '../lib/workspaceSession';
import type { RegionPickData } from './viewer/regionOverlay';

interface ViewerShellProps {
  projectId: string;
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  selectedEdges: TopologySelection[];
  settings: ViewerSettings;
  fitSignal: number;
  viewRequest: { view: StandardView; nonce: number } | null;
  units: string;
  editableBodyIds: string[];
  extrudePreview: ExtrudePreview | null;
  movePreview: MovePreview | null;
  modeOverlay?: ReactNode;
  hideViewerToolbar?: boolean;
  /** Bottom-center summary of the current selection, with a measurement. */
  selectionChip: { label: string; detail?: string } | null;
  onClearSelection(): void;
  /** Starts a primitive from the empty-state card. */
  onStartPrimitive(tool: 'box' | 'cylinder' | 'sphere'): void;
  /** Focuses the assistant prompt; null when the assistant is turned off. */
  onAskAssistant: (() => void) | null;
  projection: ProjectionMode;
  initialView: ViewportCameraState | null;
  onViewChange(view: ViewportCameraState): void;
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean,
    detail?: PickDetail
  ): void;
  offsetHandle: OffsetHandleTarget | null;
  onOffsetCommit(offset: number): void;
  onOpenOffsetKeypad(currentOffset: number): void;
  keypadAnchorRef: MutableRefObject<
    ((point: { x: number; y: number } | null) => void) | null
  >;
  offsetSetterRef: MutableRefObject<((offset: number) => void) | null>;
  edgeHandle: EdgeHandleTarget | null;
  onEdgeRadiusPreview(size: number): void;
  onEdgeCommit(size: number): void;
  onOpenEdgeKeypad(currentSize: number): void;
  onDirectManipulationChange(dragging: boolean): void;
  sketchMode: SketchModeState | null;
  onSketchCommit(object: SketchObjectData): void;
  onSketchDrawingChange(drawing: boolean): void;
  onSketchSelectObject(objectId: string | null): void;
  sketchViews: SketchViewData[];
  onSelectRegion(region: RegionPickData): void;
  regionHandle: RegionHandleTarget | null;
  onSelectSketchProfile(sketchId: string): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
  onExtrudeDistanceChange(distance: number): void;
  onMovePreviewChange(
    translation: MovePreview['translation'],
    rotationDeg: MovePreview['rotationDeg'],
    snap: MoveSnap
  ): void;
  onContextMenu(
    x: number,
    y: number,
    selection: TopologySelection | null
  ): void;
  onToggleGrid(): void;
  onFit(): void;
  onView(view: StandardView): void;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
}

export function ViewerShell({
  projectId,
  bodies,
  sketches,
  selectedBodyIds,
  selectedTopology,
  selectedEdges,
  settings,
  fitSignal,
  viewRequest,
  units,
  editableBodyIds,
  extrudePreview,
  movePreview,
  modeOverlay,
  hideViewerToolbar = false,
  selectionChip,
  onStartPrimitive,
  onAskAssistant,
  onClearSelection,
  projection,
  initialView,
  onViewChange,
  orientationRef,
  onSelectTopology,
  offsetHandle,
  onOffsetCommit,
  onOpenOffsetKeypad,
  keypadAnchorRef,
  offsetSetterRef,
  edgeHandle,
  onEdgeRadiusPreview,
  onEdgeCommit,
  onOpenEdgeKeypad,
  onDirectManipulationChange,
  sketchMode,
  onSketchCommit,
  onSketchDrawingChange,
  onSketchSelectObject,
  sketchViews,
  onSelectRegion,
  regionHandle,
  onSelectSketchProfile,
  onResizePrimitiveFace,
  onExtrudeDistanceChange,
  onMovePreviewChange,
  onContextMenu,
  onToggleGrid,
  onFit,
  onView,
  onCycleDisplayMode,
  onToggleProjection
}: ViewerShellProps) {
  return (
    <section className="viewer-shell" aria-label="3D viewport">
      <ModelViewer
        key={projectId}
        bodies={bodies}
        sketches={sketches}
        selectedBodyIds={selectedBodyIds}
        selectedTopology={selectedTopology}
        selectedEdges={selectedEdges}
        settings={settings}
        fitSignal={fitSignal}
        viewRequest={viewRequest}
        units={units}
        editableBodyIds={editableBodyIds}
        extrudePreview={extrudePreview}
        movePreview={movePreview}
        projection={projection}
        initialView={initialView}
        onViewChange={onViewChange}
        orientationRef={orientationRef}
        onSelectTopology={onSelectTopology}
        offsetHandle={offsetHandle}
        onOffsetCommit={onOffsetCommit}
        onOpenOffsetKeypad={onOpenOffsetKeypad}
        keypadAnchorRef={keypadAnchorRef}
        offsetSetterRef={offsetSetterRef}
        edgeHandle={edgeHandle}
        onEdgeRadiusPreview={onEdgeRadiusPreview}
        onEdgeCommit={onEdgeCommit}
        onOpenEdgeKeypad={onOpenEdgeKeypad}
        onDirectManipulationChange={onDirectManipulationChange}
        sketchMode={sketchMode}
        onSketchCommit={onSketchCommit}
        onSketchDrawingChange={onSketchDrawingChange}
        onSketchSelectObject={onSketchSelectObject}
        sketchViews={sketchViews}
        onSelectRegion={onSelectRegion}
        regionHandle={regionHandle}
        onSelectSketchProfile={onSelectSketchProfile}
        onResizePrimitiveFace={onResizePrimitiveFace}
        onExtrudeDistanceChange={onExtrudeDistanceChange}
        onMovePreviewChange={onMovePreviewChange}
        onContextMenu={onContextMenu}
      />
      {!hideViewerToolbar && (
        <div className="viewer-rail-stack">
          <OrientationWidget orientationRef={orientationRef} />
          <ViewerToolbar
            settings={settings}
            projection={projection}
            onToggleGrid={onToggleGrid}
            onFit={onFit}
            onView={onView}
            onCycleDisplayMode={onCycleDisplayMode}
            onToggleProjection={onToggleProjection}
          />
        </div>
      )}
      {bodies.length === 0 && sketches.length === 0 && (
        <div className="viewer-notice">
          <div>
            <strong>No geometry yet</strong>
            {/*
              Restating the palette hint wastes the one moment the user is
              definitely looking here, so the card starts the work instead.
            */}
            <small>Start with a solid, or describe the part you want.</small>
            <div className="viewer-notice-actions">
              <button type="button" onClick={() => onStartPrimitive('box')}>
                <Box size={14} aria-hidden="true" />
                Box <kbd>B</kbd>
              </button>
              <button type="button" onClick={() => onStartPrimitive('cylinder')}>
                <Cylinder size={14} aria-hidden="true" />
                Cylinder <kbd>C</kbd>
              </button>
              <button type="button" onClick={() => onStartPrimitive('sphere')}>
                <Globe size={14} aria-hidden="true" />
                Sphere
              </button>
              {onAskAssistant && (
                <button
                  type="button"
                  className="viewer-notice-assistant"
                  onClick={onAskAssistant}
                >
                  <Sparkles size={14} aria-hidden="true" />
                  Describe a part
                </button>
              )}
            </div>
            <small className="viewer-notice-keys">
              <kbd>S</kbd> sketch · <kbd>Ctrl</kbd>+<kbd>K</kbd> all commands ·{' '}
              <kbd>?</kbd> shortcuts
            </small>
          </div>
        </div>
      )}
      {selectionChip && (
        <div className="selection-chip" role="status">
          <span className="selection-chip-label">{selectionChip.label}</span>
          {selectionChip.detail && (
            <span className="selection-chip-detail">
              {selectionChip.detail}
            </span>
          )}
          <button
            type="button"
            className="selection-chip-clear"
            title="Deselect all (Esc)"
            aria-label="Deselect all"
            onClick={onClearSelection}
          >
            ×
          </button>
        </div>
      )}
      {modeOverlay}
      <div className="viewport-frame" aria-hidden="true">
        <div className="frame-corner tl" />
        <div className="frame-corner tr" />
        <div className="frame-corner bl" />
        <div className="frame-corner br" />
      </div>
      <div className="vp-hud vp-hud-bl" aria-hidden="true">
        <span className="vp-chip">{units}</span>
        <span className="vp-chip">
          {bodies.length} {bodies.length === 1 ? 'body' : 'bodies'}
        </span>
        {sketches.length > 0 && (
          <span className="vp-chip">
            {sketches.length} {sketches.length === 1 ? 'sketch' : 'sketches'}
          </span>
        )}
      </div>
    </section>
  );
}
