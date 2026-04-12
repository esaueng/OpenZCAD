import { createMockKernelAdapter } from '@openzcad/kernel-adapter';
import type { ProjectDocument } from '@openzcad/shared';

const kernel = createMockKernelAdapter();

self.onmessage = (event: MessageEvent<ProjectDocument>) => {
  const document = event.data;
  const derived = kernel.syncDocument(document);
  self.postMessage(derived);
};

export {};

