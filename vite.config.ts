import { defineConfig } from 'vite'

export default defineConfig({
  // SillyTavern serves extensions from a nested path, not the site root.
  base: './',
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'style',
    },
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        banner: '/*! Tavern Map prototype — includes MapLibre GL JS (BSD-3-Clause). See NOTICE.md. */',
        assetFileNames: (asset) => {
          const name = asset.names?.[0] ?? ''
          if (name.endsWith('.css')) return 'style.css'
          // Keep the MapLibre worker next to index.js with a .js extension so
          // every static server serves it with a JavaScript MIME type.
          if (name.endsWith('.mjs')) return 'maplibre-gl-worker.js'
          return 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
})
