import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/ - App build configuration
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/app',
    emptyOutDir: false,
    chunkSizeWarningLimit: 999999,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Group Monaco Editor into its own chunk
          if (id.includes('monaco-editor')) {
            return 'monaco'
          }
          // Group React and related libraries
          if (id.includes('react') || id.includes('react-dom')) {
            return 'react'
          }
          // Group Radix UI components
          if (id.includes('@radix-ui')) {
            return 'radix'
          }
          // Group Tailwind CSS
          if (id.includes('tailwindcss') || id.includes('@tailwindcss')) {
            return 'tailwind'
          }
          // Group other dependencies
          if (id.includes('node_modules')) {
            return 'vendor'
          }
          // Everything else goes to main
          return 'main'
        },
        entryFileNames: `index.js`,
        chunkFileNames: `[name].js`,
        assetFileNames: `[name].[ext]`,
      },
    },
  },
})
