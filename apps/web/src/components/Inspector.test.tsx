import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  FeatureNode,
  TopologySelection
} from '@openzcad/shared';
import { Inspector } from './Inspector';

const bodyId = 'body-1' as BodyId;

const feature: FeatureNode = {
  id: 'feature-node-1' as FeatureNode['id'],
  parentId: null,
  revisionId: null,
  kind: 'feature',
  featureId: 'feature-1' as FeatureNode['featureId'],
  featureKind: 'fillet',
  bodyId,
  name: 'Lower rim fillet',
  data: {
    featureKind: 'fillet',
    targetBodyId: bodyId,
    edgeHashes: [11],
    radius: 2
  }
};

const body: BodyRepresentation = {
  bodyId,
  name: 'Mounting bracket',
  source: 'fillet',
  mesh: {
    kind: 'mesh',
    vertices: new Float32Array(),
    indices: new Uint32Array()
  },
  faceCount: 6,
  color: '#ffffff',
  exportableStep: true,
  consumed: false,
  volume: 120,
  bbox: {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 10, y: 12, z: 6 }
  },
  massProperties: {
    centerOfMass: { x: 5, y: 6, z: 3 },
    inertia: [1, 2, 3, 0, 0, 0],
    principalMoments: [1, 2, 3],
    principalAxes: [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 }
    ]
  },
  topology: {
    faces: [
      {
        topologyId: 'face:front',
        hash: 21,
        triangleStart: 0,
        triangleCount: 2,
        geometry: {
          surfaceType: 'plane',
          area: 60,
          center: { x: 5, y: 0, z: 3 },
          normal: { x: 0, y: -1, z: 0 }
        }
      }
    ],
    edges: []
  }
};

const frontFace: TopologySelection = {
  bodyId,
  kind: 'face',
  topologyId: 'face:front',
  hash: 21
};

function makeProps(
  overrides: Partial<ComponentProps<typeof Inspector>> = {}
): ComponentProps<typeof Inspector> {
  return {
    tool: null,
    selectedFeature: feature,
    selectedSketch: null,
    selectedSketchObject: null,
    selectedBody: body,
    selectedTopology: frontFace,
    selectedEdges: [],
    edgeModifierBody: null,
    scope: {},
    sketches: [],
    bodies: [{ bodyId, name: body.name, consumed: false }],
    units: 'mm',
    selectedBodyIds: [bodyId],
    preferredSketchId: null,
    commandSession: {
      id: 'fillet',
      title: 'Fillet',
      target: { kind: 'face', count: 1 },
      phase: 'armed',
      error: null
    },
    featureSelectionSource: 'inferred',
    onLaunchTool: vi.fn(),
    onSelectBodies: vi.fn(),
    onCancel: vi.fn(),
    onCreatePrimitive: vi.fn(),
    onCreateRevolve: vi.fn(),
    onCreateBoolean: vi.fn(),
    onCreateTransform: vi.fn(),
    onCreateEdgeModifier: vi.fn(),
    onSelectAllEdges: vi.fn(),
    onClearSelectedEdges: vi.fn(),
    onCreatePattern: vi.fn(),
    onApplyPrimitive: vi.fn(),
    onApplySketch: vi.fn(),
    onConvertSketchToFixedPlane: vi.fn(),
    onApplyTextSketch: vi.fn(),
    onEditSketchInViewport: vi.fn(),
    onApplyExtrude: vi.fn(),
    onPreviewExtrude: vi.fn(),
    extrudeTargets: [],
    onApplyRevolve: vi.fn(),
    onApplyBoolean: vi.fn(),
    onApplyTransform: vi.fn(),
    onApplyEdgeModifier: vi.fn(),
    onPreviewEdgeModifier: vi.fn(),
    onApplyPattern: vi.fn(),
    onResizeThroughHole: vi.fn(),
    onRemoveFaceFeature: vi.fn(),
    onPinFeature: vi.fn(),
    onDeleteFeature: vi.fn(),
    onToggleImportedSolid: vi.fn(),
    onPreviewBodyAppearance: vi.fn(),
    onCommitBodyAppearance: vi.fn(),
    ...overrides
  };
}

