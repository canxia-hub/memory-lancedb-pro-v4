/**
 * Plugin structure + manifest validation tests
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const PLUGIN_ROOT = path.resolve(__dirname, "..");

describe("Plugin package.json", () => {
  let pkg;

  beforeAll(() => {
    pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
  });

  it("has correct identity", () => {
    expect(pkg.name).toBe("memory-lancedb-pro");
    expect(pkg.version).toBe("4.2.3-local.20261111");
    expect(pkg.type).toBe("module");
  });

  it("declares correct peer dependency", () => {
    expect(pkg.peerDependencies.openclaw).toBe(">=2026.5.6");
  });

  it("has openclaw install metadata", () => {
    expect(pkg.openclaw).toBeDefined();
    expect(pkg.openclaw.install).toBeDefined();
    expect(pkg.openclaw.install.npmSpec).toBe("memory-lancedb-pro");
  });

  it("has required scripts", () => {
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
    expect(pkg.scripts.test).toBe("vitest run");
  });

  it("depends on lancedb", () => {
    expect(pkg.dependencies["@lancedb/lancedb"]).toBeDefined();
  });
});

describe("openclaw.plugin.json manifest", () => {
  let manifest;

  beforeAll(() => {
    manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "openclaw.plugin.json"), "utf8"));
  });

  it("has correct id and version", () => {
    expect(manifest.id).toBe("memory-lancedb-pro");
    expect(manifest.version).toBe("4.2.3-local.20261111");
    expect(manifest.kind).toBe("memory");
  });

  it("declares hooks.timeoutMs", () => {
    expect(manifest.hooks).toBeDefined();
    expect(manifest.hooks.timeoutMs).toBe(60000);
  });

  it("declares contracts.tools with 24 tools", () => {
    expect(manifest.contracts).toBeDefined();
    expect(manifest.contracts.tools).toBeDefined();
    expect(manifest.contracts.tools.length).toBe(27);
  });

  it("includes all required memory tools", () => {
    const required = [
      "memory_store", "memory_list", "memory_recall",
      "memory_update", "memory_archive", "memory_promote",
      "memory_stats", "memory_debug", "memory_migrate_legacy",
    ];
    for (const t of required) {
      expect(manifest.contracts.tools).toContain(t);
    }
  });

  it("includes all required wiki tools", () => {
    const required = [
      "wiki_status", "wiki_new", "wiki_get", "wiki_query",
      "wiki_build", "wiki_doctor", "wiki_index", "wiki_sync_links",
    ];
    for (const t of required) {
      expect(manifest.contracts.tools).toContain(t);
    }
  });

  it("includes all working-memory tools (v4.1)", () => {
    const required = [
      "memory_wm_get", "memory_wm_create", "memory_wm_update",
      "memory_wm_append", "memory_wm_list", "memory_wm_archive",
    ];
    for (const t of required) {
      expect(manifest.contracts.tools).toContain(t);
    }
  });

  it("declares workingMemory config block", () => {
    const wm = manifest.configSchema.properties.workingMemory;
    expect(wm).toBeDefined();
    expect(wm.properties.enabled.default).toBe(true);
    expect(wm.properties.tableName.default).toBe("working_memory");
    expect(wm.properties.crossAgentWriteAllowlist.default).toEqual(["main"]);
  });

  it("has valid configSchema with dbPath required", () => {
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.required).toContain("dbPath");
  });

  it("has activation.onStartup: true", () => {
    expect(manifest.activation).toBeDefined();
    expect(manifest.activation.onStartup).toBe(true);
  });
});
