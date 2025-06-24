import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/ - App build configuration
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: 'dist/app',
    emptyOutDir: false,
    chunkSizeWarningLimit: 999999,
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: `index.js`,
        chunkFileNames: `index.js`,
        assetFileNames: `[name].[ext]`,
      },
    },
  },
})
