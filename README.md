# Memory LanceDB Pro v4

Capability-first LanceDB memory plugin for OpenClaw — hybrid retrieval, Wiki knowledge graph with vector search, per-agent working-memory（工作任务）lanes, and incremental build.

**Production-proven**: 767+ memories, 142 wiki pages vector-indexed, 4350 graph nodes / 5435 edges, 279/279 vitest passing, 48 working-memory task records migrated from the retired file layer.

> **Latest (2026-10-03)**: **v4.2.5** adds OpenClaw **2026.9.7** host compatibility — verified in production. Clone `main` for the loadable version.

## Quick Facts

| Item | Detail |
|------|--------|
| Version | 4.2.5 |
| OpenClaw | >=2026.5.6 (verified through 2026.9.7) |
| Tools | 27 (10 memory + 11 wiki + 6 working-memory) |
| Tests | 279 (11 test files) |
| DB | LanceDB 0.33 embedded |
| Embedding | 2560-dim (DashScope tongyi-embedding-vision-flash) |
| Tables | `memories` + `wiki_pages` + `working_memory` (fully isolated) |
| Retrieval | Hybrid: FTS (BM25) + Vector (cosine) + Lexical |
| Wiki | Graph + Vector Search + Incremental Build |

---

## Architecture

```
dist/
  index.js                  ← Plugin entry (definePluginEntry)
  config/                   ← Config resolve + schema + backend config
  store/
    lancedb-store.js        ← LanceDB 0.33 store (BITMAP + FTS indexes)
    asset-store.js          ← Multimodal asset indexing
    migrations.js           ← Schema migration manager
    scope-manager.js        ← Memory scope normalization
  retrieval/
    embedder.js             ← DashScope multimodal embedding (2560-dim)
    hybrid-retriever.js     ← FTS + Vector + Lexical three-way fusion
    search-manager.js       ← Public search interface (MemorySearchResult)
    rerank.js               ← External rerank provider (optional)
  tools/
    register.js             ← Tool registration + context init
    store.js                ← memory_store
    recall.js               ← memory_recall
    list.js                 ← memory_list
    promote.js              ← memory_promote
    update.js               ← memory_update
    archive.js              ← memory_archive
    diagnostics.js          ← memory_stats + memory_debug
    wiki-tools.js           ← 8 wiki tools registration
  wiki/
    wiki-store.js           ← Wiki vault CRUD
    wiki-graph.js           ← Graph build (full + incremental) + query
    wiki-extractor.js       ← Markdown content extractor
    wiki-index.js           ← Category index builder
    wiki-doctor.js          ← Vault health checker
    wiki-sync-links.js      ← Backlink synchronizer
    wiki-supplement.js      ← Corpus + prompt supplements (3-way fusion)
    digest-compiler.js      ← Compiled digest generator
    wiki-vector-index.js    ← P1: Vector index for wiki pages
    build-manifest.js       ← P2: File fingerprint tracking
    obsidian-cli.js         ← Obsidian CLI probe (optional)
  capture/
    sanitization.js         ← Envelope sludge detection
    policy.js               ← Recall query normalization
    prompt-defense.js       ← Prompt injection detection + escape
  dreaming/
    engine.js               ← Dreaming 3-phase sweep engine
    config.js               ← Dreaming config + source aliases
  hooks/
    auto-memory.js          ← Auto-recall hooks (agent_end)
  interop/
    memory-capability.js    ← Memory capability runtime
    public-artifacts.js     ← Public artifacts provider
    host-events.js          ← Host events manager
  doctor/
    cli.js                  ← Doctor CLI (schema validation + cleanup)
  state/
    plugin-state.js         ← openKeyedStore persistence
  migration/
    index.js                ← Legacy v0→v2 migration
```

---

## Tools (27)

### Memory Tools (10)

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory with embedding |
| `memory_recall` | Hybrid search (FTS + Vector + Lexical) |
| `memory_list` | List memories with filters |
| `memory_update` | Update an existing memory |
| `memory_archive` | Archive (soft-delete) a memory |
| `memory_promote` | Promote memory by updating metadata state/layer (default: confirmed/durable); does not write MEMORY.md |
| `memory_stats` | Memory statistics |
| `memory_debug` | Retrieval pipeline debug trace |
| `memory_migrate_legacy` | Migrate from legacy database |
| `memory_forget` | Permanently delete a memory |

### Wiki Tools (11)

