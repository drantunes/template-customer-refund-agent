import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const source = resolve(process.argv[2] || process.cwd());
const destination = await mkdtemp(
  join(tmpdir(), "support-refund-clean-clone-"),
);
const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 900_000,
    killSignal: "SIGTERM",
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  return result.stdout.trim();
};
let server;
let serverOutput = "";
try {
  run(
    "git",
    ["clone", "--no-local", "--no-hardlinks", source, destination],
    source,
  );
  const sha = run("git", ["rev-parse", "HEAD"], destination);
  await writeFile(
    join(destination, ".env"),
    [
      "LOCAL_AUTH_SIGNING_KEY=clean-clone-smoke-signing-key-at-least-32-characters",
      "TURSO_DATABASE_URL=file:./support-local.db",
      "SUPPORT_SOURCE=mock",
      "COMMERCE_SOURCE=mock",
    ].join("\n"),
  );
  const env = {
    PATH: process.env.PATH,
    npm_config_cache: process.env.npm_config_cache,
    SUPPORT_SOURCE: "mock",
    COMMERCE_SOURCE: "mock",
    TURSO_DATABASE_URL: `file:${join(destination, "support-local.db")}`,
    LOCAL_AUTH_SIGNING_KEY:
      "clean-clone-smoke-signing-key-at-least-32-characters",
    NO_COLOR: "1",
  };
  const e2eApiPort = await unusedPort();
  const e2ePort = await unusedPort();
  env.E2E_API_PORT = String(e2eApiPort);
  env.E2E_PORT = String(e2ePort);
  run("npm", ["ci"], destination, env);
  for (const command of [
    ["run", "check:runtime"],
    ["run", "check:env", "--", "--profile=local"],
    ["run", "local:seed"],
    ["run", "build"],
    ["run", "build:web"],
    ["run", "test:e2e"],
  ])
    run("npm", command, destination, env);
  const port = await unusedPort();
  env.PORT = String(port);
  server = spawn("npm", ["run", "dev"], {
    cwd: destination,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr])
    stream?.on("data", (chunk) => {
      if (serverOutput.length < 12_000)
        serverOutput += chunk.toString().slice(0, 12_000 - serverOutput.length);
    });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      if (server.exitCode !== null) break;
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready)
    throw new Error(`Local server did not become ready.\n${serverOutput}`);
  const login = await fetch(`http://127.0.0.1:${port}/support/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      email: "alex@example.com",
      password: "local-customer-alex",
    }),
  });
  if (!login.ok) throw new Error("Local smoke authentication failed.");
  const session = await login.json().catch(() => ({}));
  if (!session || typeof session.token !== "string" || !session.token)
    throw new Error("Local smoke authentication response was invalid.");
  const openApiResponse = await fetch(
    `http://127.0.0.1:${port}/support/openapi.json`,
    {
      headers: { authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  const openApi = await openApiResponse.json().catch(() => undefined);
  if (!openApiResponse.ok || openApi?.openapi !== "3.1.0")
    throw new Error("Authenticated OpenAPI check failed.");
  console.log(`Clean-clone smoke passed for ${sha}.`);
} finally {
  if (server?.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    const exited = new Promise((resolve) => server.once("exit", resolve));
    const terminated = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!terminated && server.pid) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        server.kill("SIGKILL");
      }
      await exited;
    }
  }
  await rm(destination, { recursive: true, force: true });
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close((error) =>
        error
          ? reject(error)
          : resolve(address && typeof address !== "string" ? address.port : 0),
      );
    });
  });
}
