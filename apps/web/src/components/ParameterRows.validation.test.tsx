import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import {
  createProjectDocument,
  listParameters,
  setParameter
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { ParameterRow } from './ParameterRows';
const parameter = () =>
  listParameters(
    setParameter(createProjectDocument('Test', toUserId('local')), {
      name: 'holder_height',
      expression: '58'
    })
  )[0]!;
it('shows pending validation, explains refusal, and restores the committed value', async () => {
  const user = userEvent.setup();
  let finish!: (message: string) => void;
  const onSet = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  render(
    <ParameterRow
      parameter={parameter()}
      value={58}
      minimum={56.910504}
      onSet={onSet}
    />
  );
  expect(screen.getByText('Minimum 56.910504')).toBeTruthy();
  const input = screen.getByLabelText('Expression for holder_height');
  await user.clear(input);
  await user.type(input, '55{Enter}');
  expect(screen.getByText('Checking geometry…')).toBeTruthy();
  finish('holder_height must be at least 56.910504 mm.');
  await waitFor(() => expect(input).toHaveValue('58'));
  expect(screen.getByRole('alert')).toHaveTextContent('No change applied');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  await user.clear(input);
  await user.type(input, '60');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('does not overwrite a newer draft when an older validation finishes', async () => {
  const user = userEvent.setup();
  let finish!: (message: string) => void;
  render(
    <ParameterRow
      parameter={parameter()}
      value={58}
      onSet={() =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
      }
    />
  );
  const input = screen.getByLabelText('Expression for holder_height');
  await user.clear(input);
  await user.type(input, '55{Enter}');
  await user.clear(input);
  await user.type(input, '62');
  finish('Old refusal');
  await waitFor(() => expect(input).toHaveValue('62'));
  expect(screen.queryByRole('alert')).toBeNull();
});
