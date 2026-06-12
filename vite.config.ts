import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Prebundle the 7k-icon SF Symbols barrels at server start so their first
  // use doesn't trigger a mid-session optimize-and-reload.
  optimizeDeps: {
    include: ['sf-symbols-lib/dualtone', 'sf-symbols-lib/monochrome'],
  },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
