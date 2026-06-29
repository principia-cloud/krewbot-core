import { cpSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const dcvSdkDir = path.resolve(
  __dirname,
  'node_modules/bedrock-agentcore/dist/src/tools/browser/live-view/nice-dcv-web-client-sdk',
);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'copy-dcv-sdk',
      writeBundle() {
        for (const dest of ['dist/nice-dcv-web-client-sdk', 'dist/browser-live/nice-dcv-web-client-sdk']) {
          cpSync(`${dcvSdkDir}/dcvjs-esm`, `${dest}/dcvjs-esm`, { recursive: true });
          cpSync(`${dcvSdkDir}/dcv-ui`, `${dest}/dcv-ui`, { recursive: true });
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      dcv: path.resolve(dcvSdkDir, 'dcvjs-esm/dcv.js'),
      'dcv-ui': path.resolve(dcvSdkDir, 'dcv-ui/dcv-ui.js'),
    },
    dedupe: [
      'react',
      'react-dom',
      'prop-types',
      '@cloudscape-design/components',
      '@cloudscape-design/global-styles',
      '@cloudscape-design/design-tokens',
      '@babel/runtime',
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router'],
          'radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-radio-group',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-separator',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
          ],
        },
      },
    },
  },
});
