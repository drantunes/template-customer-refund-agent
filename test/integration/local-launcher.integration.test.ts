import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { templateRoot } from "../../config/app-mode.mjs";

const directories: string[] = [];
const running: ChildProcess[] = [];
afterEach(async () => {
  for (const child of running.splice(0))
    if (child.exitCode === null) child.kill("SIGTERM");
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "src033-launcher-"));
  directories.push(directory);
  await mkdir(join(directory, "bin"));
  await writeFile(
    join(directory, "bin/npm"),
    `#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http'),args=process.argv.slice(2);
if(args.includes('local:seed')){fs.appendFileSync(process.env.FAKE_RECORD+'.seed','seed\\n');process.exit(0)}
const kind=args.includes('dev:client-demo')?'client':args.includes('dev:support-demo')?'support':'backend';
if(process.env.FAKE_FAIL_BEFORE===kind)process.exit(9);
const port=kind==='client'?process.env.DEMO_PORT:kind==='support'?args.at(-1):process.env.LOCAL_DEMO_BACKEND_PORT;
const server=http.createServer((req,res)=>{res.writeHead(200);res.end('ok')});
server.listen(Number(port),'127.0.0.1',()=>{fs.appendFileSync(process.env.FAKE_RECORD,process.pid+'\\n');if(process.env.FAKE_FAIL_AFTER===kind)setTimeout(()=>process.exit(9),750)});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,
    { mode: 0o755 },
  );
  const ports = new Set<number>();
  while (ports.size < 3) ports.add(await freePort());
  const [backend, client, support] = [...ports];
  const env = {
    PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    HOME: process.env.HOME,
    TEMPLATE_ROOT: directory,
    OPENAI_API_KEY: "fixture-no-network",
    APP_MODE: "local",
    LOCAL_DEMO_BACKEND_PORT: String(backend),
    LOCAL_DEMO_CLIENT_PORT: String(client),
    LOCAL_DEMO_SUPPORT_PORT: String(support),
    FAKE_RECORD: join(directory, "children"),
    ...overrides,
  };
  return { directory, env };
}
function launch(env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [join(templateRoot, "scripts/demo-local.mjs")],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  running.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  return { child, exited, output: () => output };
}
async function assertStopped(directory: string) {
  if (!existsSync(join(directory, "children"))) return;
  const pids = (await readFile(join(directory, "children"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}

it("starts all services and terminates only its own process groups on shutdown", async () => {
  const { directory, env } = await fixture();
  const app = launch(env);
  await expect
    .poll(app.output, { timeout: 10_000 })
    .toContain("Local demo ready:");
  expect(
    (await readFile(join(directory, "children.seed"), "utf8"))
      .trim()
      .split("\n"),
  ).toHaveLength(2);
  app.child.kill("SIGTERM");
  expect(await app.exited).toBe(0);
  await assertStopped(directory);
}, 15_000);

it.each(["FAKE_FAIL_BEFORE", "FAKE_FAIL_AFTER"])(
  "fails and cleans up when a service exits (%s)",
  async (setting) => {
    const { directory, env } = await fixture({ [setting]: "support" });
    const app = launch(env);
    expect(await app.exited).toBe(1);
    expect(app.output()).toContain("exited unexpectedly");
    if (setting === "FAKE_FAIL_BEFORE")
      expect(app.output()).not.toContain("Local demo ready:");
    await assertStopped(directory);
  },
  15_000,
);

it("refuses an occupied port before seeding and leaves the existing listener intact", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { directory, env } = await fixture({
      LOCAL_DEMO_BACKEND_PORT: String(
        (server.address() as net.AddressInfo).port,
      ),
    });
    const app = launch(env);
    expect(await app.exited).toBe(1);
    expect(app.output()).toContain("already in use");
    expect(existsSync(join(directory, ".data"))).toBe(false);
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
