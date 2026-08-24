import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite ignores the PORT env var on its own: it always starts at 5173 and walks
// upward if that's taken, so a launcher that assigns a port has no way to know
// where the server actually landed. Honour PORT when it's set, and fail loudly
// rather than drifting to a different one. With PORT unset (plain `npm run
// dev`) both options are undefined/false, which is stock Vite behaviour.
const assignedPort = Number(process.env.PORT) || undefined

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: assignedPort,
    strictPort: Boolean(assignedPort),
  },
})
