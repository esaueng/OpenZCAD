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
  readonly OZ_PERF?: string;
  readonly OZ_BUILD_COMMIT: string;
  readonly OZ_BREPKIT_VERSION: string;
  readonly OZ_BREPKIT_COMMIT: string;
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
