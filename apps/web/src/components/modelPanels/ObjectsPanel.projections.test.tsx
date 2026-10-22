import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  edgeTopologyWitnessHash,
  toBodyId,
  toUserId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { ObjectsPanel } from './ObjectsPanel';
import { useObjectsView } from './panelViews';

/**
 * I01 in U06: a sketch's Objects row says what it projects, each projected
 * entity names its source and its linked or independent role, and a linked
 * one the last build could not re-find reads as broken.
 */

type PanelProps = Omit<ComponentProps<typeof ObjectsPanel>, 'view'>;

function Harness(props: PanelProps) {
  return <ObjectsPanel {...props} view={useObjectsView()} />;
}

const source = {
  bodyId: toBodyId('body_block'),
  edgeReference: {
    kind: 'edge' as const,
    producingFeatureId: 'feat_block' as FeatureId,
    lineageName: 'edge.a',
    currentHash: 1,
    witnessVersion: 1 as const,
    witness: {
      curveType: 'LINE',
      length: 1,
      closed: false as const,
      endpoints: [
        [0, 0, 0],
        [1, 0, 0]
      ] as [[number, number, number], [number, number, number]],
      midpoint: [0, 0, 0] as [number, number, number]
    }
  }
};
source.edgeReference.currentHash = edgeTopologyWitnessHash(source.edgeReference.witness);

function document(broken: boolean): ProjectDocument {
  const sketched = addSketchFeature(
    createProjectDocument('Objects', toUserId('user_objects')),
    {
      name: 'Outline',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'line',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 0,
          projection: { mode: 'linked', source }
        },
        {
          objectKind: 'circle',
          centerX: 0,
          centerY: 0,
          radius: 1,
          projection: { mode: 'unlinked', source }
        }
      ]
    }
  );
  const [lineId] = findSketch(sketched.document, sketched.sketchId)!.objectIds;
  return {
    ...sketched.document,
    derived: {
      ...sketched.document.derived,
      sketchProjections: {
        [lineId!]: broken
          ? { status: 'broken', reason: 'its source edge was deleted.' }
          : { status: 'current' }
      }
    }
  };
}

function props(doc: ProjectDocument): PanelProps {
  return {
    features: listFeaturesInOrder(doc),
    representations: {},
    document: doc,
    parameterValues: {},
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
}

describe('Objects projection rows', () => {
  it('lists each projected entity with its role under its sketch', () => {
    render(<Harness {...props(document(false))} />);
    expect(screen.getByText('2 projected')).toBeInTheDocument();
    expect(
      screen.getByRole('listitem', { name: 'Projected line: Linked' })
    ).toHaveTextContent('linked');
    expect(
      screen.getByRole('listitem', {
        name: 'Projected circle: Independent copy'
      })
    ).toHaveTextContent('independent');
  });

  it('shows a deleted source as broken, on the entity and the sketch', () => {
    render(<Harness {...props(document(true))} />);
    expect(screen.getByText('broken projection')).toBeInTheDocument();
    const row = screen.getByRole('listitem', {
      name: 'Projected line: Linked · broken'
    });
    expect(row).toHaveAttribute(
      'title',
      'Linked · broken: its source edge was deleted.'
    );
    expect(row.querySelector('.feature-flag.error')).toHaveTextContent(
      'broken'
    );
  });
});
