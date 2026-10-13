import { defineConfig } from 'vite'
import { swPlugin } from './swPlugin'

// Public base path of the built site. BASE_PATH overrides it:
//   - default build: '/mobdaw/' (wrongbad.com/mobdaw/; Caddy strips the prefix)
//   - daw.bitcount.com (static, deploy/aws): BASE_PATH=/
// Dev always serves from the root unless BASE_PATH is set.
const normalize = (p: string) => {
  if (p === './' || p === '.') return './' // relative: the site works from any folder (e.g. a preview host)
  const trimmed = p.replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ? normalize(process.env.BASE_PATH) : command === 'build' ? '/mobdaw/' : '/',
  // the service worker (offline + install): build only, see swPlugin.ts and src/pwa.ts
  plugins: [swPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/collab': { target: 'ws://localhost:8787', ws: true },
    },
  },
}))
