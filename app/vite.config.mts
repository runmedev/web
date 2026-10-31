import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";

import { localExcalidraw } from "./build/localExcalidraw";

const require = createRequire(import.meta.url);

const backendProxyTarget =
  process.env.VITE_BACKEND_PROXY_TARGET ??
  process.env.CUJ_BACKEND_URL ??
  "http://127.0.0.1:9977";
const LOCAL_SERVICE_ACCOUNT_KEY_ENDPOINT = "/__runme-dev/service-account-key";
const LOCAL_IMAGE_ENDPOINT = "/__runme-dev/local-image";
const MAX_LOCAL_KEY_BYTES = 1024 * 1024;
const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const PWA_PRECACHE_TOKEN = "__RUNME_PRECACHE_URLS__";
const PWA_BUILD_TOKEN = "__RUNME_BUILD_ID__";
const PWA_PUBLIC_ASSET_FILES = [
  "manifest.webmanifest",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "configs/app-configs.yaml",
];
const PWA_CORE_ASSETS = [
  "/index.html",
  ...PWA_PUBLIC_ASSET_FILES.map((fileName) => `/${fileName}`),
];

function resolveWebCommit(): string | undefined {
  const configured = process.env.VITE_RUNME_VERSION_WEB_COMMIT?.trim();
  if (configured) {
    return configured;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const releaseId = process.env.VITE_RUNME_RELEASE_ID;
if (releaseId && !/^[a-f0-9]{40}-[a-f0-9]{64}$/.test(releaseId)) throw new Error('Invalid release ID');
const assetBase = releaseId ? `/version/${releaseId}/` : '/';
const webCommit = resolveWebCommit();
const webRepository =
  process.env.VITE_RUNME_VERSION_WEB_REPO?.trim() || "runmedev/web";

function localServiceAccountKeyPlugin() {
  return {
    name: "runme-local-service-account-key",
    configureServer(server) {
      server.middlewares.use(
        LOCAL_SERVICE_ACCOUNT_KEY_ENDPOINT,
        async (req, res) => {
          try {
            const requestUrl = new URL(req.url ?? "", "http://localhost");
            const rawPath = requestUrl.searchParams.get("path") ?? "";
            if (!rawPath || !path.isAbsolute(rawPath)) {
              res.statusCode = 400;
              res.end("Expected absolute service account JSON path.");
              return;
            }
            if (path.extname(rawPath).toLowerCase() !== ".json") {
              res.statusCode = 400;
              res.end("Service account key path must end in .json.");
              return;
            }

            const text = await readFile(rawPath, "utf8");
            if (Buffer.byteLength(text, "utf8") > MAX_LOCAL_KEY_BYTES) {
              res.statusCode = 413;
              res.end("Service account key file is too large.");
              return;
            }
            JSON.parse(text);

            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                name: path.basename(rawPath),
                path: rawPath,
                text,
              })
            );
          } catch (error) {
            res.statusCode = 500;
            res.end(`Failed to read service account key: ${String(error)}`);
          }
        }
      );
    },
  };
}

function localImagePlugin() {
  return {
    name: "runme-local-image",
    configureServer(server) {
      server.middlewares.use(LOCAL_IMAGE_ENDPOINT, async (req, res) => {
        try {
          const requestUrl = new URL(req.url ?? "", "http://localhost");
          const rawPath = requestUrl.searchParams.get("path") ?? "";
          if (!rawPath || !path.isAbsolute(rawPath)) {
            res.statusCode = 400;
            res.end("Expected an absolute image path.");
            return;
          }

          const extension = path.extname(rawPath).toLowerCase();
          const mimeType = IMAGE_MIME_BY_EXTENSION.get(extension);
          if (!mimeType) {
            res.statusCode = 400;
            res.end("Local image path must use a supported image extension.");
            return;
          }

          const fileStats = await stat(rawPath);
          if (fileStats.size > MAX_LOCAL_IMAGE_BYTES) {
            res.statusCode = 413;
            res.end("Local image file is too large.");
            return;
          }
          const bytes = await readFile(rawPath);

          res.setHeader("Content-Type", mimeType);
          res.setHeader("Content-Length", String(bytes.byteLength));
          res.end(bytes);
        } catch (error) {
          res.statusCode = 500;
          res.end(`Failed to read local image: ${String(error)}`);
        }
      });
    },
  };
}

