import type { ReactNode } from 'react';
import {
  Box,
  Combine,
  Cone,
  Cylinder,
  Globe,
  Layers,
  Move3d,
  PenLine,
  RotateCw,
  Scissors,
  Shapes,
  Torus,
  Trash2
} from 'lucide-react';
import type {
  BodyRepresentation,
  BooleanOperation,
  FeatureNode,
  ParamValue,
  PrimitiveKind,
  RevolveAxis,
  SketchId,
  SketchNode,
  SketchObjectData
} from '@openzcad/shared';
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

export type ToolId =
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'cone'
  | 'torus'
  | 'sketch'
  | 'extrude'
  | 'revolve'
  | 'union'
  | 'subtract'
  | 'intersect'
  | 'transform';

const PRIMITIVE_TOOLS: ToolId[] = [
  'box',
  'cylinder',
  'sphere',
  'cone',
  'torus'
];

const TOOL_META: Record<ToolId, { label: string; icon: ReactNode }> = {
  box: { label: 'Box', icon: <Box size={15} aria-hidden="true" /> },
  cylinder: {
    label: 'Cylinder',
    icon: <Cylinder size={15} aria-hidden="true" />
  },
  sphere: { label: 'Sphere', icon: <Globe size={15} aria-hidden="true" /> },
  cone: { label: 'Cone', icon: <Cone size={15} aria-hidden="true" /> },
  torus: { label: 'Torus', icon: <Torus size={15} aria-hidden="true" /> },
  sketch: { label: 'Sketch', icon: <PenLine size={15} aria-hidden="true" /> },
  extrude: { label: 'Extrude', icon: <Layers size={15} aria-hidden="true" /> },
  revolve: {
    label: 'Revolve',
    icon: <RotateCw size={15} aria-hidden="true" />
  },
  union: { label: 'Union', icon: <Combine size={15} aria-hidden="true" /> },
  subtract: {
    label: 'Subtract',
    icon: <Scissors size={15} aria-hidden="true" />
  },
  intersect: {
    label: 'Intersect',
    icon: <Shapes size={15} aria-hidden="true" />
  },
  transform: { label: 'Move', icon: <Move3d size={15} aria-hidden="true" /> }
};

export interface InspectorCallbacks {
  onLaunchTool(tool: ToolId): void;
  onCancel(): void;
  onCreatePrimitive(
    kind: PrimitiveKind,
    name: string,
    dimensions: Record<string, ParamValue>
  ): void;
  onCreateSketch(value: SketchFormValue): void;
  onCreateExtrude(value: {
    name: string;
    sketchId: SketchId;
    distance: ParamValue;
  }): void;
  onCreateRevolve(value: {
    name: string;
    sketchId: SketchId;
    axis: RevolveAxis;
  }): void;
  onCreateBoolean(value: {
    name: string;
    operation: BooleanOperation;
    targetBodyIds: BodyOption['bodyId'][];
  }): void;
  onCreateTransform(value: TransformFormValue): void;
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
    value: {
      name: string;
      operation: BooleanOperation;
      targetBodyIds: BodyOption['bodyId'][];
    }
  ): void;
  onApplyTransform(feature: FeatureNode, value: TransformFormValue): void;
  onDeleteFeature(feature: FeatureNode): void;
}

interface InspectorProps extends InspectorCallbacks {
  tool: ToolId | null;
  selectedFeature: FeatureNode | null;
  /** Sketch node backing the selected sketch feature, when applicable. */
  selectedSketch: SketchNode | null;
  selectedSketchObject: SketchObjectData | null;
  selectedBody: BodyRepresentation | null;
  scope: Record<string, number>;
  sketches: SketchOption[];
  bodies: BodyOption[];
  units: string;
}

