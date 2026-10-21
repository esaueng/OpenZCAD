import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BodyRepresentation,
  FeatureId,
  FeatureNode
} from '@openzcad/shared';
import { modelBodies, ObjectsPanel, objectCount } from './ObjectsPanel';
import { useObjectsView } from './panelViews';

function feature(
  index: number,
  overrides: Partial<FeatureNode> = {}
): FeatureNode {
  return {
    id: `node-${index}`,
    kind: 'feature',
    name: `Feature ${index}`,
    featureId: `feature-${index}` as FeatureId,
    featureKind: 'extrude',
    data: { featureKind: 'extrude' },
    ...overrides
  } as unknown as FeatureNode;
}

function sketch(index: number, name: string): FeatureNode {
  return feature(index, {
    name,
    featureKind: 'sketch',
    data: { featureKind: 'sketch', sketchId: `sketch-${index}` }
  } as Partial<FeatureNode>);
}

function body(id: string, name: string, consumed = false): BodyRepresentation {
  return { bodyId: id, name, consumed } as unknown as BodyRepresentation;
}

type PanelProps = Omit<ComponentProps<typeof ObjectsPanel>, 'view'>;

function Harness(props: PanelProps) {
  return <ObjectsPanel {...props} view={useObjectsView()} />;
}

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    features: [],
    representations: {},
    parameterValues: {},
    selectedFeatureNodeId: null,
    selectedSketchProfileId: null,
    selectedBodyIds: [],
    hiddenBodyIds: new Set(),
    hiddenSketchIds: new Set(),
    onSelectFeature: vi.fn(),
    onSelectBody: vi.fn(),
    onToggleBodyVisibility: vi.fn(),
    onToggleSketchVisibility: vi.fn(),
    ...overrides
  };
  return { ...render(<Harness {...props} />), props };
}

describe('ObjectsPanel', () => {
  it('says how to start when there are no objects', () => {
    renderPanel();
    expect(
      screen.getByText(
        'No objects yet. Create a body or sketch to get started.'
      )
    ).toHaveAttribute('role', 'listitem');
    expect(
      objectCount({ features: [], representations: {}, parameterValues: {} })
    ).toBe(0);
  });

  it('filters by type and name without touching selection', async () => {
    const user = userEvent.setup();
    const plate = body('body-1', 'Plate');
    const features = [
      sketch(1, 'Base outline'),
      feature(2, { bodyId: plate.bodyId })
    ];
    renderPanel({
      features,
      representations: { [plate.bodyId]: plate },
      selectedBodyIds: [plate.bodyId]
    });
    const list = within(screen.getByRole('list', { name: 'Objects' }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    const filter = screen.getByRole('combobox', {
      name: 'Filter objects by type'
    });
    await user.selectOptions(filter, 'sketches');
    expect(list.queryByRole('button', { name: 'Plate' })).toBeNull();
    expect(
      list.getByRole('button', { name: 'Base outline' })
    ).toBeInTheDocument();
    await user.selectOptions(filter, 'planes');
    expect(
      list.getByText(
        'No planes yet. Use Plane to offset one from a plane or face.'
      )
    ).toBeInTheDocument();
    await user.selectOptions(filter, 'all');
    await user.type(
      screen.getByRole('searchbox', { name: 'Find an object by name' }),
      'pla'
    );
    expect(list.getByRole('button', { name: 'Plate' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(list.queryByRole('button', { name: 'Base outline' })).toBeNull();
  });

  it('counts live bodies, sketches and datums but keeps sources behind a disclosure', async () => {
    const user = userEvent.setup();
    const source = body('source', 'Source', true);
    const result = body('result', 'Result');
    const features = [
      feature(1, { bodyId: source.bodyId }),
      sketch(2, 'Profile'),
      feature(3, { bodyId: result.bodyId })
    ];
    const representations = {
      [result.bodyId]: result,
      [source.bodyId]: source
    };
    expect(
      modelBodies({ features, representations }).map((entry) => entry.name)
    ).toEqual(['Source', 'Result']);
    expect(
      objectCount({ features, representations, parameterValues: {} })
    ).toBe(2);
    renderPanel({ features, representations });
    expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '1 source body' }));
    expect(screen.getByRole('button', { name: 'Source' })).toBeInTheDocument();
  });
});
