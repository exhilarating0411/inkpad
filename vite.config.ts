import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// base './' keeps every asset path relative, so the same build works on
// GitHub Pages (https://user.github.io/repo/) and on a local server.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // math fonts too, so formulas render offline
      workbox: { globPatterns: ['**/*.{js,css,html,png,svg,woff2}'] },
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'InkPad',
        short_name: 'InkPad',
        description: 'Notes with typing, Apple Pencil ink and images',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        background_color: '#f6f5f1',
        theme_color: '#7b4fd6',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
