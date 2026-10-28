export interface RestoreEnvironment {
  TARGET_BUCKET?: string;
  RESTORE_TOKEN?: string;
  TARGET: {
    put(
      key: string,
      body: ReadableStream<Uint8Array> | null,
      options: {
        onlyIf: { etagDoesNotMatch: string };
        httpMetadata: Record<string, unknown>;
        customMetadata: Record<string, string>;
      }
    ): Promise<object | null>;
  };
}
declare const worker: {
  fetch(request: Request, env: RestoreEnvironment): Promise<Response>;
};
export default worker;