| Tool | Description |
|------|-------------|
| `wiki_status` | Vault mode, health, vector index coverage, Obsidian CLI availability |
| `wiki_new` | Create new wiki entry with front matter |
| `wiki_get` | Read wiki entry by path or lookup term |
| `wiki_query` | Hybrid search: `keyword` (graph scoring) / `vector` (semantic) / `hybrid` (default, fused ranking) + optional `expandGraph` 1-hop references neighborhood |
| `wiki_traverse` | N-hop BFS graph expansion from a start node (depth/direction/edge-type filters, maxNodes cap, mtime-cached graph) |
| `wiki_path` | Shortest path between two wiki entries (BFS, reports unreachable honestly) |
| `wiki_search` | Semantic vector search over wiki_pages table (embedding similarity) |
| `wiki_build` | Build graph (incremental by default, `force:true` for full) + auto vector index update |
| `wiki_doctor` | Lint vault: broken links, stale graph, health + graph quality (isolated docs / tag coverage / hub centrality on references dimension) |
| `wiki_index` | Rebuild category indexes + main INDEX.md |
| `wiki_sync_links` | Synchronize backlinks across all entries |

### Working Memory（工作任务）Tools (6)

Per-agent task execution state in an independent `working_memory` table (no vectors, no dreaming sweep exposure). Tool factories bind `ctx.agentId` → `agent:<id>` lane: writes are lane-isolated, cross-lane reads allowed via explicit `scope`, and `crossAgentWriteAllowlist` (default `["main"]`) grants main-agent 代管 writes.

| Tool | Description |
|------|-------------|
| `memory_wm_get` | 查询本车道最新活动任务（或按 taskId / 跨车道只读 / yaml 输出） |
| `memory_wm_create` | 在本车道创建工作任务（wm-YYYY-MM-DD-topic） |
| `memory_wm_update` | 补丁式更新任务字段（status=completed/abandoned 自动写 completed_at） |
| `memory_wm_append` | 追加式更新数组字段（decisions/learnings/risks/artifacts 等，高频推荐） |
| `memory_wm_list` | 列出任务（默认本车道非归档；scope 跨车道只读；scopes=true 全车道概览） |
| `memory_wm_archive` | 归档任务（状态迁移为 archived，ARCHIVE-RULES 必填校验，仍可查询） |

The legacy `.working-memory/` file layer was fully retired on 2026-08-07: 48 task records across 8 agent lanes migrated into the table (file backup retained), and all agent core files were adapted to the `memory_wm_*` interface.

---

## Feature Matrix

### Enabled by Default

| Feature | Description |
|---------|-------------|
| **Hybrid Retrieval** | Three-way fusion: FTS (BM25, icu tokenizer) + Vector (cosine, native LanceDB) + Lexical (fallback). Sigmoid normalization for BM25 scores. |
| **Wiki Vector Search** | Independent `wiki_pages` table with full-page embedding. Three-way fusion: vector x0.5 + keyword x0.3 + graph x0.2. Graceful degradation when embedding unavailable. |
| **Wiki Incremental Build** | File fingerprint tracking (`build-manifest.json`, mtime + contentHash). Only re-extracts changed files. Dangling edge cleanup. No-change detection skips rebuild. |
| **Wiki Corpus Supplement** | Wiki search integrated into `memory_recall` pipeline via corpus supplement interface. |
| **access_count** | Recall access tracking with write-back. Feeds dreaming deep promotion quality scoring. |
| **Doctor CLI** | Schema validation + contamination cleanup (`openclaw doctor`). |
| **Host Interop** | Public artifacts provider + host events manager. |
| **Plugin State** | openKeyedStore persistence (fire-and-forget, honest degradation). |
| **Legacy Migration** | Automatic v0→v2 schema upgrade with skip-existing idempotency. |
| **Working Memory（工作任务）** | Independent `working_memory` table (no vectors). 6 `memory_wm_*` tools with per-agent lane isolation via tool-factory binding (`ctx.agentId` → `agent:<id>`). Archive = status migration with ARCHIVE-RULES required-field validation. One-shot migration script with dry-run + skipExisting idempotency. |

### Disabled by Default

| Feature | Description | Reason |
|---------|-------------|--------|
| **includeCompiledDigestPrompt** | Compiled wiki digest injected into prompt | Offline assessment pending. Enable via config `context.includeCompiledDigestPrompt: true`. |
| **Semantic Edge Inference** | LLM-powered semantic edges in wiki graph | Not implemented in TypeScript (graceful degradation). Use Python wiki_ops.py for semantic builds. |
| **Dreaming Engine** | Background dreaming process | Engine created but not started. Enable via config `dreaming.enabled: true`. |
| **Reflection Engine** | agent_end distiller producing reflection memories | Disabled by default (2026-09-02). Enable via config `reflection.enabled: true`. |
| **autoRecall** | Automatic memory recall at agent turn end | Disabled by default (schema default false). Enable via config `autoRecall: true`. |
| **Rerank** | External rerank provider | Requires additional config (`retrieval.rerankProvider`, `retrieval.rerankModel`, `retrieval.rerankBaseUrl`). |
| **Obsidian CLI** | Obsidian vault integration | Probe available but Obsidian not installed on this host. Auto-detects if installed. |

