import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ArtifactId,
  ProjectDocument,
  ReferenceImage,
  ReferenceImageId
} from '@openzcad/shared';
import { ObjectsPanel, objectCount } from './ObjectsPanel';
import { useObjectsView } from './panelViews';

vi.mock('../../lib/datumPlanes', () => ({ datumPlaneRows: vi.fn(() => []) }));
vi.mock('../../lib/datumAxes', () => ({ datumAxisRows: vi.fn(() => []) }));

type PanelProps = Omit<ComponentProps<typeof ObjectsPanel>, 'view'>;

function Harness(props: PanelProps) {
  return <ObjectsPanel {...props} view={useObjectsView()} />;
}

const picture = (id: string, name: string): ReferenceImage => ({
  imageId: id as ReferenceImageId,
  name,
  contentType: 'image/jpeg',
  source: {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: 'f'.repeat(64),
    logicalBytes: 10
  },
  artifactId: 'artifact_one' as ArtifactId,
  pixelWidth: 10,
  pixelHeight: 10,
  plane: { type: 'canonical', plane: 'XY', offset: 0 },
  center: { u: 0, v: 0 },
  rotationDeg: 0,
  width: 10,
  opacity: 1
});

function props(extra: Partial<PanelProps> = {}): PanelProps {
  return {
    features: [],
    representations: {},
    document: {
      referenceImages: {
        images: [picture('rimg_a', 'Front photo'), picture('rimg_b', 'Plan')]
      }
    } as unknown as ProjectDocument,
    parameterValues: {},
    selectedFeatureNodeId: null,
    selectedSketchProfileId: null,
    selectedBodyIds: [],
    hiddenBodyIds: new Set(),
    hiddenSketchIds: new Set(),
    hiddenReferenceImageIds: new Set(['rimg_b']),
    onHiddenReferenceImageIdsChange: vi.fn(),
    selectedReferenceImageId: 'rimg_a',
    onSelectReferenceImage: vi.fn(),
    onSelectFeature: vi.fn(),
    onSelectBody: vi.fn(),
    onToggleBodyVisibility: vi.fn(),
    onToggleSketchVisibility: vi.fn(),
    ...extra
  };
}

describe('Objects image rows', () => {
  it('lists images with show/hide, counts them and opens one on click', () => {
    const panel = props();
    expect(objectCount(panel)).toBe(2);
    render(<Harness {...panel} />);
    const front = screen.getByRole('button', { name: /^Front photo/ });
    expect(front.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(front);
    expect(panel.onSelectReferenceImage).toHaveBeenCalledWith('rimg_a');
    fireEvent.click(
      screen.getByRole('button', { name: 'Hide image Front photo' })
    );
    expect(panel.onHiddenReferenceImageIdsChange).toHaveBeenLastCalledWith(
      new Set(['rimg_b', 'rimg_a'])
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show image Plan' }));
    expect(panel.onHiddenReferenceImageIdsChange).toHaveBeenLastCalledWith(
      new Set()
    );
  });

  it('filters to images and by name', () => {
    render(<Harness {...props()} />);
    fireEvent.change(screen.getByLabelText('Filter objects by type'), {
      target: { value: 'images' }
    });
    expect(
      screen.getAllByRole('button', { name: /Front photo|Plan/ })
    ).not.toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Find an object by name'), {
      target: { value: 'plan' }
    });
    expect(screen.queryByRole('button', { name: /Front photo/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Plan/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter objects by type'), {
      target: { value: 'bodies' }
    });
    expect(screen.queryByRole('button', { name: /^Plan/ })).toBeNull();
  });
});
