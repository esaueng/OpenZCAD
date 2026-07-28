import { createReadStream } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PluginOption } from 'vite';
import wasm from 'vite-plugin-wasm';
import {
  PDFJS_ASSET_BASE,
  PDFJS_ASSET_DIRS
} from './src/lib/assistant/pdfjsAssets';

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

/**
 * Serves the pdf.js runtime data directories in dev and copies them into the
 * build. They are plain data, not importable modules, so pdf.js is given a URL
 * prefix instead — see `pdfjsAssets.ts` for why each one is needed.
 */
function pdfjsAssets(): PluginOption {
  const sourceRoot = fileURLToPath(
    new URL('./node_modules/pdfjs-dist/', import.meta.url)
  );
  let outDir = 'dist';
  return {
    name: 'openzcad-pdfjs-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // Dev: serve straight from node_modules instead of copying on every boot.
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(PDFJS_ASSET_BASE)) {
          next();
          return;
        }
        const relative = url.slice(PDFJS_ASSET_BASE.length).split('?')[0] ?? '';
        // Anything outside the three known directories, or containing a
        // traversal segment, would expose the workspace over the dev server.
        if (
          !PDFJS_ASSET_DIRS.some((dir) => relative.startsWith(`${dir}/`)) ||
          relative.split('/').includes('..')
        ) {
          next();
          return;
        }
        const stream = createReadStream(`${sourceRoot}${relative}`);
        stream.on('error', () => next());
        stream.on('open', () =>
          response.setHeader('content-type', 'application/octet-stream')
        );
        stream.pipe(response);
      });
    },
    // Copied into the build output rather than into `public/`, so a build never
    // leaves 4 MB of vendored data behind in the source tree.
    async writeBundle() {
      const target = join(outDir, PDFJS_ASSET_BASE.replace(/^\/|\/$/g, ''));
      await mkdir(target, { recursive: true });
      for (const dir of PDFJS_ASSET_DIRS) {
        await cp(`${sourceRoot}${dir}`, join(target, dir), {
          recursive: true
        });
      }
    }
  };
}

export default defineConfig(async ({ command, isPreview }) => {
  const plugins = [];
  const react = (await import('@vitejs/plugin-react')).default;
  plugins.push(react(), wasm(), pdfjsAssets());

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
