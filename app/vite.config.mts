import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
    headers: {
      // Set these if when we enable webcontainers
      //"Cross-Origin-Opener-Policy": "same-origin",
      //"Cross-Origin-Embedder-Policy": "require-corp",
      //"Cross-Origin-Embedder-Policy": "credentialless",
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
