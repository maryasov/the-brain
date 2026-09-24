import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Workspace packages are source-only TypeScript, so they must be BUNDLED into
// main/preload rather than externalized (there is no built dist to require()).
const bundle = ['@the-brain/shared', '@the-brain/core', '@the-brain/db']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundle })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundle })]
  },
  renderer: {
    plugins: [react()]
  }
})
