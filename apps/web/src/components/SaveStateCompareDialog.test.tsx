import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SaveStateDiff } from '@openzcad/document-core';
import {
  SaveStateCompareDialog,
  describeSaveStateDiff
} from './SaveStateCompareDialog';

const none = { added: [], removed: [], changed: [] };

function diff(overrides: Partial<SaveStateDiff> = {}): SaveStateDiff {
  return {
    features: { ...none, reordered: false },
    sketches: none,
    bodies: none,
    parameters: [],
    drawingSheets: none,
    properties: [],
    identical: true,
    ...overrides
  };
}

describe('describeSaveStateDiff', () => {
  it('words each change and leaves out empty sections', () => {
    expect(
      describeSaveStateDiff(
        diff({
          identical: false,
          features: {
            added: [{ id: 'f1', name: 'Pin' }],
            removed: [{ id: 'f2', name: 'Lug' }],
            changed: [
              { id: 'f3', name: 'Plate', changes: ['renamed from “Base”'] }
            ],
            reordered: true
          },
          parameters: [
            { name: 'width', before: '20', after: '35' },
            { name: 'height', before: null, after: '4' },
            { name: 'depth', before: '10', after: null }
          ],
          properties: [{ field: 'units', before: 'mm', after: 'inch' }]
        })
      )
    ).toEqual([
      { heading: 'Project', lines: ['Units: mm → inch'] },
      {
        heading: 'Features',
        lines: [
          'Added “Pin”',
          'Removed “Lug”',
          '“Plate”: renamed from “Base”',
          'History order changed'
        ]
      },
      {
        heading: 'Parameters',
        lines: ['width: 20 → 35', 'Added height = 4', 'Removed depth (was 10)']
      }
    ]);
  });
});

describe('describeSaveStateDiff: a stored-unit conversion (I03)', () => {
  it('summarises the conversion in one row, not a row per value', () => {
    expect(
      describeSaveStateDiff(
        diff({
          identical: false,
          unitConversion: { from: 'mm', to: 'inch', values: 42 }
        })
      )
    ).toEqual([
      {
        heading: 'Project',
        lines: ['Converted stored units mm → in (42 values)']
      }
    ]);
    expect(
      describeSaveStateDiff(
        diff({
          identical: false,
          unitConversion: { from: 'inch', to: 'cm', values: 1 }
        })
      )[0]!.lines
    ).toEqual(['Converted stored units in → cm (1 value)']);
  });
});

describe('SaveStateCompareDialog', () => {
  it('compares with the project now, then with another save', async () => {
    const user = userEvent.setup();
    const compare = vi.fn(async (againstId: string) =>
      againstId === 'current'
        ? diff({
            identical: false,
            parameters: [{ name: 'width', before: '20', after: '35' }]
          })
        : diff()
    );
    const onClose = vi.fn();
    render(
      <SaveStateCompareDialog
        label="Before fillets"
        options={[
          { id: 'current', label: 'The project now' },
          { id: 'checkpoint_b', label: 'Manual save' }
        ]}
        compare={compare}
        onClose={onClose}
      />
    );
    expect(
      screen.getByRole('dialog', { name: 'Compare “Before fillets”' })
    ).toBeVisible();
    expect(
      await screen.findByRole('region', { name: 'Parameters' })
    ).toHaveTextContent('width: 20 → 35');
    await user.selectOptions(screen.getByRole('combobox'), 'checkpoint_b');
    expect(await screen.findByText('No changes to the model.')).toBeVisible();
    expect(compare).toHaveBeenLastCalledWith('checkpoint_b');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('says so when a save cannot be opened', async () => {
    render(
      <SaveStateCompareDialog
        label="Old"
        options={[{ id: 'current', label: 'The project now' }]}
        compare={() => Promise.reject(new Error('“Old” is no longer stored.'))}
        onClose={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        '“Old” is no longer stored.'
      )
    );
  });
});
