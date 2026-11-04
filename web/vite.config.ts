import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The gateway's HTTP server (src/proxy/http-gateway.ts) serves /api itself;
// in dev, Vite proxies to it so the browser only ever talks to one origin
// (http://localhost:5173) — avoiding CORS entirely rather than configuring
// it, which is one less thing that can be configured wrong on a gateway
// whose whole point is tight origin control.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3100",
        changeOrigin: false,
      },
    },
  },
});
