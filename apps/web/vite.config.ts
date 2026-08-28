import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { defineConfig, type PluginOption } from 'vite';
import wasm from 'vite-plugin-wasm';
import {
  PDFJS_ASSET_BASE,
  PDFJS_ASSET_DIRS
} from './src/lib/assistant/pdfjsAssets';
import { resolveSourceCommit } from './build/sourceCommit';
import {
  FONT_ASSET_BASE,
  FONT_FAMILIES
} from '../../packages/geometry/src/text/registry';

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
  'io-shapr',
  'io-stl',
  'jobs',
  'cloudflare-adapters',
  'persistence'
] as const;

const workspaceAliases = {
  '@openzcad/ai-contracts/auto-parameterize': fileURLToPath(
    new URL(
      '../../packages/ai-contracts/src/auto-parameterize.ts',
      import.meta.url
    )
  ),
  ...Object.fromEntries(
    WORKSPACE_PACKAGES.map((name) => [
      `@openzcad/${name}`,
      fileURLToPath(
        new URL(`../../packages/${name}/src/index.ts`, import.meta.url)
      )
    ])
  )
};

async function remusBuildInfo(): Promise<{
  version: string;
  commit: string;
}> {
  const [packageText, lockfile] = await Promise.all([
    readFile(
      fileURLToPath(
        new URL(
          '../../packages/kernel-adapter/node_modules/remus-wasm/package.json',
          import.meta.url
        )
      ),
      'utf8'
    ),
    readFile(
      fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url)),
      'utf8'
    )
  ]);
  const packageJson = JSON.parse(packageText) as { version?: unknown };
  const commit = lockfile.match(
    /https:\/\/codeload\.github\.com\/esaueng\/remus\/tar\.gz\/([0-9a-f]{40})#path:\/crates\/wasm\/pkg/
  )?.[1];
  if (typeof packageJson.version !== 'string' || !commit) {
    throw new Error('Unable to resolve the pinned Remus build identity.');
  }
  return { version: packageJson.version, commit };
}

function sourceCommit(): string {
  return resolveSourceCommit(process.env, () => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        encoding: 'utf8'
      });
    } catch {
      return null;
    }
  });
}

function buildMetadata(
  commit: string,
  remus: { version: string; commit: string }
): PluginOption {
  return {
    name: 'openzcad-build-metadata',
    generateBundle(_options, bundle) {
      const assets = Object.values(bundle)
        .map((entry) => entry.fileName)
        .filter((fileName) => /\.(?:css|js|mjs|wasm)$/.test(fileName))
        .sort();
      this.emitFile({
        type: 'asset',
        fileName: 'build-meta.json',
        source: `${JSON.stringify(
          {
            format: 'openzcad-build-metadata',
            formatVersion: 2,
            commit,
            remus,
            assets
          },
          null,
          2
        )}\n`
      });
    }
  };
}

/**
 * Serves the pdf.js runtime data directories in dev and copies them into the
 * build. They are plain data, not importable modules, so pdf.js is given a URL
 * prefix instead — see `pdfjsAssets.ts` for why each one is needed.
 */
/**
 * Serves the bundled text fonts at `FONT_ASSET_BASE` (`/fonts/`).
 *
 * The faces live in `packages/geometry/assets/fonts` because that is where the
 * registry and the golden tests read them from. The browser needs them over
 * HTTP, and copying 21 files into `public/` would vendor them into the source
 * tree twice. Same shape as `pdfjsAssets` above: stream from source in dev,
 * copy into the build output on write.
 */
function textFontAssets(): PluginOption {
  const sourceRoot = fileURLToPath(
    new URL('../../packages/geometry/assets/fonts/', import.meta.url)
  );
  let outDir = 'dist';
  return {
    name: 'openzcad-text-font-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(FONT_ASSET_BASE)) {
          next();
          return;
        }
        const relative = url.slice(FONT_ASSET_BASE.length).split('?')[0] ?? '';
        // Only the flat asset directory, and never a traversal out of it.
        if (!/^[\w.-]+\.(?:ttf|otf)$/.test(relative)) {
          next();
          return;
        }
        const stream = createReadStream(`${sourceRoot}${relative}`);
        stream.on('error', () => next());
        stream.on('open', () => response.setHeader('content-type', 'font/ttf'));
        stream.pipe(response);
      });
    },
    async writeBundle() {
      const target = join(outDir, FONT_ASSET_BASE.replace(/^\/|\/$/g, ''));
      await mkdir(target, { recursive: true });
      // Only the faces themselves; the licence texts and manifest beside them
      // are for the repo, not the wire.
      for (const family of FONT_FAMILIES) {
        for (const face of family.faces) {
          await cp(`${sourceRoot}${face.file}`, join(target, face.file));
        }
      }
    }
  };
}

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

