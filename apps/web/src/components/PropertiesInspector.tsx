import type { ReactNode } from 'react';
import { PanelRightClose, PanelRightOpen, Trash2 } from 'lucide-react';
import type {
  BodyRepresentation,
  BooleanOperation,
  FeatureNode,
  ParamValue,
  RevolveAxis,
  SketchId,
  SketchNode,
  SketchObjectData
} from '@openzcad/shared';
import type { WorkspaceId } from '../lib/commands';
import {
  BooleanForm,
  ExtrudeForm,
  PrimitiveForm,
  RevolveForm,
  SketchForm,
  TransformForm,
  type BodyOption,
  type SketchFormValue,
  type SketchOption,
  type TransformFormValue
} from './forms/FeatureForms';
import { FEATURE_KIND_LABELS, formatNumber } from '../lib/model';

/** Curated appearance palette; values persist via node metadata. */
const APPEARANCE_COLORS = [
  '#e1a948',
  '#4bb7a7',
  '#5fb3e8',
  '#ff7452',
  '#8b80f9',
  '#d5dbe3',
  '#7d8a99',
  '#c96f9c'
];

export interface InspectorCallbacks {
  onApplyPrimitive(
    feature: FeatureNode,
    name: string,
    dimensions: Record<string, ParamValue>
  ): void;
  onApplySketch(feature: FeatureNode, value: SketchFormValue): void;
  onApplyExtrude(
    feature: FeatureNode,
    value: { name: string; sketchId: SketchId; distance: ParamValue }
  ): void;
  onApplyRevolve(
    feature: FeatureNode,
    value: { name: string; sketchId: SketchId; axis: RevolveAxis }
  ): void;
  onApplyBoolean(
    feature: FeatureNode,
    value: { name: string; operation: BooleanOperation; targetBodyIds: BodyOption['bodyId'][] }
  ): void;
  onApplyTransform(feature: FeatureNode, value: TransformFormValue): void;
  onDeleteFeature(feature: FeatureNode): void;
  onSetBodyColor(feature: FeatureNode, color: string | null): void;
}

interface PropertiesInspectorProps extends InspectorCallbacks {
  workspace: WorkspaceId;
  collapsed: boolean;
  onToggleCollapsed(): void;
  selectedFeature: FeatureNode | null;
  selectedSketch: SketchNode | null;
  selectedSketchObject: SketchObjectData | null;
  selectedBody: BodyRepresentation | null;
  /** Persisted appearance override for the selected body, if any. */
  bodyColorOverride: string | null;
  scope: Record<string, number>;
  sketches: SketchOption[];
  bodies: BodyOption[];
  units: string;
  onClearSelection(): void;
}

function BodyStats({ body, units }: { body: BodyRepresentation; units: string }) {
  const size = {
    x: body.bbox.max.x - body.bbox.min.x,
    y: body.bbox.max.y - body.bbox.min.y,
    z: body.bbox.max.z - body.bbox.min.z
  };
  return (
    <>
      <h3 className="section-title">Measurements</h3>
      <div className="kv-grid">
        <b>volume</b>
        <span>
          {formatNumber(body.volume)} {units}³
        </span>
        <b>size</b>
        <span>
          {formatNumber(size.x)} × {formatNumber(size.y)} × {formatNumber(size.z)} {units}
        </span>
        <b>faces</b>
        <span>{body.faceCount}</span>
        <b>status</b>
        <span>{body.consumed ? 'consumed by boolean' : 'live'}</span>
      </div>
    </>
  );
}

/**
 * Collapsible right panel for exact parameters of the selected feature.
 * Common commands run through the on-canvas HUD; this panel is progressive
 * disclosure for full editing, measurements, and appearance. It stays out of
 * the way (collapsed rail) when nothing is selected.
 */
