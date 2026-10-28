import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@openzcad/shared';
import { DataDownload } from './DataDownload';
import * as exporter from '../lib/dataExport';

afterEach(() => vi.restoreAllMocks());

it('announces progress, prevents double downloads, reports failure and retries', async () => {
  let fail: (error: Error) => void = () => {};
  const download = vi
    .spyOn(exporter, 'downloadAllData')
    .mockImplementationOnce(async (options) => {
      options.onProgress('Preparing cloud project 1 of 2…');
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    })
    .mockResolvedValue(undefined);
  render(
    <DataDownload
      settings={DEFAULT_APP_SETTINGS}
      session={null}
      cloudFunctionsEnabled={false}
      busy={false}
    />
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Download all data' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      'Preparing cloud project 1 of 2'
    )
  );
  expect(screen.getByRole('button')).toBeDisabled();
  fail(new Error('Unlock your encrypted projects.'));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Unlock your encrypted projects.'
  );
  await user.click(screen.getByRole('button', { name: 'Download all data' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('download is ready')
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(download).toHaveBeenCalledTimes(2);
});
