import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// server 端口的唯一来源是仓库根 .env 的 PORT;这里读同一个文件,代理目标自动跟随
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '')
  const port = rootEnv.PORT ?? '61127'
  return {
    plugins: [react()],
    server: {
      proxy: { '/api': `http://localhost:${port}` },
    },
  }
})
