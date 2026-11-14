import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          ort: ['onnxruntime-web'],
          vad: ['@ricky0123/vad-web'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
