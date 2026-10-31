import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  EdgeWitnessV1,
  FeatureNode,
  ProjectDocument,
  SketchObjectData,
  TopologySelection
} from '@openzcad/shared';
import {
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import { edgeTopologyWitnessHash, toUserId } from '@openzcad/shared';
import type { MassPropertiesRead } from '@openzcad/kernel-adapter/exact';
import { MASS_DENSITY_STORAGE_KEY } from '../lib/massDensityPreference';
import { BodyStats, Inspector } from './Inspector';
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

/** A Move still edits in its card (U09 phase 7 leaves it to its gizmo). */
const moveFeature: FeatureNode = {
  ...feature,
  featureKind: 'transform',
  name: 'Lift bracket',
  data: {
    featureKind: 'transform',
    targetBodyId: bodyId,
    transform: {
      translation: { x: 2, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }
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
    scope: {},
    bodies: [{ bodyId, name: body.name, consumed: false }],
    units: 'mm',
    commandSession: {
      id: 'fillet',
      title: 'Fillet',
      target: { kind: 'face', count: 1 },
      phase: 'armed',
      error: null
    },
    featureSelectionSource: 'inferred',
    // These suites read the card a direct pick gets once it is asked for;
    // 'direct pick details' below pins that it stays closed until then.
    directPickDetails: true,
    onLaunchTool: vi.fn(),
    onCancel: vi.fn(),
    onApplyPrimitive: vi.fn(),
    onApplySketch: vi.fn(),
    onConvertSketchToFixedPlane: vi.fn(),
    onApplyTextSketch: vi.fn(),
    onEditSketchInViewport: vi.fn(),
    onApplyTransform: vi.fn(),
    onResizeThroughHole: vi.fn(),
    onRemoveFaceFeature: vi.fn(),
    onPinFeature: vi.fn(),
    onDeleteFeature: vi.fn(),
    onToggleImportedSolid: vi.fn(),
    ...overrides
  };
}

describe('direct pick details', () => {
  it('identifies committed measurements when a form has unapplied values', () => {
    render(<BodyStats body={body} units="mm" lastApplied />);
    expect(screen.getByText('Measurements (last applied)')).toBeVisible();
    expect(screen.getByText('last applied model')).toBeVisible();
    expect(screen.queryByText('live')).toBeNull();
  });
  it('draws no card for an inferred face, edge or body until asked', () => {
    const picks: Array<Partial<ComponentProps<typeof Inspector>>> = [
      { selectedTopology: frontFace },
      {
        selectedTopology: {
          bodyId,
          kind: 'edge',
          topologyId: 'edge:front-top',
          hash: 22
        }
      },
      { selectedTopology: null }
    ];
    for (const pick of picks) {
      const { container, unmount } = render(
        <Inspector
          {...makeProps({
            ...pick,
            commandSession: null,
            directPickDetails: false
          })}
        />
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('draws no card for a face no feature claims until asked', () => {
    const { container } = render(
      <Inspector
        {...makeProps({
          selectedFeature: null,
          commandSession: null,
          directPickDetails: false
        })}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('still opens the card for a feature pinned from History', () => {
    render(
      <Inspector
        {...makeProps({
          featureSelectionSource: 'pinned',
          directPickDetails: false
        })}
      />
    );
    expect(
      screen.getByRole('region', { name: 'Feature inspector' })
    ).toBeInTheDocument();
  });
});

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
      'Selected face. Drag an available face handle to adjust its shape, or edit the feature that made it in History.'
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
      selectedFeature: moveFeature,
      commandSession: null,
      featureSelectionSource: 'pinned',
      onValidateSelection: () => false
    });
    render(<Inspector {...props} />);
    fireEvent.change(screen.getByLabelText('Move X in mm'), {
      target: { value: '3' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(props.onApplyTransform).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: /Delete feature/ }));
    expect(props.onDeleteFeature).not.toHaveBeenCalled();
  });

  it('resets a form to committed values after undo, redo or a document update', () => {
    const props = makeProps({
      selectedFeature: moveFeature,
      commandSession: null,
      featureSelectionSource: 'pinned',
      documentVersion: 1
    });
    const { rerender } = render(<Inspector {...props} />);
    fireEvent.change(screen.getByLabelText('Move X in mm'), {
      target: { value: '9' }
    });
    rerender(<Inspector {...props} documentVersion={2} />);
    expect(screen.getByLabelText('Move X in mm')).toHaveValue('2');
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
          selectedFeature: moveFeature,
          featureSelectionSource: 'pinned'
        })}
      />
    );

    const inspector = screen.getByRole('region', {
      name: 'Feature inspector'
    });
    expect(inspector).not.toHaveClass('object-readout');
    expect(within(inspector).getByLabelText('Move X in mm')).toHaveValue('2');
    expect(
      within(inspector).getByText('Measurements (last applied)')
    ).toBeVisible();
    fireEvent.click(within(inspector).getByLabelText('More actions'));
    expect(
      within(inspector).getByRole('button', { name: /Delete feature/ })
    ).toBeVisible();
  });

  it.each([
    ['face', frontFace, 'Front face'],
    [
      'edge',
      { bodyId, kind: 'edge', topologyId: 'edge:rim', hash: 11 },
      'Edge'
    ],
    ['body', { bodyId, kind: 'body' }, body.name]
  ] as const)(
    'keeps an inferred %s read-only without a command',
    (_kind, topology, title) => {
      const props = makeProps({
        commandSession: null,
        selectedTopology: topology
      });
      render(<Inspector {...props} />);
      const inspector = screen.getByRole('region', {
        name: 'Feature inspector'
      });
      expect(inspector).toHaveClass('object-readout');
      expect(
        within(inspector).getByRole('heading', { level: 2 })
      ).toHaveTextContent(title);
      expect(within(inspector).getByText('120 mm³')).toBeVisible();
      expect(
        within(inspector).queryByLabelText('Radius')
      ).not.toBeInTheDocument();
      expect(
        within(inspector).queryByLabelText('More actions')
      ).not.toBeInTheDocument();
      fireEvent.click(within(inspector).getByRole('button', { name: 'Edit' }));
      expect(props.onPinFeature).toHaveBeenCalledWith(feature);
    }
  );

  it('refuses Edit when the inferred selection has gone stale', () => {
    const props = makeProps({ onValidateSelection: () => false });
    render(<Inspector {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(props.onPinFeature).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Radius')).not.toBeInTheDocument();
  });

  it('holds keyboard focus when Edit replaces the readout with a feature form', () => {
    function Harness() {
      const [pinned, setPinned] = useState(false);
      return (
        <Inspector
          {...makeProps({
            selectedFeature: moveFeature,
            featureSelectionSource: pinned ? 'pinned' : 'inferred',
            commandSession: null,
            onPinFeature: () => setPinned(true)
          })}
        />
      );
    }
    render(<Harness />);
    const edit = screen.getByRole('button', { name: 'Edit' });
    edit.focus();
    fireEvent.click(edit);
    expect(
      screen.getByRole('region', { name: 'Feature inspector' })
    ).toHaveFocus();
    expect(screen.getByLabelText('Move X in mm')).toHaveValue('2');
    expect(screen.getByLabelText('More actions')).toBeVisible();
  });

  it("keeps a fillet's readout and Delete but no form: it edits in place", () => {
    const onEditModelingFeature = vi.fn();
    const props = makeProps({
      commandSession: null,
      featureSelectionSource: 'pinned',
      onEditModelingFeature
    });
    render(<Inspector {...props} />);
    const inspector = screen.getByRole('region', {
      name: 'Feature inspector'
    });
    expect(within(inspector).getByText('Measurements')).toBeVisible();
    expect(
      within(inspector).queryByLabelText('Radius')
    ).not.toBeInTheDocument();
    expect(within(inspector).getByText('120 mm³')).toBeVisible();
    fireEvent.click(
      within(inspector).getByRole('button', { name: 'Edit fillet' })
    );
    expect(onEditModelingFeature).toHaveBeenCalledWith(feature);
    fireEvent.click(screen.getByLabelText('More actions'));
    expect(
      screen.getByRole('button', { name: /Delete feature/ })
    ).toBeVisible();
  });
});

describe('an edit card opened from History', () => {
  it('names its step and keeps the full title on its own row', () => {
    const document = {
      featureOrder: ['feature-0', feature.featureId, 'feature-2'],
      derived: { bodyRepresentations: {} }
    } as unknown as ProjectDocument;
    render(
      <Inspector
        {...makeProps({
          commandSession: null,
          featureSelectionSource: 'pinned',
          document
        })}
      />
    );
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(inspector).toHaveClass('edit-card');
    expect(inspector.querySelector('.panel-eyebrow')).toHaveTextContent(
      'Edit feature · Step 2 of 3'
    );
  });

  it('names no step for an object readout', () => {
    render(<Inspector {...makeProps()} />);
    expect(
      screen.getByRole('region', { name: 'Feature inspector' })
    ).not.toHaveClass('edit-card');
  });
});

describe('a split readout', () => {
  it('reads the second half from the document on screen, as the first', () => {
    const secondBodyId = 'body-2' as BodyId;
    const split: FeatureNode = {
      ...feature,
      featureKind: 'split',
      name: 'Split 1',
      data: {
        featureKind: 'split',
        targetBodyId: bodyId,
        plane: { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
        secondBodyId
      }
    };
    const half = (name: string): BodyRepresentation => ({
      ...body,
      bodyId: secondBodyId,
      name
    });
    render(
      <Inspector
        {...makeProps({
          selectedFeature: split,
          featureSelectionSource: 'pinned',
          commandSession: null,
          bodyRepresentations: { [secondBodyId]: half('Half as committed') },
          massPropertiesDocument: {
            derived: {
              bodyRepresentations: { [secondBodyId]: half('Half as previewed') }
            }
          } as unknown as ProjectDocument
        })}
      />
    );
    expect(screen.getByText('Half as previewed')).toBeInTheDocument();
    expect(screen.queryByText('Half as committed')).toBeNull();
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
      vi.fn<
        (feature: FeatureNode, name: string, command: AnyCommand) => void
      >();
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
    expect(primitivePlacement(manager.document, primitive).position).toEqual({
      x: 4,
      y: 0,
      z: 0
    });
    expect(listFeaturesInOrder(manager.document)).toHaveLength(2);
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

  it('opens the face editor, not just the readout, when Edit face asks for an inferred feature', () => {
    render(
      <Inspector
        {...importedProps({
          selectedFeature: feature,
          featureSelectionSource: 'inferred',
          directPickDetails: true
        })}
      />
    );
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(inspector).toHaveClass('object-readout');
    expect(
      screen.getByRole('region', { name: 'Selected face properties' })
    ).toBeInTheDocument();
  });

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

describe('on-demand mass properties in Inspector', () => {
  const lazyBody = { ...body, massProperties: undefined };

  it('replaces a committed measurement with the matching preview document', async () => {
    const committed = createProjectDocument(
      'Mass preview',
      toUserId('mass-ui')
    );
    const preview = { ...committed, derived: { ...committed.derived } };
    const previewBody = { ...lazyBody, volume: lazyBody.volume + 1 };
    let resolveCommitted!: (value: MassPropertiesRead) => void;
    const worker = {
      massProperties: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<MassPropertiesRead>((done) => {
              resolveCommitted = done;
            })
        )
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
    const oldSignal = (
      worker.massProperties.mock.calls[0] as unknown as [
        ProjectDocument,
        BodyId,
        { signal: AbortSignal }
      ]
    )[2].signal;

    view.rerender(
      <Inspector
        {...props}
        selectedBody={previewBody}
        massPropertiesDocument={preview}
      />
    );
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(worker.massProperties).toHaveBeenCalledTimes(2));
    expect(worker.massProperties.mock.calls[1]?.[0]).toBe(preview);
    await waitFor(() =>
      expect(screen.getByText('9, 6, 3 mm')).toBeInTheDocument()
    );
    await act(async () => {
      resolveCommitted({
        status: 'ready',
        properties: body.massProperties!,
        epoch: 1
      });
    });
    expect(screen.getByText('9, 6, 3 mm')).toBeInTheDocument();
  });

  it('requests only when opened and shows pending then exact properties', async () => {
    const document = createProjectDocument('Mass details', toUserId('mass-ui'));
    let resolve!: (value: MassPropertiesRead) => void;
    const worker = {
      massProperties: vi.fn(
        () =>
          new Promise<MassPropertiesRead>((done) => {
            resolve = done;
          })
      )
    };
    render(
      <Inspector
        {...makeProps({
          selectedFeature: null,
          commandSession: null,
          selectedBody: lazyBody,
          massPropertiesDocument: document,
          massPropertiesWorker: worker
        })}
      />
    );
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
      massProperties: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<MassPropertiesRead>((done) => {
              resolveFirst = done;
            })
        )
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
    const firstSignal = (
      worker.massProperties.mock.calls[0] as unknown as [
        ProjectDocument,
        BodyId,
        { signal: AbortSignal }
      ]
    )[2].signal;
    view.rerender(<Inspector {...props} massPropertiesDocument={second} />);
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() =>
      expect(
        screen.getByText('No live solid is available.')
      ).toBeInTheDocument()
    );
    await act(async () => {
      resolveFirst({
        status: 'ready',
        properties: body.massProperties!,
        epoch: 1
      });
    });
    expect(screen.queryByText('center of mass')).not.toBeInTheDocument();

    const changedBody = { ...lazyBody, name: 'Changed bracket' };
    view.rerender(
      <Inspector
        {...props}
        selectedBody={changedBody}
        massPropertiesDocument={second}
      />
    );
    const secondSignal = (
      worker.massProperties.mock.calls[1] as unknown as [
        ProjectDocument,
        BodyId,
        { signal: AbortSignal }
      ]
    )[2].signal;
    expect(secondSignal.aborted).toBe(true);
    await waitFor(() =>
      expect(
        screen.getByText('Mass measurement failed: Kernel request failed')
      ).toBeInTheDocument()
    );
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
    expect(within(inspector).queryByText(/Exact/)).not.toBeInTheDocument();
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
    expect(screen.getByLabelText('Material density')).toHaveValue(
      'preset:steel'
    );
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
    const document = createProjectDocument(
      'Inch block',
      toUserId('mass-ui'),
      'inch'
    );
    const inchBody = {
      ...body,
      volume: 6,
      massProperties: {
        centerOfMass: { x: 0.5, y: 1, z: 1.5 },
        inertia: [6.5, 5, 2.5, 0, 0, 0] as [
          number,
          number,
          number,
          number,
          number,
          number
        ],
        principalMoments: [2.5, 5, 6.5] as [number, number, number],
        principalAxes: [
          { x: 0, y: 0, z: 1 },
          { x: 0, y: 1, z: 0 },
          { x: 1, y: 0, z: 0 }
        ] as [
          { x: number; y: number; z: number },
          { x: number; y: number; z: number },
          { x: number; y: number; z: number }
        ]
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
    expect(screen.getByText('0.709 · 1.418 · 1.843 lb·in²')).toBeVisible();
    expect(screen.getByText('0 0 0.709 lb·in²')).toBeVisible();
    expect(screen.getByText('0.5, 1, 1.5 in')).toBeVisible();
  });
});

describe('direct-edit readout', () => {
  it('keeps imported mesh details labeled as current measurements', () => {
    const meshFeature: FeatureNode = {
      ...feature,
      featureKind: 'imported-mesh',
      name: 'Imported mesh',
      data: {
        featureKind: 'imported-mesh',
        artifactId: 'artifact-mesh' as Extract<
          FeatureNode['data'],
          { featureKind: 'imported-mesh' }
        >['artifactId'],
        sourceName: 'bracket.stl',
        triangleCount: 12,
        vertices: [],
        indices: []
      }
    };
    render(
      <Inspector
        {...makeProps({
          selectedFeature: meshFeature,
          selectedTopology: null,
          commandSession: null,
          featureSelectionSource: 'pinned'
        })}
      />
    );
    expect(screen.getByText('bracket.stl')).toBeVisible();
    expect(screen.getByText('Measurements')).toBeVisible();
    expect(screen.getByText('live')).toBeVisible();
    expect(screen.queryByText('last applied model')).toBeNull();
  });
  /*
    The readout printed `String()` of each stored value: raw floats with no
    unit, and the countersink angle as 1.5707963267948966 "(rad)" while the
    recognition panel above showed the same quantity in degrees.
  */
  it('rounds stored values, names the unit, and shows angles in degrees', () => {
    const directEdit = {
      ...feature,
      featureKind: 'direct-edit',
      name: 'Countersink resize',
      data: {
        featureKind: 'direct-edit',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-imported-countersink',
          faceHash: 701,
          sourceOpeningPoint: { x: 0, y: 0, z: 0 },
          sourceAxisDirection: { x: 0, y: 0, z: -1 },
          sourceBoreDiameter: 5,
          sourceSinkDiameter: 10,
          sourceAngleRadians: Math.PI / 2,
          sourceCountersinkDepth: 2.5,
          sourceTotalDepth: 8,
          boreDiameter: 'bore',
          sinkDiameter: 10.123456,
          angleRadians: Math.PI / 2
        }
      }
    } as unknown as FeatureNode;
    render(
      <Inspector
        {...makeProps({
          selectedFeature: directEdit,
          selectedTopology: null,
          commandSession: null,
          featureSelectionSource: 'pinned',
          scope: { bore: 5.5 },
          units: 'inch'
        })}
      />
    );
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(within(inspector).getByText('bore = 5.5 in')).toBeVisible();
    expect(within(inspector).getByText('10.123 in')).toBeVisible();
    expect(within(inspector).getByText('included angle')).toBeVisible();
    expect(within(inspector).getByText('90°')).toBeVisible();
    expect(within(inspector).getByText('Measurements')).toBeVisible();
    expect(within(inspector).getByText('live')).toBeVisible();
    expect(within(inspector).queryByText('last applied model')).toBeNull();
  });
});

describe('Inspector sketch editing (S04)', () => {
  function sketchProps(objects: SketchObjectData[]) {
    const manager = new CommandManager(
      createProjectDocument('Sketches', toUserId('user_inspector'))
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Plate',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects
      })
    );
    const document = manager.document;
    const sketch = findSketch(document, document.sketchOrder[0]!)!;
    const sketchFeature = listFeaturesInOrder(document).find(
      (candidate) => candidate.featureKind === 'sketch'
    )!;
    const first = document.nodes[sketch.objectIds[0]!];
    return makeProps({
      document,
      selectedFeature: sketchFeature,
      selectedSketch: sketch,
      selectedSketchObject: first?.kind === 'sketch-object' ? first.data : null,
      selectedBody: null,
      selectedTopology: null,
      commandSession: null,
      featureSelectionSource: 'pinned'
    });
  }

  it('keeps a sketch of held lines out of the one-shape form', () => {
    const corners = [
      [0, 0],
      [20, 0],
      [20, 12],
      [0, 12]
    ] as const;
    const sides: SketchObjectData[] = corners.map(([x1, y1], index) => {
      const [x2, y2] = corners[(index + 1) % 4]!;
      return { objectKind: 'line', x1, y1, x2, y2 };
    });
    const props = sketchProps(sides);
    render(<Inspector {...props} />);
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(inspector).toHaveTextContent('4 objects');
    expect(
      within(inspector).queryByRole('button', { name: 'Apply' })
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(inspector).getByRole('button', { name: 'Edit sketch in viewport' })
    );
    expect(props.onEditSketchInViewport).toHaveBeenCalled();
    expect(props.onApplySketch).not.toHaveBeenCalled();
  });

  it('still edits a sketch that is one parametric rectangle', () => {
    render(
      <Inspector
        {...sketchProps([
          {
            objectKind: 'rectangle',
            width: 20,
            height: 12,
            centerX: 10,
            centerY: 6
          }
        ])}
      />
    );
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(
      within(inspector).getByRole('button', { name: 'Apply' })
    ).toBeInTheDocument();
  });

  it('keeps a lone projected circle out of the one-shape form (I01)', () => {
    // Apply there would rebuild a plain circle and drop the edge link.
    const witness: EdgeWitnessV1 = {
      curveType: 'CIRCLE',
      length: 1,
      closed: true,
      center: [0, 0, 0],
      axis: null
    };
    const props = sketchProps([
      {
        objectKind: 'circle',
        centerX: 0,
        centerY: 0,
        radius: 4,
        projection: {
          mode: 'linked',
          source: {
            bodyId: 'body_post' as never,
            edgeReference: {
              kind: 'edge',
              producingFeatureId: 'feat_post' as never,
              lineageName: 'edge.rim',
              currentHash: edgeTopologyWitnessHash(witness),
              witnessVersion: 1,
              witness
            }
          }
        }
      }
    ]);
    render(<Inspector {...props} />);
    const inspector = screen.getByRole('region', { name: 'Feature inspector' });
    expect(inspector).toHaveTextContent('1 object');
    expect(
      within(inspector).queryByRole('button', { name: 'Apply' })
    ).not.toBeInTheDocument();
    expect(props.onApplySketch).not.toHaveBeenCalled();
  });
});