describe('Inspector feature provenance', () => {
  it('keeps unresolved geometry inspectable without offering feature edits or deletion', () => {
    render(
      <Inspector
        {...makeProps({ selectedFeature: null, commandSession: null })}
      />
    );
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(
      within(inspector).getByRole('heading', { level: 2 })
    ).toHaveTextContent('Front face');
    expect(inspector).toHaveTextContent(
      'does not identify one editable history feature'
    );
    expect(inspector).toHaveTextContent('120 mm³');
    expect(
      within(inspector).queryByLabelText('Radius')
    ).not.toBeInTheDocument();
    expect(
      within(inspector).queryByLabelText('More actions')
    ).not.toBeInTheDocument();
  });

  it('rejects stale Apply and Delete actions', () => {
    const props = makeProps({
      commandSession: null,
      onValidateSelection: () => false
    });
    render(<Inspector {...props} />);
    fireEvent.change(screen.getByLabelText('Radius'), {
      target: { value: '3' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(props.onApplyEdgeModifier).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: /Delete feature/ }));
    expect(props.onDeleteFeature).not.toHaveBeenCalled();
  });

  it('resets a form to committed values after undo, redo or a document update', () => {
    const props = makeProps({ commandSession: null, documentVersion: 1 });
    const { rerender } = render(<Inspector {...props} />);
    fireEvent.change(screen.getByLabelText('Radius'), {
      target: { value: '9' }
    });
    rerender(<Inspector {...props} documentVersion={2} />);
    expect(screen.getByLabelText('Radius')).toHaveValue('2');
  });

  it('renders a demoted inferred feature as a read-only object panel', () => {
    const onPinFeature = vi.fn();
    render(<Inspector {...makeProps({ onPinFeature })} />);

    const inspector = screen.getByRole('region', {
      name: 'Feature inspector'
    });
    expect(inspector).toHaveClass('object-readout');
    expect(
      within(inspector).getByRole('heading', { level: 2 })
    ).toHaveTextContent('Front face');
    expect(within(inspector).getByText('Mounting bracket')).toBeVisible();
    expect(within(inspector).getByText('Measurements')).toBeVisible();
    expect(within(inspector).getByText('120 mm³')).toBeVisible();
    expect(
      within(inspector).getByText('Mass properties (at unit density)')
    ).toBeVisible();
    expect(within(inspector).getByText('Lower rim fillet')).toBeVisible();
    expect(
      within(inspector).queryByLabelText('Radius')
    ).not.toBeInTheDocument();
    expect(
      within(inspector).queryByLabelText('More actions')
    ).not.toBeInTheDocument();
    expect(within(inspector).queryByText(/Delete/)).not.toBeInTheDocument();

    fireEvent.click(within(inspector).getByRole('button', { name: 'Edit' }));
    expect(onPinFeature).toHaveBeenCalledWith(feature);
  });

  it('renders a pinned feature as an editable form with Delete', () => {
    render(
      <Inspector
        {...makeProps({
          featureSelectionSource: 'pinned'
        })}
      />
    );

    const inspector = screen.getByRole('region', {
      name: 'Feature inspector'
    });
    expect(inspector).not.toHaveClass('object-readout');
    expect(within(inspector).getByLabelText('Radius')).toHaveValue('2');
    fireEvent.click(within(inspector).getByLabelText('More actions'));
    expect(
      within(inspector).getByRole('button', { name: /Delete feature/ })
    ).toBeVisible();
  });
});

