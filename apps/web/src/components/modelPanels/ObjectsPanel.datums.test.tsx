import { render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { datumAxisRows } from '../../lib/datumAxes';
import { datumPlaneRows } from '../../lib/datumPlanes';
import { ObjectsPanel, objectCount } from './ObjectsPanel';
import { useObjectsView } from './panelViews';

vi.mock('../../lib/datumPlanes', () => ({ datumPlaneRows: vi.fn(() => []) }));
vi.mock('../../lib/datumAxes', () => ({ datumAxisRows: vi.fn(() => []) }));

type PanelProps = Omit<ComponentProps<typeof ObjectsPanel>, 'view'>;

function Harness(props: PanelProps) {
  return <ObjectsPanel {...props} view={useObjectsView()} />;
}

describe('Objects datum rows', () => {
  it('builds them once for the header count and the panel', () => {
    const document = {} as PanelProps['document'];
    const parameterValues = {};
    const props: PanelProps = {
      features: [],
      representations: {},
      document,
      parameterValues,
      selectedFeatureNodeId: null,
      selectedSketchProfileId: null,
      selectedBodyIds: [],
      hiddenBodyIds: new Set(),
      hiddenSketchIds: new Set(),
      onSelectFeature: vi.fn(),
      onSelectBody: vi.fn(),
      onToggleBodyVisibility: vi.fn(),
      onToggleSketchVisibility: vi.fn()
    };

    expect(objectCount(props)).toBe(0);
    render(<Harness {...props} />);
    expect(datumPlaneRows).toHaveBeenCalledTimes(1);
    expect(datumAxisRows).toHaveBeenCalledTimes(1);

    // A new parameter scope is a new model state: the rows are rebuilt.
    objectCount({ ...props, parameterValues: { width: 2 } });
    expect(datumPlaneRows).toHaveBeenCalledTimes(2);
  });
});
