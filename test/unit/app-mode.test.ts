import { describe, expect, it } from "vitest";
import {
  appMode,
  assertDatabaseIsolation,
  isLocalMode,
} from "../../config/app-mode.mjs";

describe("APP_MODE profile selection", () => {
  it("defaults a fresh environment to local but preserves legacy explicit opt-ins", () => {
    expect(appMode({})).toBe("local");
    expect(isLocalMode({})).toBe(true);
    expect(appMode({ SUPPORT_SOURCE: "intercom" })).toBe("staging");
    expect(isLocalMode({ SUPPORT_SOURCE: "intercom" })).toBe(false);
  });
  it("lets explicit local override external credentials and requires distinct persistent stores", () => {
    const env = {
      APP_MODE: "local",
      TURSO_DATABASE_URL: "file:.data/external.db",
      DEMO_DATABASE_URL: "file:.data/external-client.db",
      LOCAL_DEMO_DATABASE_URL: "file:.data/local.db",
      LOCAL_DEMO_CLIENT_DATABASE_URL: "file:.data/local-client.db",
    };
    expect(assertDatabaseIsolation(env)).toMatchObject({ mode: "local" });
    expect(() =>
      assertDatabaseIsolation({
        ...env,
        LOCAL_DEMO_CLIENT_DATABASE_URL: "file:.data/local.db",
      }),
    ).toThrow("different files");
    expect(() =>
      assertDatabaseIsolation({
        ...env,
        LOCAL_DEMO_DATABASE_URL: "https://remote.example/db",
      }),
    ).toThrow("persistent file");
  });
  it("requires full configured database selection for explicit external modes", () => {
    expect(() => assertDatabaseIsolation({ APP_MODE: "staging" })).toThrow(
      "requires TURSO_DATABASE_URL",
    );
  });
});

describe("profile path and preload regression", () => {
  it("keeps a fresh and a repeated preload local without reinterpreting the selected file as external", async () => {
    const { execFileSync } = await import("node:child_process");
    const { templateRoot } = await import("../../config/app-mode.mjs");
    const environment = {
      PATH: process.env.PATH,
      APP_MODE: "local",
      OPENAI_API_KEY: "fixture",
    };
    const result = execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/database-env.mjs",
        "--input-type=module",
        "-e",
        `import {applyModeToEnvironment} from './config/app-mode.mjs'; await import('./scripts/database-env.mjs?second'); const p=applyModeToEnvironment(); console.log(JSON.stringify({backend:p.backend,root:process.env.TEMPLATE_ROOT,original:process.env.ORIGINAL_TURSO_DATABASE_URL}));`,
      ],
      { cwd: templateRoot, env: environment, encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual({
      backend: new URL(".data/local-demo.db", `file://${templateRoot}/`).href,
      root: templateRoot,
      original: "",
    });
  });
  it("rejects symlink ancestors before creation and existing hardlinks", async () => {
    const {
      mkdtempSync,
      mkdirSync,
      symlinkSync,
      writeFileSync,
      linkSync,
      rmSync,
    } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "src033-profile-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "alias"));
      const base = {
        APP_MODE: "local",
        LOCAL_DEMO_CLIENT_DATABASE_URL: `file:${root}/client.db`,
      };
      expect(() =>
        assertDatabaseIsolation({
          ...base,
          LOCAL_DEMO_DATABASE_URL: `file:${root}/alias/future.db`,
          TURSO_DATABASE_URL: `file:${root}/real/future.db`,
        }),
      ).toThrow("different files");
      writeFileSync(join(root, "real/existing.db"), "sentinel");
      linkSync(join(root, "real/existing.db"), join(root, "other.db"));
      expect(() =>
        assertDatabaseIsolation({
          ...base,
          LOCAL_DEMO_DATABASE_URL: `file:${root}/other.db`,
          TURSO_DATABASE_URL: `file:${root}/real/existing.db`,
        }),
      ).toThrow("different files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("preserves external workspace-relative client files and rejects their local aliases", async () => {
    const { databaseProfile } = await import("../../config/app-mode.mjs");
    const environment = {
      APP_MODE: "staging",
      TURSO_DATABASE_URL: "file:external-backend.db",
      DEMO_DATABASE_URL: "file:.data/external-client.db",
    };
    expect(databaseProfile(environment).client).toBe(
      "file:.data/external-client.db",
    );
    expect(() =>
      assertDatabaseIsolation({
        ...environment,
        LOCAL_DEMO_DATABASE_URL: "file:client-demo-ui/.data/external-client.db",
      }),
    ).toThrow("different files");
  });
  it("switches both providers explicitly while retaining both database files", async () => {
    const { applyModeToEnvironment } =
      await import("../../config/app-mode.mjs");
    const environment = {
      APP_MODE: "production",
      SUPPORT_SOURCE: "mock",
      COMMERCE_SOURCE: "mock",
      TURSO_DATABASE_URL: "file:external-backend.db",
      DEMO_DATABASE_URL: "file:.data/external-client.db",
    };
    const external = applyModeToEnvironment(environment);
    expect(environment).toMatchObject({
      SUPPORT_SOURCE: "intercom",
      COMMERCE_SOURCE: "stripe",
    });
    environment.APP_MODE = "local";
    const local = applyModeToEnvironment(environment);
    expect(environment).toMatchObject({
      SUPPORT_SOURCE: "mock",
      COMMERCE_SOURCE: "mock",
      TURSO_DATABASE_URL: "file:external-backend.db",
    });
    expect(local.backend).not.toBe(external.backend);
    expect(local.client).not.toBe(external.client);
  });
});
