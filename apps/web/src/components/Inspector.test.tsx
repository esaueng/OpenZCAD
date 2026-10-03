import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  FeatureNode,
  ProjectDocument,
  TopologySelection
} from '@openzcad/shared';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { CommandManager, type AnyCommand } from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';
import type { MassPropertiesRead } from '@openzcad/kernel-adapter/exact';
import { MASS_DENSITY_STORAGE_KEY } from '../lib/massDensityPreference';
import { Inspector } from './Inspector';
import {
  createPrimitiveCommand,
  primitivePlacement
} from '../lib/primitivePlacement';

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
      'Selected face. To change its shape, edit the feature that made it in History.'
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

describe('primitive card position', () => {
  it('reads a placed box from the document and applies a move with its dimensions', () => {
    const manager = new CommandManager(
      createProjectDocument('Placed', toUserId('user_inspector_place'))
    );
    manager.execute(
      createPrimitiveCommand(
        'box',
        'Box',
        { width: 30, height: 18, depth: 24 },
        { x: 10, y: 0, z: 0 }
      )
    );
    const primitive = listFeaturesInOrder(manager.document)[0]!;
    const onApplyPrimitive =
      vi.fn<(feature: FeatureNode, name: string, command: AnyCommand) => void>();
    render(
      <Inspector
        {...makeProps({
          selectedFeature: primitive,
          commandSession: null,
          featureSelectionSource: 'pinned',
          document: manager.document,
          onApplyPrimitive
        })}
      />
    );
    const cornerX = screen.getByRole('textbox', { name: 'Corner X' });
    expect(cornerX).toHaveValue('10');
    fireEvent.change(cornerX, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(onApplyPrimitive).toHaveBeenCalledTimes(1);
    const [feature, name, command] = onApplyPrimitive.mock.calls[0]!;
    expect(feature).toBe(primitive);
    expect(name).toBe('Box');
    manager.execute(command);
    expect(
      primitivePlacement(manager.document, primitive).position
    ).toEqual({ x: 4, y: 0, z: 0 });
    expect(listFeaturesInOrder(manager.document)).toHaveLength(2);
  });
});

describe('primitive card naming', () => {
  it('numbers a placed box and leaves its placement Move without a body', () => {
    const manager = new CommandManager(
      createProjectDocument('Numbered', toUserId('user_inspector_number'))
    );
    manager.execute(
      createPrimitiveCommand(
        'box',
        'Box',
        { width: 10, height: 10, depth: 10 },
        { x: 0, y: 0, z: 0 },
        'Box 1'
      )
    );
    const onCreatePrimitive = vi.fn<(command: AnyCommand) => void>();
    render(
      <Inspector
        {...makeProps({
          tool: 'box',
          selectedFeature: null,
          document: manager.document,
          onCreatePrimitive
        })}
      />
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Corner X' }), {
      target: { value: '40' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create/ }));
    expect(onCreatePrimitive).toHaveBeenCalledTimes(1);
    manager.execute(onCreatePrimitive.mock.calls[0]![0]);
    const bodies = Object.values(manager.document.nodes).filter(
      (node) => node.kind === 'body'
    );
    // The second box is numbered; "Place Box" is a Move and makes no body.
    expect(bodies.map((node) => node.name)).toEqual(['Box 1', 'Box 2']);
    expect(
      listFeaturesInOrder(manager.document).map((node) => node.name)
    ).toEqual(['Box', 'Box', 'Place Box']);
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

describe('body appearance color picker', () => {
  it('closes only the color picker on Escape, leaving the inspector open', () => {
    const props = makeProps({
      selectedFeature: feature,
      featureSelectionSource: 'pinned',
      commandSession: null
    });
    render(<Inspector {...props} />);
    const swatch = screen.getByRole('button', { name: 'Pick body color' });
    fireEvent.click(swatch);
    expect(swatch).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(swatch, { key: 'Escape' });
    expect(swatch).toHaveAttribute('aria-expanded', 'false');
    expect(props.onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(swatch, { key: 'Escape' });
    expect(props.onCancel).toHaveBeenCalledOnce();
  });
});

describe('on-demand mass properties in Inspector', () => {
  const lazyBody = { ...body, massProperties: undefined };

  it('replaces a committed measurement with the matching preview document', async () => {
    const committed = createProjectDocument('Mass preview', toUserId('mass-ui'));
    const preview = { ...committed, derived: { ...committed.derived } };
    const previewBody = { ...lazyBody, volume: lazyBody.volume + 1 };
    let resolveCommitted!: (value: MassPropertiesRead) => void;
    const worker = {
      massProperties: vi.fn()
        .mockImplementationOnce(() => new Promise<MassPropertiesRead>((done) => {
          resolveCommitted = done;
        }))
        .mockResolvedValueOnce({
          status: 'ready',
          properties: {
            ...body.massProperties!,
            centerOfMass: { x: 9, y: 6, z: 3 }
          },
          epoch: 2
        })
    };
    const props = makeProps({
      selectedFeature: null,
      commandSession: null,
      selectedBody: lazyBody,
      massPropertiesDocument: committed,
      massPropertiesWorker: worker
    });
    const view = render(<Inspector {...props} />);
    fireEvent.click(screen.getByText('Mass properties (at unit density)'));
    await waitFor(() => expect(worker.massProperties).toHaveBeenCalledTimes(1));
    const oldSignal = (worker.massProperties.mock.calls[0] as unknown as [
      ProjectDocument,
      BodyId,
      { signal: AbortSignal }
    ])[2].signal;

    view.rerender(<Inspector {...props} selectedBody={previewBody} massPropertiesDocument={preview} />);
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(worker.massProperties).toHaveBeenCalledTimes(2));
    expect(worker.massProperties.mock.calls[1]?.[0]).toBe(preview);
    await waitFor(() => expect(screen.getByText('9, 6, 3 mm')).toBeInTheDocument());
    await act(async () => {
      resolveCommitted({ status: 'ready', properties: body.massProperties!, epoch: 1 });
    });
    expect(screen.getByText('9, 6, 3 mm')).toBeInTheDocument();
  });

  it('requests only when opened and shows pending then exact properties', async () => {
    const document = createProjectDocument('Mass details', toUserId('mass-ui'));
    let resolve!: (value: MassPropertiesRead) => void;
    const worker = {
      massProperties: vi.fn(() => new Promise<MassPropertiesRead>((done) => {
        resolve = done;
      }))
    };
    render(<Inspector {...makeProps({
      selectedFeature: null,
      commandSession: null,
      selectedBody: lazyBody,
      massPropertiesDocument: document,
      massPropertiesWorker: worker
    })} />);
    expect(worker.massProperties).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Mass properties (at unit density)'));
    await waitFor(() => expect(worker.massProperties).toHaveBeenCalledOnce());
    const massCall = worker.massProperties.mock.calls[0] as unknown as [
      ProjectDocument,
      BodyId,
      { signal: AbortSignal }
    ];
    expect(massCall[0]).toBe(document);
    expect(massCall[1]).toBe(bodyId);
    expect(massCall[2].signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText('Measuring mass properties…')).toBeInTheDocument();
    await act(async () => {
      resolve({ status: 'ready', properties: body.massProperties!, epoch: 1 });
    });
    expect(screen.getByText('center of mass')).toBeInTheDocument();
    expect(worker.massProperties).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale project result and distinguishes unavailable from errors', async () => {
    const first = createProjectDocument('Old project', toUserId('mass-ui'));
    const second = createProjectDocument('New project', toUserId('mass-ui'));
    let resolveFirst!: (value: MassPropertiesRead) => void;
    const worker = {
      massProperties: vi.fn()
        .mockImplementationOnce(() => new Promise<MassPropertiesRead>((done) => {
          resolveFirst = done;
        }))
        .mockResolvedValueOnce({
          status: 'unavailable',
          code: 'unsupported',
          reason: 'No live solid is available.',
          epoch: 2
        })
        .mockRejectedValueOnce(new Error('Kernel request failed'))
    };
    const props = makeProps({
      selectedFeature: null,
      commandSession: null,
      selectedBody: lazyBody,
      massPropertiesDocument: first,
      massPropertiesWorker: worker
    });
    const view = render(<Inspector {...props} />);
    fireEvent.click(screen.getByText('Mass properties (at unit density)'));
    await waitFor(() => expect(worker.massProperties).toHaveBeenCalledTimes(1));
    const firstSignal = (worker.massProperties.mock.calls[0] as unknown as [
      ProjectDocument,
      BodyId,
      { signal: AbortSignal }
    ])[2].signal;
    view.rerender(<Inspector {...props} massPropertiesDocument={second} />);
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(screen.getByText('No live solid is available.')).toBeInTheDocument());
    await act(async () => {
      resolveFirst({ status: 'ready', properties: body.massProperties!, epoch: 1 });
    });
    expect(screen.queryByText('center of mass')).not.toBeInTheDocument();

    const changedBody = { ...lazyBody, name: 'Changed bracket' };
    view.rerender(<Inspector {...props} selectedBody={changedBody} massPropertiesDocument={second} />);
    const secondSignal = (worker.massProperties.mock.calls[1] as unknown as [
      ProjectDocument,
      BodyId,
      { signal: AbortSignal }
    ])[2].signal;
    expect(secondSignal.aborted).toBe(true);
    await waitFor(() => expect(screen.getByText('Mass measurement failed: Kernel request failed')).toBeInTheDocument());
  });
});

describe('mass properties tensor, axes and density', () => {
  afterEach(() => {
    window.localStorage.removeItem(MASS_DENSITY_STORAGE_KEY);
  });

  function committedProps(
    overrides: Partial<ComponentProps<typeof Inspector>> = {}
  ): ComponentProps<typeof Inspector> {
    return makeProps({
      selectedFeature: null,
      commandSession: null,
      ...overrides
    });
  }

  function openMassSection(): void {
    fireEvent.click(screen.getByText('Mass properties (at unit density)'));
  }

  it('shows the tensor and axes at unit density beside the existing rows', () => {
    render(<Inspector {...committedProps()} />);
    openMassSection();
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    // Existing rows are untouched: same labels, same unit-density honesty.
    expect(within(inspector).getByText('center of mass')).toBeVisible();
    expect(within(inspector).getByText('principal inertia')).toBeVisible();
    expect(within(inspector).getByText('5, 6, 3 mm')).toBeVisible();
    // The full tensor about the centre of mass, in model axes, in mm⁵.
    expect(within(inspector).getByText('inertia tensor')).toBeVisible();
    expect(within(inspector).getByText('1 0 0')).toBeVisible();
    expect(within(inspector).getByText('0 2 0')).toBeVisible();
    expect(within(inspector).getByText(/0 0 3 mm⁵/)).toBeVisible();
    // Each principal direction, numbered to match its moment.
    expect(within(inspector).getByText('principal axes')).toBeVisible();
    expect(within(inspector).getByText('1 · (1, 0, 0)')).toBeVisible();
    expect(within(inspector).getByText('2 · (0, 1, 0)')).toBeVisible();
    expect(within(inspector).getByText('3 · (0, 0, 1)')).toBeVisible();
    // Provenance states the method without claiming a verdict it has no
    // evidence for.
    expect(within(inspector).getByText(/no tessellation/)).toBeVisible();
    expect(
      within(inspector).queryByText(/Exact/)
    ).not.toBeInTheDocument();
  });

  it('scales mass and inertia through a steel preset in grams and g·mm²', () => {
    // 120 mm³ of steel: 7850 × 120e-9 m³ = 9.42e-4 kg = 0.942 g.
    render(<Inspector {...committedProps()} />);
    openMassSection();
    fireEvent.change(screen.getByLabelText('Material density'), {
      target: { value: 'preset:steel' }
    });
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(
      within(inspector).getByText('Mass properties (Steel · 7850 kg/m³)')
    ).toBeVisible();
    expect(within(inspector).getByText('0.942 g')).toBeVisible();
    // Moments [1, 2, 3] mm⁵ × 7850 kg/m³ × 1e-6 (mm⁵→g·mm² at this density).
    expect(
      within(inspector).getByText('0.008 · 0.016 · 0.024 g·mm²')
    ).toBeVisible();
    // Directions do not move with density; the centre of mass neither.
    expect(within(inspector).getByText('1 · (1, 0, 0)')).toBeVisible();
    expect(within(inspector).getByText('5, 6, 3 mm')).toBeVisible();
  });

  it('remembers the material per project across mounts', () => {
    const document = createProjectDocument('Heavy', toUserId('mass-ui'));
    const first = render(
      <Inspector {...committedProps({ massPropertiesDocument: document })} />
    );
    openMassSection();
    fireEvent.change(screen.getByLabelText('Material density'), {
      target: { value: 'preset:steel' }
    });
    expect(screen.getByText('0.942 g')).toBeVisible();
    first.unmount();
    render(
      <Inspector {...committedProps({ massPropertiesDocument: document })} />
    );
    expect(
      screen.getByLabelText('Material density')
    ).toHaveValue('preset:steel');
    // A project with no remembered choice still opens at unit density.
    const other = createProjectDocument('Light', toUserId('mass-ui'));
    const second = render(
      <Inspector {...committedProps({ massPropertiesDocument: other })} />
    );
    expect(
      (screen.getAllByLabelText('Material density').at(-1) as HTMLSelectElement)
        .value
    ).toBe('unit');
    second.unmount();
  });

  it('takes a custom density and refuses text without losing the last valid one', () => {
    render(<Inspector {...committedProps()} />);
    openMassSection();
    fireEvent.change(screen.getByLabelText('Material density'), {
      target: { value: 'custom' }
    });
    const input = screen.getByLabelText(
      'Custom density in kilograms per cubic metre'
    );
    expect(input).toHaveValue('1000');
    fireEvent.change(input, { target: { value: '2700' } });
    // 120 mm³ at 2700 kg/m³ = 3.24e-4 kg = 0.324 g.
    expect(screen.getByText('0.324 g')).toBeVisible();
    fireEvent.change(input, { target: { value: 'not a number' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/positive density/);
    // The refused text publishes nothing: the last valid material stands.
    expect(screen.getByText('0.324 g')).toBeVisible();
  });

  it('weighs an inch document in pounds and lb·in²', () => {
    const document = createProjectDocument('Inch block', toUserId('mass-ui'), 'inch');
    const inchBody = {
      ...body,
      volume: 6,
      massProperties: {
        centerOfMass: { x: 0.5, y: 1, z: 1.5 },
        inertia: [6.5, 5, 2.5, 0, 0, 0] as [number, number, number, number, number, number],
        principalMoments: [2.5, 5, 6.5] as [number, number, number],
        principalAxes: [
          { x: 0, y: 0, z: 1 },
          { x: 0, y: 1, z: 0 },
          { x: 1, y: 0, z: 0 }
        ] as [{ x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }]
      }
    };
    render(
      <Inspector
        {...committedProps({
          selectedBody: inchBody,
          units: 'inch',
          massPropertiesDocument: document
        })}
      />
    );
    // Unit density first: closed in⁵, unchanged shape of display.
    openMassSection();
    expect(screen.getByText(/0 0 2.5 in⁵/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Material density'), {
      target: { value: 'preset:steel' }
    });
    // 6 in³ of steel = 0.7718 kg = 1.702 lb.
    expect(screen.getByText('1.702 lb')).toBeVisible();
    expect(
      screen.getByText('0.709 · 1.418 · 1.843 lb·in²')
    ).toBeVisible();
    expect(screen.getByText('0 0 0.709 lb·in²')).toBeVisible();
    expect(screen.getByText('0.5, 1, 1.5 in')).toBeVisible();
  });
});
