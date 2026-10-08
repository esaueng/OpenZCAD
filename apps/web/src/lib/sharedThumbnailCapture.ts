import { createThumbnailCapture } from './projectThumbnailCapture';

/** Resident before staging, so leave-time flush never waits for a chunk. */
export const sharedThumbnailCapture = createThumbnailCapture();
