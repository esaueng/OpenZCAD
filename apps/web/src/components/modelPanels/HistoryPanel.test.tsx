import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type {
  BodyRepresentation,
  FeatureId,
  FeatureNode,
  ProjectDocument
} from '@openzcad/shared';
import {
  HistoryFindToggle,
  HistoryPanel,
  HistoryRepairChip,
  historyCount,
  useHistoryRepair
} from './HistoryPanel';
import { useHistoryFind } from './panelViews';

function feature(index: number): FeatureNode {
  return {
    id: `node-${index}`,
    kind: 'feature',
    name: `Feature ${index}`,
    featureId: `feature-${index}` as FeatureId,
    featureKind: 'extrude',
    data: { featureKind: 'extrude' }
  } as unknown as FeatureNode;
}

function Harness({
  features = [feature(1), feature(2)],
  representations = {},
  ...overrides
}: Partial<Omit<ComponentProps<typeof HistoryPanel>, 'find' | 'repair'>>) {
  const find = useHistoryFind();
  const [selected, setSelected] = useState<string | null>(null);
  const repair = useHistoryRepair({
    features,
    representations,
    failedFeatureIds: overrides.failedFeatureIds,
    geometryPending: overrides.geometryPending,
    document: overrides.document
  });
  const select = (id: string) => {
    overrides.onSelectFeature?.(id);
    setSelected((current) => (current === id ? null : id));
  };
  return (
    <>
      <HistoryRepairChip
        repair={repair}
        selectedFeatureNodeId={selected}
        onSelectFeature={select}
      />
      <HistoryFindToggle find={find} />
      <HistoryPanel
        features={features}
        representations={representations}
        selectedFeatureNodeId={selected}
        hiddenBodyIds={new Set()}
        hiddenSketchIds={new Set()}
        parameterValues={{}}
        units="mm"
        onToggleBodyVisibility={vi.fn()}
        onToggleSketchVisibility={vi.fn()}
        onFeatureContextMenu={vi.fn()}
        onToggleFeatureSuppression={vi.fn()}
        onRollbackAfterFeature={vi.fn()}
        onResumeHistory={vi.fn()}
        onReorderFeature={vi.fn()}
        {...overrides}
        onSelectFeature={select}
        find={find}
        repair={repair}
      />
    </>
  );
}

