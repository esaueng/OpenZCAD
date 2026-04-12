import { defineConfig } from 'vite';

if (typeof globalThis.File === 'undefined') {
  class NodeFile extends Blob {
    name: string;
    lastModified: number;

    constructor(bits: BlobPart[], name: string, options?: FilePropertyBag) {
      super(bits, options);
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
  }

  Object.assign(globalThis, { File: NodeFile });
}

export default defineConfig(async ({ command }) => {
  const plugins = [];
  const react = (await import('@vitejs/plugin-react')).default;
  plugins.push(react());

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (command === 'serve' && nodeMajor >= 20) {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare());
  } else if (command === 'serve') {
    console.warn(
      `OpenZCAD beta: skipping @cloudflare/vite-plugin because Node ${process.versions.node} is below the plugin's expected runtime.`
    );
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@openzcad/shared': '/../../packages/shared/src/index.ts',
        '@openzcad/document-core': '/../../packages/document-core/src/index.ts',
        '@openzcad/command-system': '/../../packages/command-system/src/index.ts',
        '@openzcad/kernel-adapter': '/../../packages/kernel-adapter/src/index.ts',
        '@openzcad/viewport': '/../../packages/viewport/src/index.ts',
        '@openzcad/io-step': '/../../packages/io-step/src/index.ts',
        '@openzcad/io-stl': '/../../packages/io-stl/src/index.ts',
        '@openzcad/jobs': '/../../packages/jobs/src/index.ts',
        '@openzcad/cloudflare-adapters': '/../../packages/cloudflare-adapters/src/index.ts',
        '@openzcad/persistence': '/../../packages/persistence/src/index.ts'
      }
    }
  };
});
