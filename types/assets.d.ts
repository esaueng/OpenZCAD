declare module '*.wasm?url' {
  const url: string;
  export default url;
}

/** Vite's `?url` suffix, for handing a library the URL of a bundled asset. */
declare module '*.mjs?url' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  readonly VITE_E2E?: string;
  readonly OZ_PERF?: string;
  readonly OZ_BUILD_COMMIT: string;
  readonly OZ_REMUS_VERSION: string;
  readonly OZ_REMUS_COMMIT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Vite's `?worker` suffix: a bundler-built worker constructor. Used to give
 * pdf.js a live worker port instead of a URL it has to instantiate itself.
 */
declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
