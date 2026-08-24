import {
  DEFAULT_SHAPR_IMPORT_LIMITS,
  parseShaprProject,
  type ShaprImportIR
} from '@openzcad/io-shapr';
import { sanitizeStepHeaderPrivacy } from '@openzcad/io-step';

const MAX_COMPANION_STEP_BYTES = 128 * 1024 * 1024;

export type ShaprImportWorkerRequest = {
  type: 'parse';
  requestId: string;
  shaprFile: File;
  stepFile: File;
};

export type ShaprImportWorkerResult =
  | { type: 'progress'; requestId: string; message: string }
  | {
      type: 'result';
      requestId: string;
      ok: true;
      ir: ShaprImportIR;
      stepChecksumSha256: string;
      sanitizedStepBytes: ArrayBuffer;
    }
  | {
      type: 'result';
      requestId: string;
      ok: false;
      error: string;
    };

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

self.onmessage = async (event: MessageEvent<ShaprImportWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'parse') {
    return;
  }
  const post = (result: ShaprImportWorkerResult) => self.postMessage(result);
  try {
    if (request.shaprFile.size > DEFAULT_SHAPR_IMPORT_LIMITS.maxArchiveBytes) {
      throw new Error('SHAPR archive exceeds the 32 MB import limit.');
    }
    if (request.stepFile.size > MAX_COMPANION_STEP_BYTES) {
      throw new Error('Companion STEP exceeds the 128 MB import limit.');
    }
    post({
      type: 'progress',
      requestId: request.requestId,
      message: 'Reading the Shapr3D project…'
    });
    const shaprBytes = await request.shaprFile.arrayBuffer();
    post({
      type: 'progress',
      requestId: request.requestId,
      message: 'Inspecting the bounded workspace database…'
    });
    const ir = await parseShaprProject(shaprBytes);
    post({
      type: 'progress',
      requestId: request.requestId,
      message: 'Privacy-sanitizing and hashing the companion STEP…'
    });
    const stepBytes = await request.stepFile.arrayBuffer();
    const stepText = new TextDecoder('utf-8', { fatal: true }).decode(
      stepBytes
    );
    const sanitizedStepBytes = new TextEncoder().encode(
      sanitizeStepHeaderPrivacy(stepText, request.stepFile.name)
    );
    const stepDigest = await crypto.subtle.digest(
      'SHA-256',
      sanitizedStepBytes
    );
    const result: ShaprImportWorkerResult = {
      type: 'result',
      requestId: request.requestId,
      ok: true,
      ir,
      stepChecksumSha256: hex(stepDigest),
      sanitizedStepBytes: sanitizedStepBytes.buffer
    };
    self.postMessage(result, { transfer: [sanitizedStepBytes.buffer] });
  } catch (error) {
    post({
      type: 'result',
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
