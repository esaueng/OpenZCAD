import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ImportUnitsDialog } from './ImportUnitsDialog';

function renderDialog() {
  const onChoose = vi.fn();
  render(
    <ImportUnitsDialog
      fileName="bracket.stl"
      extent={[20, 10, 5]}
      documentUnits="mm"
      initialUnit="mm"
      onChoose={onChoose}
    />
  );
  return onChoose;
}

describe('ImportUnitsDialog', () => {
  it('asks how to read the file, showing the size each unit makes', () => {
    renderDialog();
    expect(
      screen.getByRole('dialog', { name: 'Units for bracket.stl' })
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Millimeters' })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: 'Inches' })
    ).toHaveAccessibleDescription('508 × 254 × 127 mm');
  });

  it('imports in the chosen unit, remembering it only when asked', async () => {
    const user = userEvent.setup();
    const onChoose = renderDialog();
    await user.click(screen.getByRole('radio', { name: 'Inches' }));
    await user.click(screen.getByRole('button', { name: 'Import in inches' }));
    expect(onChoose).toHaveBeenCalledWith({ units: 'inch', remember: false });

    onChoose.mockClear();
    await user.click(
      screen.getByRole('checkbox', { name: /Always read unitless files/ })
    );
    await user.click(screen.getByRole('button', { name: 'Import in inches' }));
    expect(onChoose).toHaveBeenCalledWith({ units: 'inch', remember: true });
  });

  it('cancels the import on Cancel or Escape', async () => {
    const user = userEvent.setup();
    const onChoose = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChoose).toHaveBeenLastCalledWith(null);
    await user.keyboard('{Escape}');
    expect(onChoose).toHaveBeenCalledTimes(2);
    expect(onChoose).toHaveBeenLastCalledWith(null);
  });
});