describe('HistoryPanel', () => {
  it('lists the timeline with the details below it', () => {
    render(<Harness historyDetails={<p>Selected step details</p>} />);
    expect(screen.getByText('Feature 1')).toBeInTheDocument();
    expect(screen.getByText('Feature 2')).toBeInTheDocument();
    expect(screen.getByText('Selected step details')).toBeInTheDocument();
  });

  it('opens Find from the header toggle and hands focus back on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'Find a step' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'Find a step' })
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox', { name: 'Find a step' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('counts features', () => {
    expect(historyCount([])).toBe(0);
    expect(historyCount([feature(1), feature(2), feature(3)])).toBe(3);
  });

  describe('repair chip', () => {
    /**
     * Block → Fillet → Chamfer → Last on one body, and Other → Other chamfer
     * on another. Every body is built, so only the reported failures fail.
     */
    function history() {
      let document: ProjectDocument = addPrimitiveFeature(
        createProjectDocument('Repair chip', toUserId('user_chip')),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        }
      );
      let body = document.bodyOrder.at(-1)!;
      for (const name of ['Fillet', 'Chamfer', 'Last']) {
        const modify = name === 'Fillet' ? filletEdges : chamferEdges;
        ({ document, bodyId: body } = modify(document, {
          name,
          targetBodyId: body,
          edgeHashes: [1],
          size: 1
        }));
      }
      document = addPrimitiveFeature(document, {
        name: 'Other',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 5, depth: 5 }
      });
      ({ document } = chamferEdges(document, {
        name: 'Other chamfer',
        targetBodyId: document.bodyOrder.at(-1)!,
        edgeHashes: [1],
        size: 1
      }));
      const features = listFeaturesInOrder(document);
      const representations = Object.fromEntries(
        features
          .filter((node) => node.bodyId)
          .map((node) => [node.bodyId!, {} as BodyRepresentation])
      );
      const id = (name: string) =>
        features.find((node) => node.name === name)!.featureId;
      return { document, features, representations, id };
    }

    it('is absent while nothing needs repair', () => {
      const { document, features, representations } = history();
      render(
        <Harness
          document={document}
          features={features}
          representations={representations}
          failedFeatureIds={new Set()}
        />
      );
      expect(
        screen.queryByRole('button', { name: /need(s)? repair/ })
      ).toBeNull();
    });

    it('counts the failed steps, names those built on them, and visits first failures first', async () => {
      const user = userEvent.setup();
      const { document, features, representations, id } = history();
      const onSelectFeature = vi.fn<(nodeId: string) => void>();
      render(
        <Harness
          document={document}
          features={features}
          representations={representations}
          // Other chamfer fails on its own branch: a first failure too.
          failedFeatureIds={
            new Set([id('Chamfer'), id('Fillet'), id('Other chamfer')])
          }
          onSelectFeature={onSelectFeature}
        />
      );
      const chip = screen.getByRole('button', {
        name: '3 steps need repair. Show Fillet'
      });
      // Last built, on Fillet's input: named, not counted.
      expect(chip).toHaveAttribute(
        'title',
        '3 steps need repair. 1 later step built on a failed step. Show Fillet.'
      );
      expect(chip).toHaveTextContent('3need repair');
      const node = (name: string) =>
        features.find((feature) => feature.name === name)!.id;
      await user.click(chip);
      // Fillet and Other chamfer are first failures; Chamfer failed after
      // Fillet, so it comes last although it is earlier in the history.
      await user.click(
        screen.getByRole('button', { name: /^3 steps need repair\. Show/ })
      );
      await user.click(
        screen.getByRole('button', { name: /^3 steps need repair\. Show/ })
      );
      expect(onSelectFeature.mock.calls.map(([nodeId]) => nodeId)).toEqual([
        node('Fillet'),
        node('Other chamfer'),
        node('Chamfer')
      ]);
      // And wraps.
      expect(
        screen.getByRole('button', { name: '3 steps need repair. Show Fillet' })
      ).toBeInTheDocument();
    });

    it('says nothing is broken while geometry is pending', () => {
      const { document, features, representations, id } = history();
      render(
        <Harness
          document={document}
          features={features}
          representations={representations}
          failedFeatureIds={new Set([id('Fillet')])}
          geometryPending
        />
      );
      expect(
        screen.queryByRole('button', { name: /need(s)? repair/ })
      ).toBeNull();
    });

    it('clears a find filter that hides the step it shows', async () => {
      const user = userEvent.setup();
      const { document, features, representations, id } = history();
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
        (callback) => {
          frames.push(callback);
          return frames.length;
        }
      );
      render(
        <Harness
          document={document}
          features={features}
          representations={representations}
          failedFeatureIds={new Set([id('Fillet')])}
        />
      );
      await user.click(screen.getByRole('button', { name: 'Find a step' }));
      await user.type(
        screen.getByRole('searchbox', { name: 'Find a step' }),
        'Other'
      );
      expect(screen.queryByText('Fillet')).toBeNull();
      await user.click(
        screen.getByRole('button', { name: '1 step needs repair. Show Fillet' })
      );
      expect(
        screen.queryByRole('searchbox', { name: 'Find a step' })
      ).toBeNull();
      expect(screen.getByText('Fillet')).toBeInTheDocument();
      const scroll = vi.fn();
      (
        screen.getByText('Fillet').closest('.feature-row') as HTMLElement
      ).scrollIntoView = scroll;
      act(() => frames.splice(0).forEach((frame) => frame(0)));
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      vi.restoreAllMocks();
    });
  });
});
