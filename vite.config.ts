import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Version shown in the app: when it was built and from which commit. GitHub
// Actions sets GITHUB_SHA; a build on this computer is labelled "dev".
declare const process: { env: Record<string, string | undefined> }
const version = { commit: (process.env.GITHUB_SHA ?? 'dev').slice(0, 7), built: new Date().toISOString() }

// base './' keeps every asset path relative, so the same build works on
// GitHub Pages (https://user.github.io/repo/) and on a local server.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    // the same version as a file, so an open app can see whether a newer one is online
    {
      name: 'version-file',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(version) })
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      // math fonts too, so formulas render offline
      workbox: { globPatterns: ['**/*.{js,css,html,png,svg,woff2}'] },
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'NeatNotes',
        short_name: 'NeatNotes',
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
