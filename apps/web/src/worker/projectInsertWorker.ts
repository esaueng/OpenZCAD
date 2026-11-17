import type { UserId } from '@openzcad/shared';

import {
  prepareProjectInsert,
  type PreparedProjectInsert
} from '../lib/projectInsertPrepare';

export type { PreparedProjectInsert } from '../lib/projectInsertPrepare';

export interface ProjectInsertWorkerRequest {
  type: 'insert';
  requestId: string;
  file: File;
  ownerUserId: UserId;
}

export type ProjectInsertWorkerResult =
  | {
      type: 'result';
      requestId: string;
      ok: true;
      prepared: PreparedProjectInsert;
    }
  | { type: 'result'; requestId: string; ok: false; error: string };

self.onmessage = async (event: MessageEvent<ProjectInsertWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'insert') return;
  let result: ProjectInsertWorkerResult;
  try {
    result = {
      type: 'result',
      requestId: request.requestId,
      ok: true,
      prepared: await prepareProjectInsert(request.file, request.ownerUserId)
    };
  } catch (error) {
    result = {
      type: 'result',
      requestId: request.requestId,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'The project could not be read.'
    };
  }
  self.postMessage(result);
};

export {};