/**
 * Emits a service worker whose precache list matches the hashed assets from
 * this exact Vite build. Keeping generation in the build avoids a second PWA
 * dependency and prevents an offline page from referring to stale bundle
 * names after a deployment.
 */
function pwaServiceWorkerPlugin(): Plugin {
  return {
    name: "runme-pwa-service-worker",
    apply: "build",
    async generateBundle(_outputOptions, bundle) {
      if (releaseId) {
        const launcher = Object.values(bundle).find(output => output.type === 'chunk' && output.name === 'launcher');
        const entry = Object.values(bundle).find(output => output.type === 'chunk' && output.isEntry && output.name === 'app');
        if (!launcher || launcher.type !== 'chunk' || !entry || entry.type !== 'chunk') this.error('Missing release entries');
        const bootstrap = new Set<string>();
        const collect = (name: string) => {
          if (bootstrap.has(name)) return;
          bootstrap.add(name);
          const chunk = bundle[name];
          if (chunk?.type === 'chunk') chunk.imports.forEach(collect);
        };
        collect(launcher.fileName);
        const descriptor = { format: 1, protocol: 1, releaseId, entry: launcher.fileName,
          assets: [...bootstrap].map(name => {
            const chunk = bundle[name];
            if (chunk?.type !== 'chunk') throw new Error('Launcher dependency is not a module');
            return { path: name, sha256: createHash('sha256').update(chunk.code).digest('hex'), bytes: Buffer.byteLength(chunk.code) };
          }) };
        this.emitFile({ type: 'asset', fileName: 'launcher.json', source: JSON.stringify(descriptor) });
        const boot = Object.values(bundle).find(output => output.type === 'chunk' && output.name === 'bootstrap');
        if (!boot || boot.type !== 'chunk') this.error('Missing bootstrap entry');
        collect(boot.fileName);
        const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Runme</title><link rel="manifest" href="${assetBase}manifest.webmanifest"></head><body><div id="root"></div><script id="runme-launcher-fallback" type="application/json">${JSON.stringify(descriptor)}</script><script type="module" src="${assetBase}${boot.fileName}"></script></body></html>`;
        this.emitFile({ type: 'asset', fileName: 'launcher.html', source: shell });
        // Direct visits to an immutable index must also pass launcher admission.
        const html = bundle['index.html'];
        if (html?.type === 'asset') html.source = shell;
        this.emitFile({ type: 'asset', fileName: 'release-metadata.json', source: JSON.stringify({
          releaseId, appEntry: entry.fileName,
          styles: [...(entry.viteMetadata?.importedCss ?? [])],
          recoveredControlFormat: 1,
          tabRecoveryFormat: 1,
          tabAdmissionFormat: 1,
          storageControlFormat: 1,
          requiredCapabilities: ['durable-prepare-v1', 'epoch-fence-v1', 'owner-lock-v1'], testedRollbackTargets: [],
          owner: { buildId: releaseId.split('-')[1], entry: 'storage-owner.js', rpcMin: 8, rpcMax: 8 },
          launcherProtocol: { min: 1, max: 1 },
          storageCompatibilityId: 'runme-schema9-oplog2-payload1-console1',
        }) });
        const template = await readFile(new URL('./src/pwa/loader-worker.js', import.meta.url), 'utf8');
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: template
          .replace('__RUNME_LOADER_SHELL__', JSON.stringify(shell))
          .replace('__RUNME_LOADER_BOOTSTRAP__', JSON.stringify([...bootstrap].map(name => assetBase + name)))
          .replace('__RUNME_LOADER_CACHE__', `runme-loader-v1-${releaseId}`) });
        return;
      }
      const generatedAssets = Object.keys(bundle)
        .filter((fileName) => !fileName.endsWith(".map"))
        .map((fileName) => `/${fileName}`);
      const precacheUrls = [
        ...new Set([...PWA_CORE_ASSETS, ...generatedAssets]),
      ].sort();
      const buildHash = createHash("sha256").update(precacheUrls.join("\n"));
      for (const fileName of Object.keys(bundle).sort()) {
        const output = bundle[fileName];
        buildHash.update(fileName);
        buildHash.update(output.type === "asset" ? output.source : output.code);
      }
      for (const fileName of PWA_PUBLIC_ASSET_FILES) {
        buildHash.update(fileName);
        buildHash.update(
          await readFile(new URL(`./assets/${fileName}`, import.meta.url))
        );
      }
      const buildId = buildHash.digest("hex").slice(0, 12);
      const template = await readFile(
        new URL("./src/pwa/service-worker.js", import.meta.url),
        "utf8"
      );
      const source = template
        .replace(PWA_PRECACHE_TOKEN, JSON.stringify(precacheUrls, null, 2))
        .replace(PWA_BUILD_TOKEN, buildId);

      if (source === template || source.includes(PWA_PRECACHE_TOKEN)) {
        this.error(
          "PWA service worker template is missing its precache token."
        );
      }
      if (source.includes(PWA_BUILD_TOKEN)) {
        this.error("PWA service worker template is missing its build token.");
      }

      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source,
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // Use root-relative assets so LB rewrites to /index.html still load bundles from /.
  base: assetBase,
  cacheDir: ".vite",
  define: {
    "import.meta.env.VITE_RUNME_VERSION_WEB_REPO":
      JSON.stringify(webRepository),
    "import.meta.env.VITE_RUNME_VERSION_WEB_COMMIT": JSON.stringify(
      webCommit ?? ""
    ),
  },
  // The DOM conditional export in this parser dependency cannot run in workers.
  // Its portable entity table works in both tabs and SharedWorkers.
  resolve: {
    alias: {
      "decode-named-character-reference": require.resolve(
        "decode-named-character-reference"
      ),
    },
  },
  // A stable URL/name avoids a second owner after a page-bundle deployment.
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        // Runtime imports must not import the worker entry back without its
        // epoch query and execute the entry a second time.
        manualChunks: (id) => id.endsWith('/releases/control.ts') ? 'release-control' : undefined,
        entryFileNames: (chunk) =>
          chunk.name === "storageOwner.worker"
            ? "storage-owner.js"
            : "assets/[name]-[hash].js",
      },
    },
  },
  publicDir: "assets",
  optimizeDeps: {
    exclude: ["@runmedev/renderers"],
  },
  plugins: [
    react(),
    tailwindcss(),
    localServiceAccountKeyPlugin(),
    localImagePlugin(),
    svgr({
      // Copied options from UIKit
      svgrOptions: {
        // https://react-svgr.com/docs/options/#icon
        icon: true,
        ref: true,
      },
    }),
    localExcalidraw(),
    pwaServiceWorkerPlugin(),
  ],
  server: {
    proxy: {
      "/ws": {
        target: backendProxyTarget,
        changeOrigin: true,
        ws: true,
      },
      "/v1": {
        target: backendProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
    headers: {
      // Set these if when we enable webcontainers
      //"Cross-Origin-Opener-Policy": "same-origin",
      //"Cross-Origin-Embedder-Policy": "require-corp",
      //"Cross-Origin-Embedder-Policy": "credentialless",
    },
    watch: {
      // Avoid full page reloads when local notebook fixtures are auto-saved.
      // (These live under the Vite root so file writes would otherwise trigger
      // a reload on every keystroke.)
      ignored: ["**/test/fixtures/notebooks/**"],
    },
  },
  preview: {
    headers: {
      //"Cross-Origin-Opener-Policy": "same-origin",
      //"Cross-Origin-Embedder-Policy": "require-corp",
      //"Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  build: {
    chunkSizeWarningLimit: 999999,
    rollupOptions: {
      input: releaseId ? { app: path.resolve('index.html'), launcher: path.resolve('src/releases/launcher.ts'), bootstrap: path.resolve('src/releases/bootstrap.ts') } : undefined,
      output: {
        manualChunks: undefined,
        // Use hash in file names for cache busting. This ensures that when the user clicks
        // refresh in the browser, if the server is serving a new version of the app the app
        // will be reloaded since the file names will be different.
        // This turns out to be much easier than trying to inject the git commit with bazel stamping.
        // Its also ensures reproducible builds.
        entryFileNames: `[name].[hash].js`,
        chunkFileNames: `index.[hash].js`,
        assetFileNames: `[name].[hash].[ext]`,
      },
    },
  },
  test: {
    // Run a shared setup to stub browser globals (e.g., window) for Node env tests.
    setupFiles: ["./vitest.setup.ts"],
    environment: "jsdom",
  },
});
