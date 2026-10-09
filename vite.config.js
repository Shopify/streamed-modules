import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import streamedModules from './plugin/streamed-modules.js';

// baseline | streamed | declarations
const MODE = process.env.BUILD_MODE || (process.env.STREAMED ? 'streamed' : 'baseline');
const SEPARABLE = MODE !== 'baseline';

export default defineConfig({
  plugins: [
    react(),
    streamedModules({
      mode: MODE,
      title: 'Streamed Modules',
      // INSTRUMENT=0 drops the per-module epilogue (no first/last-module marks).
      instrument: process.env.INSTRUMENT !== '0',
    }),
  ],

  // No HTML entry: the plugin emits the HTML for both modes so the two pages
  // differ only in how the JavaScript is delivered.
  build: {
    outDir: `dist/${MODE}`,
    emptyOutDir: true,
    target: 'esnext',
    minify: process.env.MINIFY ? 'esbuild' : false, // MINIFY=1 for a production-shaped build
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 0,
    reportCompressedSize: false,
    rollupOptions: {
      input: 'src/main.jsx',
      // Vite defaults this to false for app builds, which preserveModules
      // rejects.
      preserveEntrySignatures: SEPARABLE ? 'strict' : false,
      output: {
        format: 'es',
        // The whole point: keep one chunk per input module, with real
        // import/export statements between them, instead of flattening the
        // graph into a single scope.
        preserveModules: SEPARABLE,
        // Stable, boring filenames - the plugin replaces them with specifiers
        // anyway, and it keeps the build diffable.
        entryFileNames: SEPARABLE ? 'm/[name].js' : 'app.js',
        chunkFileNames: SEPARABLE ? 'm/[name].js' : 'app-[name].js',
        assetFileNames: 'assets/[name][extname]',
        hoistTransitiveImports: false,
        freeze: false,
        externalLiveBindings: false,
        generatedCode: {constBindings: true},
      },
    },
  },

  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
