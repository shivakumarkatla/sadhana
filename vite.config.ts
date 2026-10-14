import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Sādhana Devotional Companion',
        short_name: 'Sādhana',
        description: 'A quiet, local-first companion for devotional practice.',
        theme_color: '#fff7fb',
        background_color: '#fff7fb',
        display: 'standalone',
        icons: [
          { src: '/favicon.svg', sizes: '64x64', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: { exclude: ['lucide-react'] },
});
