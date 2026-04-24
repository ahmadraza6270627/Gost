import { resolve } from 'path'

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
    esbuildOptions: { target: 'es2022', supported: { bigint: true } }
  },
  server: {
    open: true,
    proxy: {
      '/auth':     { target: process.env.VITE_API_URL || 'http://localhost:5000', changeOrigin: true },
      '/user':     { target: process.env.VITE_API_URL || 'http://localhost:5000', changeOrigin: true },
      '/api':      { target: process.env.VITE_API_URL || 'http://localhost:5000', changeOrigin: true },
      '/messages': { target: process.env.VITE_API_URL || 'http://localhost:5000', changeOrigin: true },
    }
  }
}