describe('fillet radius slider', () => {
  it('previews the latest size without applying until submitted', () => {
    const props = makeProps({
      selectedFeature: feature,
      featureSelectionSource: 'pinned'
    });
    render(<Inspector {...props} />);
    const slider = screen.getByRole('slider', { name: 'Fillet radius slider' });
    fireEvent.change(slider, { target: { value: '3' } });
    fireEvent.change(slider, { target: { value: '4' } });
    expect(screen.getByRole('textbox', { name: 'Radius' })).toHaveValue('4');
    expect(props.onPreviewEdgeModifier).toHaveBeenLastCalledWith(
      feature,
      'fillet',
      expect.objectContaining({ size: 4, edgeHashes: [11] })
    );
    expect(props.onApplyEdgeModifier).not.toHaveBeenCalled();
    fireEvent.submit(
      screen.getByRole('button', { name: /Apply/ }).closest('form')!
    );
    expect(props.onApplyEdgeModifier).toHaveBeenCalledExactlyOnceWith(
      feature,
      'fillet',
      expect.objectContaining({ size: 4 })
    );
  });

  it('keeps expressions until the user moves the slider and cancels without saving', () => {
    const props = makeProps({
      selectedFeature: feature,
      featureSelectionSource: 'pinned',
      scope: { r: 2 }
    });
    render(<Inspector {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Radius' }), {
      target: { value: 'r * 2' }
    });
    expect(
      screen.getByRole('slider', { name: 'Fillet radius slider' })
    ).toHaveValue('4');
    expect(props.onPreviewEdgeModifier).toHaveBeenLastCalledWith(
      feature,
      'fillet',
      expect.objectContaining({ size: 'r * 2' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onApplyEdgeModifier).not.toHaveBeenCalled();
  });

  it('clears a preview and disables Apply for a nonpositive radius', () => {
    const props = makeProps({
      selectedFeature: feature,
      featureSelectionSource: 'pinned'
    });
    render(<Inspector {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Radius' }), {
      target: { value: '0' }
    });
    expect(props.onPreviewEdgeModifier).toHaveBeenLastCalledWith(
      feature,
      'fillet',
      null
    );
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
  });
});

describe('imported face recognition display', () => {
  const importedBody: BodyRepresentation = {
    ...body,
    source: 'imported-step',
    topology: {
      faces: [
        {
          topologyId: 'face:counterbore',
          hash: 701,
          triangleStart: 0,
          triangleCount: 12,
          geometry: {
            surfaceType: 'cylinder',
            area: 120,
            center: { x: 0, y: 0, z: 4 },
            radius: 5,
            diameter: 10,
            axisStart: { x: 0, y: 0, z: 0 },
            axisEnd: { x: 0, y: 0, z: 8 },
            axialLength: 8
          }
        }
      ],
      edges: []
    }
  };
  const importedFace: TopologySelection = {
    bodyId,
    kind: 'face',
    topologyId: 'face:counterbore',
    hash: 701
  };

  function importedProps(
    overrides: Partial<ComponentProps<typeof Inspector>> = {}
  ): ComponentProps<typeof Inspector> {
    return makeProps({
      selectedFeature: null,
      commandSession: null,
      selectedBody: importedBody,
      selectedTopology: importedFace,
      ...overrides
    });
  }

  it('shows a recognized kind with its dimensions and keeps the through-hole edit path', () => {
    const onResizeThroughHole = vi.fn();
    render(
      <Inspector
        {...importedProps({
          onResizeThroughHole,
          recognition: {
            kind: 'recognized',
            featureKind: 'counterbore',
            message: 'Counterbore recognized from the imported STEP body.',
            dimensions: {
              outerDiameter: 10,
              innerDiameter: 5,
              counterboreDepth: 2,
              totalDepth: 8
            }
          }
        })}
      />
    );
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(within(inspector).getByText('recognized')).toBeVisible();
    expect(within(inspector).getByText('Counterbore')).toBeVisible();
    expect(within(inspector).getByText('outer diameter')).toBeVisible();
    // Display-only: recognition adds rows, never a commit of its own.
    expect(
      within(inspector).queryByRole('button', { name: /Apply diameter/ })
    ).not.toBeInTheDocument();
    expect(onResizeThroughHole).not.toHaveBeenCalled();
  });

  it('marks read-only proof families as read-only beside their dimensions', () => {
    render(
      <Inspector
        {...importedProps({
          recognition: {
            kind: 'recognized',
            featureKind: 'cylindrical-boss',
            message: 'Boss recognized from the imported STEP body.',
            dimensions: { diameter: 10, height: 4 }
          }
        })}
      />
    );
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(within(inspector).getByText('Boss')).toBeVisible();
    expect(within(inspector).getByText(/read-only/)).toBeVisible();
  });

  it('shows the typed refusal reason when recognition declines', () => {
    render(
      <Inspector
        {...importedProps({
          recognition: {
            kind: 'unsupported',
            refusalReason: 'incomplete-proof',
            message:
              'The neighbouring faces do not complete any recognized feature proof.'
          }
        })}
      />
    );
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(inspector).toHaveTextContent('incomplete-proof');
    expect(inspector).toHaveTextContent(
      'The neighbouring faces do not complete any recognized feature proof.'
    );
  });

  it('narrates a pending query and a transport failure', () => {
    const { rerender } = render(
      <Inspector
        {...importedProps({ recognition: null, recognitionPending: true })}
      />
    );
    expect(screen.getByText(/Recognizing feature/)).toBeVisible();
    rerender(
      <Inspector
        {...importedProps({
          recognition: null,
          recognitionPending: false,
          recognitionError: 'worker gone'
        })}
      />
    );
    expect(screen.getByText(/worker gone/)).toBeVisible();
  });
});
