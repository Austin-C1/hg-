import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { APP_CONTRACT_VERSION } from '../src/crown/app/app-contract-version.mjs'

export default defineConfig({
  define: {
    __APP_CONTRACT_VERSION__: JSON.stringify(APP_CONTRACT_VERSION),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
})
