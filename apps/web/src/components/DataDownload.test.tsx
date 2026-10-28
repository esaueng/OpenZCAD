import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS, toUserId } from '@openzcad/shared';
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
    .mockResolvedValue({
      includedProjects: 1,
      skippedProjects: [],
      omittedSections: []
    });
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

it('shows every excluded project, its copy, ID and reason after a partial download', async () => {
  vi.spyOn(exporter, 'downloadAllData').mockResolvedValue({
    includedProjects: 0,
    skippedProjects: [
      {
        projectId: 'local_failed',
        name: 'Local part',
        scope: 'local',
        reason: 'Missing source file.'
      },
      {
        projectId: 'cloud_failed',
        name: 'Cloud part',
        scope: 'cloud',
        reason: 'Would exceed the 512 MB archive.'
      }
    ],
    omittedSections: [
      { name: 'Raw device database snapshot', reason: 'Not enough space.' }
    ]
  });
  render(
    <DataDownload
      settings={DEFAULT_APP_SETTINGS}
      session={null}
      cloudFunctionsEnabled={false}
      busy={false}
    />
  );
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Download all data' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      '0 project backups included; 2 skipped'
    )
  );
  const list = screen.getByRole('list', {
    name: 'Project backups not included'
  });
  expect(list).toHaveTextContent('Local part');
  expect(list).toHaveTextContent('Local copy · local_failed');
  expect(list).toHaveTextContent('Missing source file.');
  expect(list).toHaveTextContent('Cloud part');
  expect(list).toHaveTextContent('Cloud copy · cloud_failed');
  expect(list).toHaveTextContent('512 MB');
  expect(
    screen.getByRole('list', { name: 'Other data not included' })
  ).toHaveTextContent('Raw device database snapshot');
  expect(screen.getByText(/File → Export project/)).toBeVisible();
  expect(screen.getByText(/NOT-INCLUDED.txt/)).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('hides a completed omissions list when the account changes, including when switching back', async () => {
  vi.spyOn(exporter, 'downloadAllData').mockResolvedValue({
    includedProjects: 0,
    skippedProjects: [
      {
        projectId: 'private_project',
        name: 'Private part',
        scope: 'cloud',
        reason: 'Locked.'
      }
    ],
    omittedSections: []
  });
  const props = {
    settings: DEFAULT_APP_SETTINGS,
    session: {
      userId: toUserId('first_owner'),
      displayName: 'First owner',
      mode: 'development' as const
    },
    cloudFunctionsEnabled: true,
    busy: false
  };
  const view = render(<DataDownload {...props} />);
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Download all data' }));
  expect(await screen.findByText('Private part')).toBeVisible();
  view.rerender(<DataDownload {...props} session={null} />);
  expect(screen.queryByText('Private part')).not.toBeInTheDocument();
  view.rerender(<DataDownload {...props} />);
  expect(screen.queryByText('Private part')).not.toBeInTheDocument();
});
