declare module '*.wasm?url' {
  const url: string;
  export default url;
}

/** Vite's `?url` suffix, for handing a library the URL of a bundled asset. */
declare module '*.mjs?url' {
  const url: string;
  export default url;
}

/**
 * Vite's `?worker` suffix: a bundler-built worker constructor. Used to give
 * pdf.js a live worker port instead of a URL it has to instantiate itself.
 */
declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
