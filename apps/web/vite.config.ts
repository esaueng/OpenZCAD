import { fileURLToPath } from 'node:url';
import { defineConfig, type PluginOption } from 'vite';
import wasm from 'vite-plugin-wasm';

if (typeof globalThis.File === 'undefined') {
  // Node 18 lacks the global File constructor that some dependencies expect.
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

const WORKSPACE_PACKAGES = [
  'shared',
  'geometry',
  'document-core',
  'command-system',
  'kernel-adapter',
  'ai-contracts',
  'viewport',
  'io-step',
  'io-stl',
  'jobs',
  'cloudflare-adapters',
  'persistence'
] as const;

const workspaceAliases = Object.fromEntries(
  WORKSPACE_PACKAGES.map((name) => [
    `@openzcad/${name}`,
    fileURLToPath(
      new URL(`../../packages/${name}/src/index.ts`, import.meta.url)
    )
  ])
);

export default defineConfig(async ({ command, isPreview }) => {
  const plugins = [];
  const react = (await import('@vitejs/plugin-react')).default;
  plugins.push(react(), wasm());

  const nodeMajor = Number.parseInt(
    process.versions.node.split('.')[0] ?? '0',
    10
  );
  // `vite preview` also reports command === 'serve', but the Cloudflare
  // plugin expects build output it did not produce; load it for dev only.
  const isDevServer = command === 'serve' && !isPreview;
  if (isDevServer && nodeMajor >= 20) {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare());
  } else if (isDevServer) {
    console.warn(
      `OpenZCAD beta: skipping @cloudflare/vite-plugin because Node ${process.versions.node} is below the plugin's expected runtime.`
    );
  }

  return {
    plugins,
    optimizeDeps: {
      // The exact CAD kernel ships as WebAssembly and must remain a runtime asset.
      exclude: ['brepkit-wasm']
    },
    worker: {
      format: 'es' as const,
      // The plugin supports several Vite majors, so narrow its cross-version
      // return type to the Vite version used by this workspace.
      plugins: (): PluginOption[] => [wasm() as PluginOption]
    },
    resolve: {
      alias: {
        '@openzcad/kernel-adapter/exact': fileURLToPath(
          new URL('../../packages/kernel-adapter/src/exact.ts', import.meta.url)
        ),
        ...workspaceAliases
      }
    },
    build: {
      target: 'esnext',
      rollupOptions: {
        output: {
          // Rolldown accepts functional chunk routing. three.js dominates the
          // bundle, so isolate it for better caching without relying on the
          // object form supported by Rollup-only Vite releases.
          manualChunks: (id: string) =>
            id.includes('/node_modules/three/') ? 'three' : undefined
        }
      }
    }
  };
});