export function PropertiesInspector(props: PropertiesInspectorProps) {
  const {
    workspace,
    collapsed,
    onToggleCollapsed,
    selectedFeature,
    selectedSketch,
    selectedSketchObject,
    selectedBody,
    bodyColorOverride,
    scope,
    sketches,
    bodies,
    units,
    onClearSelection
  } = props;

  if (collapsed || !selectedFeature) {
    return (
      <div className="inspector-rail">
        <button
          type="button"
          className="icon-button"
          title={
            selectedFeature
              ? 'Open properties (selected feature)'
              : 'Properties open automatically when you select a feature'
          }
          aria-label="Open properties panel"
          disabled={!selectedFeature}
          onClick={onToggleCollapsed}
        >
          <PanelRightOpen size={15} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const data = selectedFeature.data;
  const editKey = `edit-${selectedFeature.id}`;
  let form: ReactNode = null;

  if (data.featureKind === 'primitive') {
    form = (
      <PrimitiveForm
        key={editKey}
        kind={data.primitiveKind}
        scope={scope}
        initialName={selectedFeature.name}
        initialDimensions={data.dimensions}
        submitLabel="Apply"
        onSubmit={(name, dimensions) => props.onApplyPrimitive(selectedFeature, name, dimensions)}
        onCancel={onClearSelection}
      />
    );
  } else if (data.featureKind === 'sketch' && selectedSketch && selectedSketchObject) {
    form = (
      <SketchForm
        key={editKey}
        scope={scope}
        initial={{
          name: selectedFeature.name,
          plane: selectedSketch.plane,
          offset: selectedSketch.offset,
          object: selectedSketchObject
        }}
        submitLabel="Apply"
        onSubmit={(value) => props.onApplySketch(selectedFeature, value)}
        onCancel={onClearSelection}
      />
    );
  } else if (data.featureKind === 'extrude') {
    form = (
      <ExtrudeForm
        key={editKey}
        scope={scope}
        sketches={sketches}
        initial={{
          name: selectedFeature.name,
          sketchId: data.sketchId,
          distance: data.distance
        }}
        submitLabel="Apply"
        onSubmit={(value) => props.onApplyExtrude(selectedFeature, value)}
        onCancel={onClearSelection}
      />
    );
  } else if (data.featureKind === 'revolve') {
    form = (
      <RevolveForm
        key={editKey}
        scope={scope}
        sketches={sketches}
        initial={{ name: selectedFeature.name, sketchId: data.sketchId, axis: data.axis }}
        submitLabel="Apply"
        onSubmit={(value) => props.onApplyRevolve(selectedFeature, value)}
        onCancel={onClearSelection}
      />
    );
  } else if (data.featureKind === 'boolean') {
    form = (
      <BooleanForm
        key={editKey}
        bodies={bodies}
        initial={{
          name: selectedFeature.name,
          operation: data.operation,
          targetBodyIds: data.targetBodyIds
        }}
        submitLabel="Apply"
        onSubmit={(value) => props.onApplyBoolean(selectedFeature, value)}
        onCancel={onClearSelection}
      />
    );
  } else if (data.featureKind === 'transform') {
    form = (
      <TransformForm
        key={editKey}
        scope={scope}
        bodies={bodies}
        initial={{
          name: selectedFeature.name,
          targetBodyId: data.targetBodyId,
          translation: data.transform.translation,
          rotationDeg: data.transform.rotationDeg
        }}
        submitLabel="Apply"
        onSubmit={(value) => props.onApplyTransform(selectedFeature, value)}
        onCancel={onClearSelection}
      />
    );
  } else if (data.featureKind === 'imported-mesh') {
    form = (
      <div className="kv-grid">
        <b>source</b>
        <span>{data.sourceName}</span>
        <b>triangles</b>
        <span>{data.triangleCount}</span>
      </div>
    );
  }

  return (
    <section className="inspector" aria-label="Properties inspector">
      <div className="panel-header">
        <div className="panel-title-row">
          <h2>{selectedFeature.name}</h2>
          <span className="panel-eyebrow">{FEATURE_KIND_LABELS[selectedFeature.featureKind]}</span>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Collapse properties"
          aria-label="Collapse properties panel"
          onClick={onToggleCollapsed}
        >
          <PanelRightClose size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="panel-body">
        {form}
        {selectedBody && <BodyStats body={selectedBody} units={units} />}
        {workspace === 'visualize' && selectedBody && !selectedBody.consumed && (
          <>
            <h3 className="section-title">Appearance</h3>
            <div className="swatch-row" role="radiogroup" aria-label="Body color">
              {APPEARANCE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={bodyColorOverride === color}
                  className={`swatch ${bodyColorOverride === color ? 'active' : ''}`}
                  style={{ background: color }}
                  title={color}
                  onClick={() => props.onSetBodyColor(selectedFeature, color)}
                />
              ))}
              <button
                type="button"
                className="swatch reset"
                title="Reset to the default feature color"
                onClick={() => props.onSetBodyColor(selectedFeature, null)}
              >
                ×
              </button>
            </div>
          </>
        )}
        <div className="form-actions danger-zone">
          <button
            type="button"
            className="secondary danger"
            onClick={() => props.onDeleteFeature(selectedFeature)}
          >
            <Trash2 size={13} aria-hidden="true" />
            Delete feature
          </button>
        </div>
      </div>
    </section>
  );
}
