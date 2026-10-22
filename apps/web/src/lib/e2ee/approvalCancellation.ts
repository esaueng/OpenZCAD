import { E2eeApiError, type E2eeApi } from './e2eeApi';

/** An idempotent cancellation acknowledgement alone does not prove removal. */
export async function confirmApprovalCancellation(
  api: E2eeApi,
  approvalId: string,
  requireCurrent: () => void = () => {}
): Promise<void> {
  await api.cancelApproval(approvalId);
  requireCurrent();
  let unavailable = false;
  try {
    await api.getApproval(approvalId);
  } catch (error) {
    if (!(error instanceof E2eeApiError) || error.status !== 404) throw error;
    unavailable = true;
  }
  requireCurrent();
  if (!unavailable)
    throw new Error('Device approval could not be canceled. Try again.');
}
