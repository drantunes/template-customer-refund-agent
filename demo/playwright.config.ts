import { defineConfig, devices } from "@playwright/test";

const port = 3001;
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}`, ...devices["Desktop Chrome"] },
  webServer: {
    command: `DEMO_PORT=${port} DEMO_DATABASE_URL=file:/private/tmp/northstar-demo-e2e.db npm run e2e:serve`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
