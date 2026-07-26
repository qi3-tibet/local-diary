import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.DIARY_API_ORIGIN ?? "http://127.0.0.1:4174";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            if (isLocalDevelopmentOrigin(request.headers.origin, request.headers.host)) {
              proxyRequest.setHeader("origin", apiOrigin);
            }
          });
        },
      },
    },
  },
});

function isLocalDevelopmentOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    const parsedHost = new URL(`http://${host}`);
    return (
      parsedOrigin.protocol === "http:"
      && new Set(["127.0.0.1", "localhost", "[::1]"]).has(
        parsedOrigin.hostname.toLowerCase(),
      )
      && parsedOrigin.origin.toLowerCase() === parsedHost.origin.toLowerCase()
    );
  } catch {
    return false;
  }
}
