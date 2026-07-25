import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.DIARY_API_ORIGIN ?? "http://127.0.0.1:4174",
      },
    },
  },
});
