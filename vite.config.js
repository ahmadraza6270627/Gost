import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default {
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        p2p: resolve(__dirname, 'p2p.html')
      }
    }
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
      supported: {
        bigint: true
      }
    }
  },
  server: {
    open: true,
    proxy: {
      '/auth': { target: 'http://localhost:5000', changeOrigin: true },
      '/user': { target: 'http://localhost:5000', changeOrigin: true },
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/messages': { target: 'http://localhost:5000', changeOrigin: true }
    }
  }
}