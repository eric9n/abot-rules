#!/usr/bin/env node
// The only supported way to deploy abot-rules.
//
//   npm run deploy:check   preflight + bundle + `wrangler deploy --dry-run` (no credentials needed)
//   npm run deploy         preflight + dry run + real deploy to Cloudflare
//
// Runs both on a workstation/CI (needs CLOUDFLARE_API_TOKEN) and as the
// Deploy command of Cloudflare Workers Builds (detected via WORKERS_CI=1).

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "wrangler.jsonc");
const PROD_BRANCH = "main";
const WORKER_NAME = "abot-rules";

const checkOnly = process.argv.includes("--check");
const inWorkersBuilds = process.env.WORKERS_CI === "1";

function log(msg) { console.log(`[deploy] ${msg}`); }
function fail(msg) { console.error(`[deploy] ERROR: ${msg}`); process.exit(1); }

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args[0] ?? ""} exited with ${r.status}`);
}

function wrangler(...args) {
  run(process.execPath, [path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"), ...args]);
}

function stripJsonc(text) {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n; i++; } else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// /mcp has no token check and trusts X-Abot-Owner-Email, so any public
// entry point would let anyone act as any user. Refuse to ship one.
function checkConfigInvariants() {
  const cfg = stripJsonc(readFileSync(CONFIG, "utf8"));
  if (cfg.name !== WORKER_NAME) fail(`wrangler.jsonc name must be "${WORKER_NAME}"`);
  if (cfg.workers_dev !== false) fail("workers_dev must be false (Worker is Service-Binding only)");
  if (cfg.preview_urls !== false) fail("preview_urls must be false (Worker is Service-Binding only)");
  for (const k of ["route", "routes"]) if (cfg[k] !== undefined) fail(`"${k}" is not allowed: Worker must have no public hostname`);
  if (cfg.env !== undefined) fail('"env" blocks are not supported: there is exactly one production Worker');
  const consumers = cfg.queues?.consumers ?? [];
  const re = consumers.find(c => c.queue === "rule-events");
  if (!re) fail("rule-events queue consumer missing");
  if (!re.dead_letter_queue) fail("rule-events consumer must have a dead_letter_queue");
  log("config invariants OK (no public hostname, DLQ attached)");
}

function checkGit() {
  const sha = process.env.WORKERS_CI_COMMIT_SHA || git("rev-parse", "HEAD");
  const branch = process.env.WORKERS_CI_BRANCH || git("rev-parse", "--abbrev-ref", "HEAD");
  if (!checkOnly && branch !== PROD_BRANCH) fail(`deploys only from "${PROD_BRANCH}" (current: ${branch})`);
  if (!inWorkersBuilds) {
    const dirty = git("status", "--porcelain");
    if (dirty && !checkOnly) fail(`working tree is dirty:\n${dirty}`);
    if (!checkOnly) {
      run("git", ["fetch", "--quiet", "origin", PROD_BRANCH]);
      const remote = git("rev-parse", `origin/${PROD_BRANCH}`);
      if (remote !== sha) fail(`HEAD ${sha.slice(0, 7)} != origin/${PROD_BRANCH} ${remote.slice(0, 7)}; push/pull first`);
    }
  }
  const subject = git("log", "-1", "--format=%s", sha).slice(0, 80);
  log(`commit ${sha.slice(0, 12)} on ${branch}: ${subject}`);
  return { sha, branch, subject };
}

const { sha, subject } = checkGit();
checkConfigInvariants();
run("npm", ["test", "--silent"]);
wrangler("deploy", "--config", CONFIG, "--dry-run", "--outdir", path.join(ROOT, "dist"));

if (checkOnly) {
  log("check passed; nothing deployed");
  process.exit(0);
}

if (!inWorkersBuilds && !process.env.CLOUDFLARE_API_TOKEN) {
  fail("CLOUDFLARE_API_TOKEN is not set");
}

wrangler(
  "deploy", "--config", CONFIG,
  "--strict",
  "--tag", sha.slice(0, 12),
  "--message", `${sha.slice(0, 12)} ${subject}`,
);
log("deployed");
