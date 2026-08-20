import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MeshQualityReport } from '@openzcad/kernel-adapter/exact';
import { toBodyId } from '@openzcad/shared';
import {
  ExportDialog,
  type ExportDialogProps,
  type ExportProgress,
  type MeshExportDialogFormat
} from './ExportDialog';

function renderDialog(overrides: Partial<ExportDialogProps> = {}) {
  const props: ExportDialogProps = {
    scopeLabel: 'all bodies (2)',
    bodies: [
      { bodyId: 'body_a', name: 'Base' },
      { bodyId: 'body_b', name: 'Boss' }
    ],
    onClose: vi.fn(),
    onExport: vi.fn(async () => undefined),
    onCheckQuality: vi.fn(
      async (): Promise<MeshQualityReport> => ({
        watertight: true,
        bodies: [
          {
            bodyId: toBodyId('body_a'),
            boundaryEdges: 0,
            nonManifoldEdges: 0,
            watertight: true
          },
          {
            bodyId: toBodyId('body_b'),
            boundaryEdges: 3,
            nonManifoldEdges: 1,
            watertight: false
          }
        ]
      })
    ),
    ...overrides
  };
  render(<ExportDialog {...props} />);
  return props;
}

/**
 * The options argument every onExport call now carries. Its shape is
 * asserted behaviourally by the progress and cancel tests below.
 */
function exportOptions() {
  return expect.anything() as unknown;
}

describe('ExportDialog', () => {
  it('exports 3MF at the standard preset by default', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));

    await waitFor(() => expect(props.onExport).toHaveBeenCalledOnce());
    expect(props.onExport).toHaveBeenCalledWith('3mf', 0.08, exportOptions());
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('sends the chosen format and preset deflection', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('radio', { name: /STL \(binary\)/ }));
    await user.click(screen.getByRole('button', { name: /Fine/ }));
    await user.click(screen.getByRole('button', { name: /Export STL/ }));

    await waitFor(() =>
      expect(props.onExport).toHaveBeenCalledWith('stl-binary', 0.02, exportOptions())
    );
  });

  it('offers OBJ and glTF formats', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('radio', { name: /glTF \(GLB\)/ }));
    await user.click(screen.getByRole('button', { name: /Export glTF/ }));

    await waitFor(() => expect(props.onExport).toHaveBeenCalledWith('glb', 0.08, exportOptions()));
    expect(screen.queryByRole('radio', { name: /OBJ/ })).not.toBeNull();
  });

  it('blocks export while a custom deviation is out of range', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    const input = screen.getByLabelText(/Max chord deviation/);
    await user.clear(input);
    await user.type(input, '7');

    expect(screen.getByRole('alert')).toHaveTextContent(/between 0.001 and 1/);
    expect(screen.getByRole('button', { name: /Export 3MF/ })).toBeDisabled();

    await user.clear(input);
    await user.type(input, '0.5');
    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));
    await waitFor(() =>
      expect(props.onExport).toHaveBeenCalledWith('3mf', 0.5, exportOptions())
    );
  });

  it('names each body in the printability report', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );

    await waitFor(() =>
      expect(props.onCheckQuality).toHaveBeenCalledWith(
        0.08,
        exportOptions()
      )
    );
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(screen.getByText('Boss')).toBeInTheDocument();
    expect(
      screen.getByText(/3 open, 1 non-manifold edge/)
    ).toBeInTheDocument();
  });

  it('marks a report stale when the quality changes and shows export errors', async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      onExport: vi.fn(async () => {
        throw new Error('The export failed downstream.');
      })
    });

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    await waitFor(() => expect(props.onCheckQuality).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: /Draft/ }));
    expect(screen.getByText(/re-check to see the new verdict/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The export failed downstream.'
      )
    );
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('narrates export progress reported by the host', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    renderDialog({
      onExport: vi.fn(
        async (
          _format: MeshExportDialogFormat,
          _deflection: number,
          options: {
            signal: AbortSignal;
            onProgress(progress: ExportProgress): void;
          }
        ) => {
          options.onProgress('loading-kernel');
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
      )
    });

    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Loading the geometry kernel…'
    );
    finish();
  });

  it('aborts a running export from the cancel button without showing an error', async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      onExport: vi.fn(
        (
          _format: MeshExportDialogFormat,
          _deflection: number,
          options: {
            signal: AbortSignal;
            onProgress(progress: ExportProgress): void;
          }
        ) =>
          new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              const cancelled = new Error('Export cancelled.');
              cancelled.name = 'AbortError';
              reject(cancelled);
            });
          })
      )
    });

    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));
    const cancel = await screen.findByRole('button', {
      name: 'Cancel export'
    });
    await user.click(cancel);

    expect(props.onClose).toHaveBeenCalledOnce();
    const call = vi.mocked(props.onExport).mock.calls[0]!;
    expect(call[2].signal.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
