import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'

export function createSharedConfig({ entry, name, fileName }) {
  return defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        react: path.resolve('./node_modules/react'),
        'react-dom': path.resolve('./node_modules/react-dom'),
        'react-router-dom': path.resolve('./node_modules/react-router-dom'),
        'react-router': path.resolve('./node_modules/react-router'),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      lib: {
        entry,
        name,
        formats: ['es', 'cjs'],
        fileName,
      },
      rollupOptions: {
        external: [
          '@buf/bufbuild_protovalidate.bufbuild_es',
          '@buf/googleapis_googleapis.bufbuild_es',
          '@bufbuild/protobuf',
          '@bufbuild/protobuf/codegenv1',
          '@bufbuild/protobuf/wkt',
          'react',
          'react-dom',
          'react/jsx-runtime',
          '@radix-ui/react-dropdown-menu',
          '@radix-ui/react-icons',
          '@radix-ui/themes',
          '@monaco-editor/react',
          'react-markdown',
          'react-router',
          'react-router-dom',
        ],
        output: {
          globals: {
            react: 'React',
            'react-dom': 'ReactDOM',
            'react/jsx-runtime': 'React',
          },
        },
      },
    },
  })
}