export default defineConfig(async ({ command, isPreview, mode }) => {
  const remus = await remusBuildInfo();
  const commit = sourceCommit();
  const isDesktop = mode === 'desktop';
  const plugins = [];
  const react = (await import('@vitejs/plugin-react')).default;
  plugins.push(
    react(),
    wasm(),
    pdfjsAssets(),
    textFontAssets(),
    buildMetadata(commit, remus)
  );

  const nodeMajor = Number.parseInt(
    process.versions.node.split('.')[0] ?? '0',
    10
  );
  // `vite preview` also reports command === 'serve', but the Cloudflare
  // plugin expects build output it did not produce; load it for dev only.
  // The bundled desktop app talks to native commands and its configured
  // hosted API, not an embedded Workers runtime. Keeping Miniflare out of this
  // mode also makes the Tauri dev server deterministic and self-contained.
  const isDevServer = command === 'serve' && !isPreview && !isDesktop;
  if (isDevServer && nodeMajor >= 20) {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare());
  } else if (isDevServer) {
    console.warn(
      `OpenZCAD beta: skipping @cloudflare/vite-plugin because Node ${process.versions.node} is below the plugin's expected runtime.`
    );
  }

  return {
    // Tauri serves the production bundle from its own asset protocol. Relative
    // URLs keep workers, WASM, fonts, and pdf.js data inside that bundle.
    base: isDesktop ? './' : '/',
    plugins,
    define: {
      'import.meta.env.VITE_E2E': JSON.stringify(process.env.VITE_E2E ?? ''),
      'import.meta.env.OZ_DESKTOP': JSON.stringify(isDesktop),
      'import.meta.env.OZ_PERF': JSON.stringify(process.env.OZ_PERF ?? ''),
      'import.meta.env.OZ_BUILD_COMMIT': JSON.stringify(commit),
      'import.meta.env.OZ_REMUS_VERSION': JSON.stringify(remus.version),
      'import.meta.env.OZ_REMUS_COMMIT': JSON.stringify(remus.commit)
    },
    optimizeDeps: {
      // The exact CAD kernel ships as WebAssembly and must remain a runtime asset.
      exclude: ['remus-wasm', '@sqlite.org/sqlite-wasm']
    },
    worker: {
      format: 'es' as const,
      // The plugin supports several Vite majors, so narrow its cross-version
      // return type to the Vite version used by this workspace.
      plugins: (): PluginOption[] => [wasm() as PluginOption]
    },
    resolve: {
      alias: {
        // Imported dynamically so opentype.js lands in its own chunk instead
        // of the entry bundle. Reaching it through the geometry index would
        // not split — that index is statically imported all over the app.
        '@openzcad/geometry/text-loader': fileURLToPath(
          new URL('../../packages/geometry/src/text/loader.ts', import.meta.url)
        ),
        '@openzcad/kernel-adapter/exact': fileURLToPath(
          new URL('../../packages/kernel-adapter/src/exact.ts', import.meta.url)
        ),
        '@openzcad/kernel-adapter/face-attachment': fileURLToPath(
          new URL(
            '../../packages/kernel-adapter/src/face-attachment.ts',
            import.meta.url
          )
        ),
        '@openzcad/viewport/move-transform': fileURLToPath(
          new URL(
            '../../packages/viewport/src/gizmo/moveTransform.ts',
            import.meta.url
          )
        ),
        '@openzcad/viewport/input-bindings': fileURLToPath(
          new URL(
            '../../packages/viewport/src/input/bindings.ts',
            import.meta.url
          )
        ),
        '@openzcad/viewport/types': fileURLToPath(
          new URL('../../packages/viewport/src/types.ts', import.meta.url)
        ),
        // Same reason as the text loader above: the io-shapr index pulls the
        // zip reader, SQLite-WASM and the MessagePack decoder, and the module
        // that wants this one pure string helper is in the entry chunk.
        '@openzcad/io-shapr/truncate': fileURLToPath(
          new URL('../../packages/io-shapr/src/truncate.ts', import.meta.url)
        ),
        ...workspaceAliases
      }
    },
    build: {
      outDir: isDesktop ? 'dist-desktop' : 'dist',
      target: isDesktop ? 'safari17' : 'esnext',
      rollupOptions: {
        output: {
          // Rolldown accepts functional chunk routing. three.js dominates the
          // bundle, so isolate it for better caching without relying on the
          // object form supported by Rollup-only Vite releases.
          manualChunks: (id: string) => {
            if (id.includes('/node_modules/three/examples/')) {
              return 'three-addons';
            }
            if (id.includes('/node_modules/three/')) {
              return 'three';
            }
            if (
              id.includes('/node_modules/react/') ||
              id.includes('/node_modules/react-dom/') ||
              id.includes('/node_modules/scheduler/')
            ) {
              return 'react';
            }
            if (id.includes('/node_modules/lucide-react/')) {
              return 'icons';
            }
            // The document model is shared by the eager workspace, the lazy
            // Assistant, and exact-preview modules. Give that deliberate
            // first-paint dependency a stable name so it is not mistaken for
            // an app-code `src-*` leak by the bundle gate. The command layer
            // and AI contracts ride along: they are the same eager-workspace /
            // lazy-Assistant dependency (command-system imports ai-contracts,
            // so routing one without the other would strand a shared anonymous
            // chunk in first paint), and keeping them here keeps the launcher
            // `index-*` chunk clear of the document machinery entirely.
            if (
              id.includes('/packages/shared/') ||
              id.includes('/packages/document-core/') ||
              id.includes('/packages/command-system/') ||
              id.includes('/packages/ai-contracts/')
            ) {
              return 'model';
            }
            // Sketch geometry, shared by the eager workspace and by lazily
            // loaded features. Without a name it becomes an anonymous `src-*`
            // chunk, which `report-bundle-sizes` rejects when the launcher
            // preloads it — the pattern exists to catch app code leaking into
            // first paint, and an unnamed chunk makes that impossible to tell
            // apart from a deliberate shared dependency. This one is
            // deliberate: Build mode needs it immediately.
            if (id.includes('/packages/geometry/')) {
              return 'geometry';
            }
            return undefined;
          }
        }
      }
    }
  };
});