### Removed in v4

| Feature | Reason |
|---------|--------|
| **autoCapture / customTriggers** | Permanently removed per user decision. Redundant with agent-initiated `memory_store` / `/remember`. Capture library modules retained for recall path (policy/sanitization/prompt-defense). |

---

## Retrieval Pipeline

```
memory_recall("query")
  ├── FTS Search (BM25, icu tokenizer, sigmoid normalization)
  ├── Vector Search (cosine, native LanceDB vectorSearch)
  ├── Lexical Search (fallback, term frequency + exact match bonus)
  ├── Three-way Fusion (configurable weights)
  ├── Rerank (optional, external provider)
  └── Wiki Corpus Supplement
        ├── Vector Search (wiki_pages table, cosine)
        ├── Keyword Match (title + body)
        ├── Graph Query (graph.json node matching)
        └── Fusion: vector×0.5 + keyword×0.3 + graph×0.2
```

## Wiki Build Pipeline

```
wiki_build()                    ← Incremental by default
  ├── Load build-manifest.json
  ├── Scan vault fingerprints (mtime + contentHash)
  ├── Detect changes (added / modified / deleted / unchanged)
  ├── If no changes → skip rebuild
  ├── If changes:
  │     ├── Re-extract changed files only
  │     ├── Remove deleted/modified file nodes/edges
  │     ├── Merge with unchanged graph
  │     ├── Clean dangling edges
  │     ├── Deduplicate nodes
  │     ├── Detect communities
  │     ├── Export graph.json + GRAPH_REPORT.md + graph.html
  │     ├── Update digest
  │     └── Update vector index (wiki_pages)
  └── Save manifest

wiki_build({ force: true })     ← Full rebuild
  ├── Extract all files
  ├── Build graph from scratch
  ├── Clean dangling edges
  ├── Detect communities
  ├── Export all outputs
  ├── Compile digest
  ├── Rebuild vector index
  └── Save manifest
```

## Storage

| Table | Purpose | Schema |
|-------|---------|--------|
| `memories` | User memories | id, scope, content, embedding[2560], category, importance, createdAt, updatedAt, metadata |
| `wiki_pages` | Wiki vector index | id, path, title, content, embedding[2560], category, tags, updatedAt, metadata |
| `memory_assets` | Multimodal assets | id, memoryId, modality, mimeType, storagePath, ... |
| `working_memory` | Working-memory（工作任务）task state | id, task_id, scope (agent:<id> lane), goal, status, priority, plan/decisions/learnings/... (JSON), created_at, updated_at, completed_at, archived_at |

**Indexes**: BITMAP on `scope`/`category` (memories), BITMAP on `category` (wiki_pages), FTS on `content` (memories, icu tokenizer).

## Development

```bash
# Install
npm install

# Type check
npm run typecheck

# Test (279 tests)
npm test

# Integration tests
node scripts/test-wiki-vector-index.mjs
node scripts/test-wiki-incremental-build.mjs
```

### Adding a New Tool — Checklist（防遗漏）

1. Implement the module under `dist/wiki/` (or `dist/tools/`), following the existing hand-maintained dist convention (**do not** run `npm run build`).
2. Register the tool factory in `dist/tools/wiki-tools.js` (or the relevant tools file) inside `registerAll*`.
3. **Declare the tool name in `openclaw.plugin.json` → `contracts.tools`** — the host filters tools by this allowlist; a registered-but-undeclared tool is silently invisible to agents.
4. `node --check` every touched file, then run a functional test script against real data before restarting the gateway.
5. Restart the gateway and verify via a real tool call (not just registration logs).

> 教训来源（2026-08-08）：wiki_traverse/wiki_path/wiki_search 代码注册成功但未声明 contracts.tools，首轮重启后工具对 Agent 不可见，二次重启补登才上线。

## Configuration

