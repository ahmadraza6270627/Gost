export default {
  build: {
    target: 'es2022'
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022', supported: { bigint: true } }
  },
  server: {
    open: true,
    proxy: {
      '/auth':              { target: 'http://localhost:5000', changeOrigin: true },
      '/user':              { target: 'http://localhost:5000', changeOrigin: true },
      '/api':               { target: 'http://localhost:5000', changeOrigin: true },
      '/messages':          { target: 'http://localhost:5000', changeOrigin: true },
    }
}
}
