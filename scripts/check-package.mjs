#!/usr/bin/env node
/**
 * prepack guard for memory-lancedb-pro (npm-compat 2026-09).
 * Fails the pack when any historically-observed packaging regression returns:
 *  1. openclaw.plugin.json missing from the "files" whitelist (2026-09-26 P1 baseline: tarball shipped without manifest)
 *  2. src/ (TS log shells) shipped — dist/ is the authoritative runtime
 *  3. install.npmSpec impersonating the @openclaw scope or drifting from package name
 *  4. version drift between package.json and openclaw.plugin.json
 *  5. a declared contract tool id that no longer appears anywhere in dist/
 *  6. runtime data artifacts (sqlite/lance/env/keys) inside the package tree
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const errors = [];

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".npm-cache") continue;
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

const manifestPath = path.join(root, "openclaw.plugin.json");
const hasManifest = existsSync(manifestPath);
if (!hasManifest) errors.push("openclaw.plugin.json missing in repo root");
const mf = hasManifest ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;

if (mf && pkg.version !== mf.version) {
  errors.push(`version drift: package.json=${pkg.version} manifest=${mf.version}`);
}

if (!Array.isArray(pkg.files) || !pkg.files.includes("openclaw.plugin.json")) {
  errors.push('package.json "files" must include "openclaw.plugin.json"');
}
if (Array.isArray(pkg.files) && pkg.files.includes("src/")) {
  errors.push('package.json "files" must not ship "src/" (dist/ is authoritative; tsconfig is noEmit)');
}

const npmSpec = pkg.openclaw?.install?.npmSpec;
if (typeof npmSpec === "string" && npmSpec.startsWith("@openclaw/")) {
  errors.push(`install.npmSpec "${npmSpec}" impersonates the @openclaw scope`);
}
if (npmSpec !== pkg.name) {
  errors.push(`install.npmSpec "${npmSpec}" != package name "${pkg.name}"`);
}

if (!pkg.main || !existsSync(path.join(root, pkg.main))) {
  errors.push(`main entry "${pkg.main}" does not exist on disk`);
}

const distDir = path.join(root, "dist");
const jsFiles = existsSync(distDir)
  ? walkFiles(distDir).filter((f) => /\.(js|mjs|cjs)$/.test(f))
  : [];
if (jsFiles.length === 0) errors.push("dist/ contains no JS — runtime entry would be empty");
const distBlob = jsFiles.map((f) => readFileSync(f, "utf8")).join("\n");

const tools = mf?.contracts?.tools ?? [];
if (tools.length !== 27) errors.push(`expected 27 contract tools, found ${tools.length}`);
for (const t of tools) {
  if (!distBlob.includes(`"${t}"`) && !distBlob.includes(`'${t}'`) && !distBlob.includes(`\`${t}\``)) {
    errors.push(`contract tool "${t}" not referenced anywhere in dist/`);
  }
}

const forbidden = /\.(sqlite|sqlite3|lance|db|pem|key)$/i;
for (const f of walkFiles(root)) {
  const rel = path.relative(root, f).replace(/\\/g, "/");
  if (forbidden.test(rel)) errors.push(`runtime artifact inside package tree: ${rel}`);
  if (/(^|\/)\.env($|\/)/.test(rel)) errors.push(`env file inside package tree: ${rel}`);
  if (/(^|\/)memory_index/i.test(rel)) errors.push(`memory DB path leaked into tree: ${rel}`);
}

if (errors.length) {
  console.error("check-package FAILED:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(
  `check-package OK: ${pkg.name}@${pkg.version}, manifest synced, ${tools.length} tools in dist (${jsFiles.length} JS files), no src/, no runtime artifacts`
);
