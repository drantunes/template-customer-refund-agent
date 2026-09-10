import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const documentation = [
  "README.md",
  "CONTRIBUTING.md",
  ".env.example",
  "support-demo-ui/README.md",
  "client-demo-ui/README.md",
  ...walk(resolve(root, "docs")).map((path) => relative(root, path)),
];
const errors = [];
const packageScripts = {
  root: Object.keys(
    JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts,
  ),
  web: Object.keys(
    JSON.parse(
      readFileSync(resolve(root, "support-demo-ui/package.json"), "utf8"),
    ).scripts,
  ),
  demo: Object.keys(
    JSON.parse(
      readFileSync(resolve(root, "client-demo-ui/package.json"), "utf8"),
    ).scripts,
  ),
};
const workspaceScripts = {
  "support-demo-ui": packageScripts.web,
  "client-demo-ui": packageScripts.demo,
};

for (const file of documentation) {
  const path = resolve(root, file);
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(
    /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g,
  )) {
    const target = match[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [targetPath, targetAnchor] = target.split("#", 2);
    const localPath = targetPath ? resolve(dirname(path), targetPath) : path;
    if (!existsSync(localPath)) {
      errors.push(`${file} links to missing repository path ${target}.`);
      continue;
    }
    if (targetAnchor && !hasAnchor(localPath, targetAnchor))
      errors.push(`${file} links to missing anchor ${target}.`);
  }
  if (/\b(?:bun|pnpm|yarn)\s+(?:run|install|dev|build)\b/i.test(text))
    errors.push(`${file} contains a stale package-manager command.`);
  if (/TEMPLATE_NAME|create-mastria/i.test(text))
    errors.push(
      `${file} contains an unresolved template placeholder or stale command.`,
    );
  if (
    /\b(?:sk-[A-Za-z0-9_-]{16,}|rk_live_[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/.test(
      text,
    )
  )
    errors.push(`${file} contains a value that looks like a committed secret.`);
  for (const match of text.matchAll(
    /npm\s+run(?:\s+--workspace\s+([^\s]+))?\s+([A-Za-z0-9:_-]+)/g,
  )) {
    const [, workspace, script] = match;
    const available = workspace
      ? workspaceScripts[workspace]
      : packageScripts.root;
    if (!available) {
      errors.push(`${file} references unknown npm workspace ${workspace}.`);
      continue;
    }
    if (!available.includes(script))
      errors.push(`${file} references missing npm script ${script}.`);
  }
}

const syntheticExample = readFileSync(
  resolve(root, "docs/examples.md"),
  "utf8",
);
if (
  !/every\s+(?:identity|message|order|result|example)[\s\S]{0,120}\bsynthetic\b/i.test(
    syntheticExample,
  )
)
  errors.push("docs/examples.md must identify every example as synthetic.");
for (const asset of ["docs/assets/local-demo-admin.png"])
  if (!existsSync(resolve(root, asset)))
    errors.push(`Missing documented asset ${asset}.`);

if (errors.length)
  throw new Error(`Documentation validation failed:\n- ${errors.join("\n- ")}`);
console.log(
  `Documentation validation passed for ${documentation.length} files.`,
);

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? walk(path)
      : entry.name.endsWith(".md")
        ? [path]
        : [];
  });
}

function hasAnchor(path, anchor) {
  if (!path.endsWith(".md")) return false;
  const requested = decodeURIComponent(anchor).toLowerCase();
  const seen = new Map();
  for (const heading of readFileSync(path, "utf8").matchAll(
    /^#{1,6}\s+(.+)$/gm,
  )) {
    const base = headingId(heading[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    if (`${base}${count ? `-${count}` : ""}` === requested) return true;
  }
  return false;
}

function headingId(heading) {
  return heading
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[\\`*_~]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}