function ToolLauncher({
  bodies,
  sketches,
  onLaunchTool
}: {
  bodies: BodyOption[];
  sketches: SketchOption[];
  onLaunchTool(tool: ToolId): void;
}) {
  const liveBodies = bodies.filter((body) => !body.consumed).length;
  const disabled = (tool: ToolId): boolean => {
    if (tool === 'extrude' || tool === 'revolve') {
      return sketches.length === 0;
    }
    if (tool === 'union' || tool === 'subtract' || tool === 'intersect') {
      return liveBodies < 2;
    }
    if (tool === 'transform') {
      return liveBodies < 1;
    }
    return false;
  };

  const group = (title: string, tools: ToolId[]) => (
    <>
      <h3 className="section-title">{title}</h3>
      <div className="tool-grid">
        {tools.map((tool) => (
          <button
            key={tool}
            type="button"
            className="tool-button"
            disabled={disabled(tool)}
            onClick={() => onLaunchTool(tool)}
          >
            {TOOL_META[tool].icon}
            {TOOL_META[tool].label}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <>
      {group('Primitives', PRIMITIVE_TOOLS)}
      {group('Sketch based', ['sketch', 'extrude', 'revolve'])}
      {group('Combine & place', [
        'union',
        'subtract',
        'intersect',
        'transform'
      ])}
      <p className="muted">
        Every numeric field accepts an expression over your parameters, e.g.{' '}
        <span className="mono">w / 2 + 5</span>. Select a feature in the tree or
        the viewport to edit it.
      </p>
    </>
  );
}

function BodyStats({
  body,
  units
}: {
  body: BodyRepresentation;
  units: string;
}) {
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
          {formatNumber(size.x)} × {formatNumber(size.y)} ×{' '}
          {formatNumber(size.z)} {units}
        </span>
        <b>faces</b>
        <span>{body.faceCount}</span>
        <b>status</b>
        <span>{body.consumed ? 'consumed by boolean' : 'live'}</span>
      </div>
    </>
  );
}

export function Inspector(props: InspectorProps) {
  const {
    tool,
    selectedFeature,
    selectedSketch,
    selectedSketchObject,
    selectedBody,
    scope,
    sketches,
    bodies,
    units
  } = props;

  let eyebrow = 'Add feature';
  let title = 'Tools';
  let body: ReactNode;

  if (tool) {
    eyebrow = 'New feature';
    title = TOOL_META[tool].label;
    if (PRIMITIVE_TOOLS.includes(tool)) {
      const kind = tool as PrimitiveKind;
      body = (
        <PrimitiveForm
          key={`create-${tool}`}
          kind={kind}
          scope={scope}
          initialName={TOOL_META[tool].label}
          submitLabel="Create"
          onSubmit={(name, dimensions) =>
            props.onCreatePrimitive(kind, name, dimensions)
          }
          onCancel={props.onCancel}
        />
      );
    } else if (tool === 'sketch') {
      body = (
        <SketchForm
          key="create-sketch"
          scope={scope}
          submitLabel="Create"
          onSubmit={props.onCreateSketch}
          onCancel={props.onCancel}
        />
      );
    } else if (tool === 'extrude') {
      body = (
        <ExtrudeForm
          key="create-extrude"
          scope={scope}
          sketches={sketches}
          submitLabel="Create"
          onSubmit={props.onCreateExtrude}
          onCancel={props.onCancel}
        />
      );
    } else if (tool === 'revolve') {
      body = (
        <RevolveForm
          key="create-revolve"
          scope={scope}
          sketches={sketches}
          submitLabel="Create"
          onSubmit={props.onCreateRevolve}
          onCancel={props.onCancel}
        />
      );
    } else if (
      tool === 'union' ||
      tool === 'subtract' ||
      tool === 'intersect'
    ) {
      body = (
        <BooleanForm
          key={`create-${tool}`}
          bodies={bodies}
          presetOperation={tool}
          submitLabel="Create"
          onSubmit={props.onCreateBoolean}
          onCancel={props.onCancel}
        />
      );
    } else {
      body = (
        <TransformForm
          key="create-transform"
          scope={scope}
          bodies={bodies}
          submitLabel="Create"
          onSubmit={props.onCreateTransform}
          onCancel={props.onCancel}
        />
      );
    }
  } else if (selectedFeature) {
    eyebrow = FEATURE_KIND_LABELS[selectedFeature.featureKind];
    title = selectedFeature.name;
    const editKey = `edit-${selectedFeature.id}`;
    const data = selectedFeature.data;
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
          onSubmit={(name, dimensions) =>
            props.onApplyPrimitive(selectedFeature, name, dimensions)
          }
          onCancel={props.onCancel}
        />
      );
    } else if (
      data.featureKind === 'sketch' &&
      selectedSketch &&
      selectedSketchObject
    ) {
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
          onCancel={props.onCancel}
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
          onCancel={props.onCancel}
        />
      );
    } else if (data.featureKind === 'revolve') {
      form = (
        <RevolveForm
          key={editKey}
          scope={scope}
          sketches={sketches}
          initial={{
            name: selectedFeature.name,
            sketchId: data.sketchId,
            axis: data.axis
          }}
          submitLabel="Apply"
          onSubmit={(value) => props.onApplyRevolve(selectedFeature, value)}
          onCancel={props.onCancel}
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
          onCancel={props.onCancel}
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
          onCancel={props.onCancel}
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

    body = (
      <>
        {form}
        {selectedBody && <BodyStats body={selectedBody} units={units} />}
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
      </>
    );
  } else {
    body = (
      <ToolLauncher
        bodies={bodies}
        sketches={sketches}
        onLaunchTool={props.onLaunchTool}
      />
    );
  }

  return (
    <section className="inspector" aria-label="Feature inspector">
      <div className="panel-header">
        <div className="panel-title-row">
          <h2>{title}</h2>
          <span className="panel-eyebrow">{eyebrow}</span>
        </div>
      </div>
      <div className="panel-body">{body}</div>
    </section>
  );
}
