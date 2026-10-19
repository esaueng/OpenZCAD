import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ImageExportDialog,
  type ImageExportDialogProps
} from './ImageExportDialog';

function renderDialog(overrides: Partial<ImageExportDialogProps> = {}) {
  const props: ImageExportDialogProps = {
    viewScopeLabel: 'visible bodies (2)',
    viewSize: { width: 1200, height: 800 },
    maxSide: 8192,
    sketches: [
      { sketchId: 'sketch_a', name: 'Base outline' },
      { sketchId: 'sketch_b', name: 'Slot' }
    ],
    units: 'mm',
    onClose: vi.fn(),
    onExportPng: vi.fn(),
    onExportSvg: vi.fn(),
    ...overrides
  };
  render(<ImageExportDialog {...props} />);
  return props;
}

describe('ImageExportDialog', () => {
  it('exports the view at its own size by default, opaque with the grid', async () => {
    const props = renderDialog();
    expect(screen.getByText(/Renders visible bodies \(2\)/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^View/ }).getAttribute('aria-pressed')
    ).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: /Export PNG/ }));
    expect(props.onExportPng).toHaveBeenCalledWith({
      width: 1200,
      height: 800,
      transparent: false,
      showGrid: true
    });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('takes a preset or typed size and a transparent background', async () => {
    const props = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /3840 × 2160/ }));
    expect(screen.getByLabelText<HTMLInputElement>('Width (px)').value).toBe(
      '3840'
    );
    await userEvent.click(screen.getByLabelText('Transparent background'));
    await userEvent.click(screen.getByLabelText('Include the grid and axes'));
    const height = screen.getByLabelText('Height (px)');
    await userEvent.clear(height);
    await userEvent.type(height, '3000');
    expect(screen.getByText(/widens the frame/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Export PNG/ }));
    expect(props.onExportPng).toHaveBeenCalledWith({
      width: 3840,
      height: 3000,
      transparent: true,
      showGrid: false
    });
  });

  it('refuses a size the device cannot render', async () => {
    const props = renderDialog({ maxSide: 4096 });
    const width = screen.getByLabelText('Width (px)');
    await userEvent.clear(width);
    await userEvent.type(width, '5000');
    expect(screen.getByRole('alert').textContent).toMatch(/16 to 4096/);
    const exportButton = screen.getByRole('button', { name: /Export PNG/ });
    expect((exportButton as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(exportButton);
    expect(props.onExportPng).not.toHaveBeenCalled();
  });

  it('exports the chosen sketch as SVG, starting from the active one', async () => {
    const props = renderDialog({ initialSketchId: 'sketch_b', units: 'inch' });
    await userEvent.click(screen.getByRole('radio', { name: 'SVG' }));
    expect(screen.getByText(/at 1:1 in inches/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Sketch').value).toBe(
      'sketch_b'
    );
    await userEvent.selectOptions(screen.getByLabelText('Sketch'), 'sketch_a');
    await userEvent.click(screen.getByLabelText('Transparent background'));
    await userEvent.click(screen.getByRole('button', { name: /Export SVG/ }));
    expect(props.onExportSvg).toHaveBeenCalledWith({
      sketchId: 'sketch_a',
      transparent: true
    });
    expect(props.onExportPng).not.toHaveBeenCalled();
  });

  it('offers SVG only when the project has a sketch', () => {
    renderDialog({ sketches: [] });
    const svg = screen.getByRole<HTMLInputElement>('radio', { name: 'SVG' });
    expect(svg.disabled).toBe(true);
    expect(screen.getByText(/this project has none/)).toBeTruthy();
  });

  it('opens on SVG while the model updates, and holds the PNG until it settles', async () => {
    const props = renderDialog({
      pngUnavailable: 'Wait for the model to finish updating.'
    });
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'SVG' }).checked
    ).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'PNG' }));
    expect(screen.getByRole('alert').textContent).toMatch(/finish updating/);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: /Export PNG/ })
        .disabled
    ).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalled();
  });
});
