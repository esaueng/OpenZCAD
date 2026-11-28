/** The caller's authenticated MLS anchors; all byte strings are base64url. */
export interface E2eeProjectAuthorityRecord {
  sequence: number;
  accountKeyGeneration: number;
  accountKeySequence: number;
  signerDeviceId: string;
  record: string;
  recordMac: string;
  signature: string;
}
export interface E2eeProjectAuthorityResponse {
  authority: E2eeProjectAuthorityRecord | null;
}
export interface E2eeSaveProjectAuthorityRequest extends E2eeProjectAuthorityRecord {
  expectedSequence: number;
  /**
   * The owner's confirmed restoration of a record the account no longer
   * returns (issue #1704): stored only while the account holds no record
   * for the project, at the sequence after the one the device pinned. An
   * older server ignores the field and answers 409 `E2EE_AUTHORITY_CONFLICT`.
   */
  restoreMissing?: true;
}
