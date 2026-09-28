import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 管理后台前端：构建产物由后端以 /admin/ 前缀托管，故 base 固定为 /admin/。
export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': {
        target: process.env.CCP_UPSTREAM || 'http://127.0.0.1:3050',
        changeOrigin: true,
        ws: false,
      },
    },
  },
})
