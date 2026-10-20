import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:4175",
    headless: true,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: [
    { command: "node tools/test-peer-server.mjs", url: "http://127.0.0.1:9001", reuseExistingServer: false },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4175 --strictPort",
      url: "http://127.0.0.1:4175", reuseExistingServer: false,
      env: { VITE_PEER_HOST: "127.0.0.1", VITE_PEER_PORT: "9001", VITE_PEER_SECURE: "false", VITE_PEER_NO_STUN: "true" },
    },
  ],
});
