import { defineConfig } from 'vite';

/**
 * Visionneuse PDF isolée : script classique autonome (IIFE). Un module ES serait chargé en mode
 * CORS depuis l'origine opaque de l'iframe ; un script classique ne l'est pas.
 */
export default defineConfig({
  // Les fichiers de public/ (dont viewer/pdf.html) sont copiés par la construction principale.
  publicDir: false,
  build: {
    outDir: 'dist/viewer',
    emptyOutDir: false,
    sourcemap: false,
    target: 'es2022',
    lib: {
      entry: 'src/viewer/pdf-viewer.ts',
      formats: ['iife'],
      name: 'PlumePdfViewer',
      fileName: () => 'pdf-viewer.js',
    },
  },
});
