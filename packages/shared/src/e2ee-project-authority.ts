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
}
