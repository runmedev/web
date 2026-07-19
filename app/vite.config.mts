import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";

const backendProxyTarget =
  process.env.VITE_BACKEND_PROXY_TARGET ??
  process.env.CUJ_BACKEND_URL ??
  "http://127.0.0.1:9977";
const LOCAL_SERVICE_ACCOUNT_KEY_ENDPOINT =
  "/__runme-dev/service-account-key";
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

function localServiceAccountKeyPlugin() {
  return {
    name: "runme-local-service-account-key",
    configureServer(server) {
      server.middlewares.use(
        LOCAL_SERVICE_ACCOUNT_KEY_ENDPOINT,
        async (req, res) => {
          try {
            const requestUrl = new URL(
              req.url ?? "",
              "http://localhost",
            );
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
              }),
            );
          } catch (error) {
            res.statusCode = 500;
            res.end(`Failed to read service account key: ${String(error)}`);
          }
        },
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

          const bytes = await readFile(rawPath);
          if (bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) {
            res.statusCode = 413;
            res.end("Local image file is too large.");
            return;
          }

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

// https://vite.dev/config/
export default defineConfig({
  // Use root-relative assets so LB rewrites to /index.html still load bundles from /.
  base: "/",
  cacheDir: ".vite",
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
      output: {
        manualChunks: undefined,
        // Use hash in file names for cache busting. This ensures that when the user clicks
        // refresh in the browser, if the server is serving a new version of the app the app
        // will be reloaded since the file names will be different.
        // This turns out to be much easier than trying to inject the git commit with bazel stamping.
        // Its also ensures reproducible builds.
        entryFileNames: `index.[hash].js`,
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
