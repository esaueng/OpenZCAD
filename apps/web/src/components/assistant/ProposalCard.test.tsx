import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CadPatchOperation } from '@openzcad/ai-contracts';
import { toFeatureId } from '@openzcad/shared';
import type { AssistantProposalEntry } from '../../lib/assistant/conversation';
import { ProposalCard } from './ProposalCard';

function entry(
  operations: CadPatchOperation[],
  readings: AssistantProposalEntry['readings'] = []
): AssistantProposalEntry {
  return {
    kind: 'proposal',
    id: 'proposal',
    status: 'open',
    readings,
    proposal: {
      proposalId: 'proposal',
      summary: 'Change the plate.',
      assumptions: [],
      operations
    }
  };
}

function renderCard(value: AssistantProposalEntry) {
  return render(
    <ProposalCard
      entry={value}
      previewing={false}
      busy={false}
      onPreview={vi.fn()}
      onApply={vi.fn()}
      onReject={vi.fn()}
    />
  );
}

const plate: CadPatchOperation = {
  kind: 'add_primitive',
  name: 'Plate',
  localId: null,
  primitiveKind: 'box',
  dimensions: {
    width: 80,
    height: 60,
    depth: 6,
    radius: null,
    bottomRadius: null,
    topRadius: null,
    majorRadius: null,
    minorRadius: null
  }
};

describe('the operation list', () => {
  it('lists a short patch under its summary while it waits', () => {
    renderCard(entry([plate, { ...plate, name: 'Rib' }]));
    expect(screen.getByRole('button', { name: /operations/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps a long patch behind the disclosure', () => {
    renderCard(
      entry(
        Array.from({ length: 7 }, (_, index) => ({
          ...plate,
          name: `Plate ${index}`
        }))
      )
    );
    expect(screen.getByRole('button', { name: /operations/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('keeps a decided patch behind the disclosure', () => {
    renderCard({ ...entry([plate]), status: 'applied' });
    expect(screen.getByText('Applied')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});

describe('the operation totals', () => {
  it('separates the count from the totals and pluralises each', () => {
    renderCard(
      entry([
        { kind: 'set_parameter', name: 'w', expression: '80' },
        { kind: 'set_parameter', name: 'h', expression: '60' },
        plate
      ])
    );
    const disclosure = screen.getByRole('button', { name: /operations/ });
    expect(disclosure.textContent).toBe('3 operations · 2 params · 1 solid');
  });

  it('starts the totals the same way when there are no parameters', () => {
    renderCard(
      entry([
        { kind: 'delete_feature', featureId: toFeatureId('feat_1') },
        { kind: 'delete_feature', featureId: toFeatureId('feat_2') }
      ])
    );
    expect(screen.getByRole('button', { name: /operations/ }).textContent).toBe(
      '2 operations · 2 edits'
    );
  });
});

describe('the reading table', () => {
  it('keeps a value and its confidence apart for a screen reader', () => {
    renderCard(
      entry(
        [plate],
        [
          {
            label: 'Width',
            value: '80 mm',
            source: 'front view',
            confidence: 'read'
          }
        ]
      )
    );
    expect(screen.getByRole('cell', { name: '80 mm read' })).toBeTruthy();
  });
});
