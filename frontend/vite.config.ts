import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Overlay Studio 独立回环引擎专属根路径与中间件路由（置于通用 /api 之前，零命名冲突）
      '/overlay-engine': {
        target: 'http://127.0.0.1:5177',
        changeOrigin: true,
        ws: true,
      },
      '/demo': {
        target: 'http://127.0.0.1:5177',
        changeOrigin: true,
        rewrite: (p) => '/overlay-engine' + p,
      },
      '/sfx': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/_media': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/_projects': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/_fxframes': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/logos': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/api/export-status': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '^/api/export($|\\?)': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/api/overlay-status': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/api/overlay-file': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/api/media': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/api/upload-demo': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/api/project': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/api/review-log': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      '/api/choose-export-folder': { target: 'http://127.0.0.1:5177', changeOrigin: true },
      // 主工作台 FastAPI 后端
      '/api': 'http://127.0.0.1:8000',
      '/quick-collect': 'http://127.0.0.1:8000',
    },
  },
})