```jsonc
{
  "plugins": {
    "entries": {
      "memory-lancedb-pro": {
        "config": {
          "dbPath": "path/to/lancedb",
          "tableName": "memories",
          "embeddingDimension": 2560,
          "connectionMode": "embedded",
          "retrieval": {
            "hybrid": true,
            "rerank": false
          },
          "vault": {
            "path": "path/to/wiki"
          },
          "context": {
            "includeCompiledDigestPrompt": false  // default: false
          },
          "hostInterop": {
            "enableArtifacts": true,
            "enableEvents": true
          },
          "dreaming": {
            "enabled": false  // default: false
          },
          "reflection": {
            "enabled": false  // default: false
          },
          "workingMemory": {
            "enabled": true,                      // default: true; false fully unloads memory_wm_* tools
            "tableName": "working_memory",
            "crossAgentWriteAllowlist": ["main"], // agents allowed to write other lanes (代管)
            "yamlFormatDefault": false
          }
        }
      }
    }
  }
}
```

## Agent Integration（核心文件接入指南）

安装插件后，工具本身不会自动改变 Agent 行为——Agent 启动时读取的是自己的核心文件（AGENTS.md / MEMORY.md / TOOLS.md 等）。要让 Agent 真正认知并使用 `memory_wm_*`（工作任务）工具，需要在其核心文件中加入引导信息。以下为最小接入片段（XML-first 风格，可按你的核心文件格式调整）：

### 1. 启动恢复（AGENTS.md session_startup）

```xml
<rule id="memory-restore">启动后优先恢复 MEMORY.md、memory/INDEX.md 等账本文件；并调用 memory_wm_get 恢复本车道最新活动任务（为空则无挂起）。</rule>
```

### 2. 状态写回路由（MEMORY.md writeback_routing）

```xml
<route type="runtime-status">复杂任务推进状态 → memory_wm_create / memory_wm_update / memory_wm_append（工厂自动绑定本车道，无需传 scope）</route>
<route type="execution-snapshot">任务收尾快照 → memory_wm_archive（状态迁移为 archived，仍可查询）</route>
```

### 3. 使用约定（建议写入 TOOLS.md quick_checklist 或 MEMORY.md）

- **taskId 格式**：`wm-YYYY-MM-DD-topic`（小写 kebab-case），车道内唯一
- **单活动任务约定**：每个车道同一时刻只维护一个活动复杂任务
- **append 优先**：数组字段（decisions/learnings/risks/artifacts/...）追加用 `memory_wm_append`；`memory_wm_update` 对数组是整体替换
- **同任务写操作必须串行**：对同一任务并行调用 append + update 会产生 read-modify-write 竞态（后写覆盖先写）
- **归档必填字段**：goal / outcome / decisions / learnings / artifacts；缺失时 `memory_wm_archive` 报错并列出缺失项
- **车道隔离**：写入自动限定本车道；跨车道只读用 `scope="agent:<id>"`；代管写由配置 `workingMemory.crossAgentWriteAllowlist`（默认 `["main"]`）控制

### 4. 离线留言模式（可选）

目标 Agent 实时会话不可达时，代管方可直接在其车道创建 `planned` 通知任务——对方下次启动执行 `memory_wm_get` 时必达。这是 memory_wm_* 内生的离线通信通道。

> 参考实例：本仓库作者的 8 个 Agent 已于 2026-08-07 完成全套核心文件适配（87 处精确替换），旧 `.working-memory/` 文件层彻底退役，48 条任务记录迁入 `working_memory` 表。

## Changelog

### 4.2.5 (2026-10-03)
- **OpenClaw 2026.9.7 host 兼容**（生产热修复回移植）：宿主事件改名 `tool_after_execute` → `after_tool_call`（修复记忆删除级联 / reflection 缓存失效钩子不触发）；`openKeyedStore` 缺失或信任拒绝（`PLUGIN_STATE_UNAVAILABLE` / `PLUGIN_TRUST_REFUSED`）时静默回退插件自有文件 keyed store（local-host-state-compat-v1），信任与权限姿态不变。

### 4.2.4 (2026-09-26)
- **store**：模块初始化时即 eager-load `@lancedb/lancedb`（生产热修复回移植），消除首次调用冷启动抖动。

### 4.2.3 (2026-09-24)
- **wiki**：honor config vault root（DV-1）；state-store 日志去歧义（DV-2）。

### 4.2.2 (2026-09)
- **pack**：manifest 纳入 `files`、真实 `npmSpec`、版本同步、prepack 校验；移除 3 个无版本号 lock 条目（修复 npm install `Invalid Version` 崩溃）。

### 4.2.1 (2026-09-02)
- **memory_promote 修复**：晋升只更新 LanceDB metadata（`metadata.layer` + `metadata.memory_layer` + `state`），不再写入 MEMORY.md managed block；durable 状态由 `memory_stats` 的 layer 统计体现。
- **默认开关**：`dreaming.enabled` 与 `reflection.enabled` 默认关闭（schema 与运行配置一致）。
- **测试对齐**：manifest 测试更新为 v4.2.1 / 27 tools。

## License

Apache-2.0
