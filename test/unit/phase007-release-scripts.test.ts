import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const checkEnv = resolve(root, "scripts/check-env.mjs");
const checkDocs = resolve(root, "scripts/check-docs.mjs");
const temporaryDirectories: string[] = [];
const localKey = "phase007-local-signing-key-at-least-32-characters";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function run(
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function localEnvironment(overrides: Record<string, string> = {}) {
  return {
    LOCAL_AUTH_SIGNING_KEY: localKey,
    SUPPORT_SOURCE: "mock",
    COMMERCE_SOURCE: "mock",
    ...overrides,
  };
}

describe("PHASE-007 environment validation", () => {
  it("keeps the CI preflight deterministic without an OpenAI key", async () => {
    const workflow = await readFile(
      resolve(root, ".github/workflows/ci.yml"),
      "utf8",
    );
    const preflight = workflow.match(
      /- name: Environment and documentation checks\n        run: \|\n          export LOCAL_AUTH_SIGNING_KEY=ci-local-signing-key-at-least-32-characters\n          npm run check:env -- (?<arguments>.+)\n/,
    );

    expect(preflight?.groups?.arguments).toBe(
      "--profile=local --mode=deterministic",
    );

    const keyFreeEnvironment = localEnvironment();
    expect(keyFreeEnvironment).not.toHaveProperty("OPENAI_API_KEY");

    const result = run(
      checkEnv,
      preflight!.groups!.arguments.split(" "),
      keyFreeEnvironment,
    );

    expect(result).toMatchObject({ status: 0 });
    expect(result.output).toContain(
      "Environment profile local is valid in deterministic mode.",
    );
  });

  it("accepts the explicit deterministic local mock profile without creating its database", async () => {
    const directory = await temporaryDirectory();
    const database = join(directory, "must-not-exist.db");
    const result = run(
      checkEnv,
      ["--profile=local", "--mode=deterministic"],
      localEnvironment({ TURSO_DATABASE_URL: `file:${database}` }),
    );

    expect(result).toMatchObject({ status: 0 });
    expect(result.output).toContain(
      "Environment profile local is valid in deterministic mode.",
    );
    expect(existsSync(database)).toBe(false);
  });

  it("rejects missing and short local signing keys", () => {
    for (const environment of [
      { SUPPORT_SOURCE: "mock", COMMERCE_SOURCE: "mock" },
      localEnvironment({ LOCAL_AUTH_SIGNING_KEY: "short" }),
    ]) {
      const result = run(
        checkEnv,
        ["--profile=local", "--mode=deterministic"],
        environment,
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("LOCAL_AUTH_SIGNING_KEY");
    }
  });

  it("requires a non-empty OpenAI key by default and keeps deterministic validation explicit", () => {
    for (const environment of [
      localEnvironment(),
      localEnvironment({ OPENAI_API_KEY: "   " }),
    ]) {
      const result = run(checkEnv, ["--profile=local"], environment);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        "OPENAI_API_KEY is required for interactive mode.",
      );
    }

    const interactive = run(
      checkEnv,
      ["--profile=local"],
      localEnvironment({ OPENAI_API_KEY: "synthetic-interactive-key" }),
    );
    expect(interactive).toMatchObject({ status: 0 });
    expect(interactive.output).toContain("valid in interactive mode.");

    const unknown = run(
      checkEnv,
      ["--profile=local", "--mode=preview"],
      localEnvironment(),
    );
    expect(unknown.status).not.toBe(0);
    expect(unknown.output).toContain("Unknown environment mode.");
  });

  it("validates every enabled provider even when a different named profile is selected", () => {
    const token = "intercom-token-that-must-never-appear-in-errors";
    const result = run(
      checkEnv,
      ["--profile=stripe", "--mode=deterministic"],
      localEnvironment({
        SUPPORT_SOURCE: "intercom",
        INTERCOM_ACCESS_TOKEN: token,
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("INTERCOM_DEVELOPMENT_ENABLED");
    expect(result.output).toContain("STRIPE_SANDBOX_ENABLED");
    expect(result.output).not.toContain(token);
  });

  it("rejects live Stripe keys, unapproved origins, and retention expansion without exposing values", () => {
    const liveKey = "rk_live_this-value-must-never-appear-in-errors";
    const result = run(
      checkEnv,
      ["--mode=deterministic"],
      localEnvironment({
        COMMERCE_SOURCE: "stripe",
        STRIPE_SANDBOX_ENABLED: "true",
        STRIPE_TENANT_ID: "local-demo",
        STRIPE_ACCOUNT_ID: "acct_synthetic",
        STRIPE_RESTRICTED_API_KEY: liveKey,
        STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
        STRIPE_API_BASE_URL: "https://unapproved.invalid",
        SUPPORT_RETENTION_CASE_DAYS: "91",
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "STRIPE_RESTRICTED_API_KEY must be a Stripe test restricted key.",
    );
    expect(result.output).toContain(
      "STRIPE_API_BASE_URL must use an approved provider API origin.",
    );
    expect(result.output).toContain(
      "SUPPORT_RETENTION_CASE_DAYS must be an integer from 1 through 90.",
    );
    expect(result.output).not.toContain(liveKey);
  });
});

describe("PHASE-007 documentation validation", () => {
  it("accepts a complete synthetic fixture and rejects each release-documentation failure", async () => {
    const repository = await documentationFixture();
    expect(run(join(repository, "scripts/check-docs.mjs"), [], {}).status).toBe(
      0,
    );

    await writeFile(join(repository, "README.md"), "[missing](missing.md)\n");
    expect(run(join(repository, "scripts/check-docs.mjs")).output).toContain(
      "links to missing repository path missing.md",
    );

    await writeFile(
      join(repository, "README.md"),
      "[bad](docs/examples.md#missing-anchor)\n",
    );
    expect(run(join(repository, "scripts/check-docs.mjs")).output).toContain(
      "links to missing anchor docs/examples.md#missing-anchor",
    );

    await writeFile(join(repository, "README.md"), "npm run obsolete\n");
    expect(run(join(repository, "scripts/check-docs.mjs")).output).toContain(
      "references missing npm script obsolete",
    );

    await writeFile(
      join(repository, "README.md"),
      "sk-abcdefghijklmnopqrstuvwxyz012345\n",
    );
    expect(run(join(repository, "scripts/check-docs.mjs")).output).toContain(
      "looks like a committed secret",
    );

    await writeFile(join(repository, "README.md"), "# Valid\n");
    await writeFile(
      join(repository, "docs/examples.md"),
      "# Example\nalex@example.com\n",
    );
    expect(run(join(repository, "scripts/check-docs.mjs")).output).toContain(
      "must identify every example as synthetic",
    );
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "phase007-release-script-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function documentationFixture() {
  const repository = await temporaryDirectory();
  await Promise.all([
    mkdir(join(repository, "scripts"), { recursive: true }),
    mkdir(join(repository, "web"), { recursive: true }),
    mkdir(join(repository, "demo"), { recursive: true }),
    mkdir(join(repository, "docs/assets"), { recursive: true }),
  ]);
  await cp(checkDocs, join(repository, "scripts/check-docs.mjs"));
  await Promise.all([
    writeFile(
      join(repository, "package.json"),
      JSON.stringify({ scripts: { check: "node check.mjs" } }),
    ),
    writeFile(
      join(repository, "web/package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    ),
    writeFile(
      join(repository, "README.md"),
      "# Valid\n[Example](docs/examples.md#example)\nnpm run check\n",
    ),
    writeFile(join(repository, "CONTRIBUTING.md"), "# Contributing\n"),
    writeFile(join(repository, ".env.example"), "LOCAL_AUTH_SIGNING_KEY=\n"),
    writeFile(
      join(repository, "web/README.md"),
      "# Web\nnpm run --workspace support-refund-agent-web dev\n",
    ),
    writeFile(join(repository, "demo/README.md"), "# Demo\n"),
    writeFile(
      join(repository, "demo/package.json"),
      JSON.stringify({ scripts: { dev: "tsx src/server.tsx" } }),
    ),
    writeFile(
      join(repository, "docs/examples.md"),
      "# Example\nEvery identity, message, order, and result below is synthetic.\n",
    ),
    writeFile(
      join(repository, "docs/assets/local-demo-admin.png"),
      "synthetic",
    ),
  ]);
  return repository;
}
