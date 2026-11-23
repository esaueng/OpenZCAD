import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UnitsConversionPreparation } from '@openzcad/kernel-adapter/exact';
import {
  ConvertUnitsDialog,
  type ConvertUnitsDialogProps,
  type PreparedConversion
} from './ConvertUnitsDialog';

function prepared(
  overrides: {
    report?: Partial<PreparedConversion['report']>;
    undo?: Partial<PreparedConversion['undo']>;
  } = {}
): PreparedConversion {
  return {
    ok: true,
    sourceVersion: 7,
    payload: { from: 'mm', to: 'inch', factor: [5, 127], references: {} },
    report: {
      from: 'mm',
      to: 'inch',
      factor: [5, 127],
      scaledNumbers: 10,
      wrapped: [
        {
          subject: 'Extrude 1',
          field: 'distance',
          before: 'depth * 2',
          after: '(depth * 2) / 25.4'
        }
      ],
      unwrapped: [],
      numerals: [
        { subject: 'Box 1', field: 'width', before: '25.4', after: '1' }
      ],
      unchangedExpressions: 0,
      configurationRows: 0,
      displayUnits: 'none',
      meshPayloads: 0,
      warnings: [
        {
          code: 'rounding-of-length-ratio',
          subject: 'Pattern 1',
          field: 'count',
          expression: 'round(width / 5 mm)',
          operation: 'round',
          message: 'A later edit could change how many copies this makes.'
        }
      ],
      oracleChecks: 12,
      ...overrides.report
    },
    references: {} as PreparedConversion['references'],
    undo: {
      entryBytes: 1000,
      historyBytes: 1200,
      limitBytes: 8_000_000,
      exceedsLimit: false,
      stepsDropped: 0,
      keepsOnlyConversion: false,
      ...overrides.undo
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderDialog(props: Partial<ConvertUnitsDialogProps> = {}) {
  const handlers = {
    prepare: vi.fn<ConvertUnitsDialogProps['prepare']>(() =>
      Promise.resolve<UnitsConversionPreparation>(prepared())
    ),
    convert: vi.fn<ConvertUnitsDialogProps['convert']>(() =>
      Promise.resolve({ ok: true as const, message: 'Converted.' })
    ),
    convertCopy: vi.fn<NonNullable<ConvertUnitsDialogProps['convertCopy']>>(
      () => Promise.resolve({ ok: true as const, message: 'Copy converted.' })
    ),
    onClose: vi.fn()
  };
  render(
    <ConvertUnitsDialog stored="mm" shown="mm" {...handlers} {...props} />
  );
  return { ...handlers, ...props };
}

describe('ConvertUnitsDialog', () => {
  it('offers the other two stored units and points to Units for display', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Convert stored units' });
    expect(dialog).toHaveAccessibleDescription(
      /To only see lengths in another unit, use Units in the File menu instead/
    );
    expect(screen.getByRole('radio', { name: 'Inches (in)' })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: 'Centimeters (cm)' })
    ).toBeVisible();
    expect(screen.queryByRole('radio', { name: /Millimeters/ })).toBeNull();
    await screen.findByText('12 stored values will change.');
  });

  it('shows progress while the check runs', () => {
    const check = deferred<UnitsConversionPreparation>();
    renderDialog({ prepare: vi.fn(() => check.promise) });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking the conversion to inches…'
    );
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Convert a copy' })
    ).toBeDisabled();
  });

  it('summarises a ready conversion: counts, rewritten expressions, warnings and display units', async () => {
    const user = userEvent.setup();
    const { prepare } = renderDialog();
    expect(prepare).toHaveBeenCalledWith('inch', expect.any(AbortSignal));
    const summary = await screen.findByRole('status', {
      name: 'What converting changes'
    });
    expect(summary).toHaveTextContent('12 stored values will change.');
    expect(summary).toHaveTextContent(
      '“Before unit conversion (mm → in)” is saved first.'
    );
    expect(summary).toHaveTextContent(
      'Lengths will be shown in inches, the new stored unit.'
    );
    await user.click(
      screen.getByText('1 expression rewritten to keep its size')
    );
    expect(screen.getByText('(depth * 2) / 25.4')).toBeVisible();
    expect(screen.getByText('Extrude 1 · distance')).toBeVisible();
    expect(summary).toHaveTextContent('Check after converting (1)');
    expect(summary).toHaveTextContent('Pattern 1 · count');
    expect(summary).toHaveTextContent('round(width / 5 mm)');
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeEnabled();
  });

  it('keeps a third shown unit and says so', async () => {
    renderDialog({
      shown: 'cm',
      prepare: vi.fn(() =>
        Promise.resolve(prepared({ report: { displayUnits: 'kept' } }))
      )
    });
    expect(
      await screen.findByText(
        'Lengths stay shown in centimeters, as chosen under Units.'
      )
    ).toBeVisible();
  });

  it('warns when earlier undo steps will be lost', async () => {
    renderDialog({
      prepare: vi.fn(() =>
        Promise.resolve(
          prepared({ undo: { keepsOnlyConversion: true, stepsDropped: 4 } })
        )
      )
    });
    expect(await screen.findByRole('note')).toHaveTextContent(
      'earlier undo steps will be lost. The safety checkpoint still lets you go back.'
    );
  });

  it('lists every refusal with the feature and field, and cannot convert', async () => {
    renderDialog({
      prepare: vi.fn(() =>
        Promise.resolve<UnitsConversionPreparation>({
          ok: false,
          sourceVersion: 7,
          refusals: [
            {
              stage: 'transform',
              code: 'scale-variant',
              subject: 'Extrude 1',
              field: 'distance',
              message: 'round(width) would round in a different unit.'
            },
            {
              stage: 'transform',
              code: 'custom-feature',
              subject: 'Gear script',
              message: 'Custom-feature scripts cannot be converted.'
            }
          ],
          warnings: []
        })
      )
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Stored units cannot be converted to inches'
    );
    const items = within(alert).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(
      'Extrude 1 · distanceround(width) would round in a different unit.'
    );
    expect(items[1]).toHaveTextContent('Gear script');
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('checks again after the project changed (stale)', async () => {
    const user = userEvent.setup();
    const { prepare, convert } = renderDialog({
      convert: vi.fn(() =>
        Promise.resolve({
          ok: false as const,
          refusals: [
            {
              stage: 'payload' as const,
              code: 'stale',
              subject: 'document',
              message:
                'The project changed after the conversion was checked. Check it again.'
            }
          ]
        })
      )
    });
    await user.click(await screen.findByRole('button', { name: 'Convert' }));
    expect(convert).toHaveBeenCalledTimes(1);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The project changed');
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole('button', { name: 'Convert' })
    ).toBeEnabled();
  });

  it('keeps the review open with the reason when converting is refused', async () => {
    const user = userEvent.setup();
    renderDialog({
      convert: vi.fn(() =>
        Promise.resolve({
          ok: false as const,
          refusals: [
            {
              stage: 'collaboration' as const,
              code: 'other-editors',
              subject: 'document',
              message: 'Sam has this project open.'
            }
          ]
        })
      )
    });
    await user.click(await screen.findByRole('button', { name: 'Convert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sam has this project open.'
    );
    // The check still stands: the same conversion can be tried again.
    expect(screen.getByRole('button', { name: 'Convert' })).toBeEnabled();
  });

  it('converts in place and reports success', async () => {
    const user = userEvent.setup();
    const convertDone = deferred<{ ok: true; message: string }>();
    const { convert, onClose } = renderDialog({
      convert: vi.fn(() => convertDone.promise)
    });
    await user.click(await screen.findByRole('button', { name: 'Convert' }));
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, sourceVersion: 7 })
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saving “Before unit conversion (mm → in)”, then converting…'
    );
    // Escape does not abandon a conversion under way.
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      convertDone.resolve({
        ok: true,
        message:
          'Converted stored units to inches. “Before unit conversion (mm → in)” was saved first: restore it to go back.'
      });
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      '“Before unit conversion (mm → in)” was saved first'
    );
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('converts a copy with its own progress', async () => {
    const user = userEvent.setup();
    const { convertCopy } = renderDialog();
    await user.click(
      await screen.findByRole('button', { name: 'Convert a copy' })
    );
    expect(convertCopy).toHaveBeenCalledWith('inch', expect.any(Function));
    expect(await screen.findByText('Copy converted.')).toBeVisible();
  });

  it('re-checks when the target unit changes, cancelling the earlier check', async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const prepare = vi.fn((_: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<UnitsConversionPreparation>(() => {});
    });
    renderDialog({ prepare });
    await user.click(screen.getByRole('radio', { name: 'Centimeters (cm)' }));
    expect(prepare).toHaveBeenLastCalledWith('cm', expect.any(AbortSignal));
    expect(signals[0]!.aborted).toBe(true);
  });

  it('says why it cannot start while others are editing, and runs nothing', async () => {
    const user = userEvent.setup();
    const { prepare, onClose } = renderDialog({
      blockedReason: 'Sam has this project open.'
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Sam has this project open.'
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
