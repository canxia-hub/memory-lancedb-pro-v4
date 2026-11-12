/**
 * Tool Registration - Minimal Implementation
 *
 * Phase 2+5 wiring - wraps tool functions into AgentTool format.
 * Uses plain JSON Schema for parameters (no TypeBox dependency).
 */
// Import tool functions and types
import { memoryStore, memoryList, initializeStoreTool, closeStoreTool, } from "./store.js";
import { memoryRecall, initializeRecallTool, closeRecallTool, } from "./recall.js";
import { memoryUpdate, } from "./update.js";
import { memoryArchive, } from "./archive.js";
import { memoryPromote, } from "./promote.js";
import { memoryStats, memoryDebug, } from "./diagnostics.js";
import { createLegacyMigrationManager, } from "../store/migrations.js";
// Wiki tools (Phase W4)
import { registerAllWikiTools, setWikiToolConfigGetter } from "./wiki-tools.js";
// Working-memory（工作任务）tools (v4.1: file-layer internalization)
import { registerWmTools } from "./wm-tools.js";
import { initializeWorkingMemoryStore, closeWorkingMemoryStore } from "../store/working-memory-store.js";
import { createLanceDBStore } from "../store/lancedb-store.js";
import { createSearchManager } from "../retrieval/search-manager.js";
import { initializeAssetStore, closeAssetStore } from "../store/asset-store.js";
/**
 * Internal state for tool execution.
 */
let _store = null;
let _searchManager = null;
let _config = null;
let _backendConfig = null;
let _toolContext = null;
let _toolContextInitPromise = null;
let _legacyMigrationManager = null;
/**
 * Initialize tool context (called by plugin register).
 */
export function configureToolContext(context) {
    _toolContext = context;
    _config = context.config;
    _backendConfig = context.backendConfig;
}
export async function initializeToolContext(context) {
    _toolContext = context;
    _config = context.config;
    _backendConfig = context.backendConfig;
    if (_toolContextInitPromise) return _toolContextInitPromise;
    if (_store && _searchManager) return;
    _toolContextInitPromise = (async () => {
        // CRITICAL FIX: Create ONE shared store instance
        _store = createLanceDBStore(context.backendConfig);
        await _store.initialize();
        // CRITICAL FIX: Pass shared store to search manager to avoid data isolation
        _searchManager = createSearchManager(context.config, context.backendConfig, _store);
        await _searchManager.initialize();
        // CRITICAL FIX: Pass shared store to tool modules to ensure same data source
        await initializeStoreTool(context.config, _store);
        await initializeRecallTool(context.config, _store);
        // Phase C: Initialize asset store
        await initializeAssetStore(context.backendConfig);
        // v4.1: Initialize working-memory store (灰度：enabled=false 时跳过)
        if (context.config?.workingMemory?.enabled !== false) {
            await initializeWorkingMemoryStore(context.backendConfig, context.config);
        }
    })().catch(async (error) => {
        try {
            await closeRecallTool();
            await closeStoreTool();
            await closeAssetStore();
            if (_searchManager) {
                await _searchManager.close();
            }
            if (_store) {
                await _store.close();
            }
        }
        finally {
            _searchManager = null;
            _store = null;
            _config = context.config;
            _backendConfig = context.backendConfig;
            _toolContext = context;
        }
        throw error;
    }).finally(() => {
        _toolContextInitPromise = null;
    });
    return _toolContextInitPromise;
}
export async function ensureToolContextReady() {
    if (_toolContextInitPromise) return _toolContextInitPromise;
    if (_store && _searchManager) {
        return;
    }
    if (!_toolContext) {
        throw new Error('Tool context not configured');
    }
    await initializeToolContext(_toolContext);
}
/**
 * Close tool context (called by plugin reload/cleanup).
 */
export async function closeToolContext() {
    if (_toolContextInitPromise) await _toolContextInitPromise.catch(() => {});
    await closeRecallTool();
    await closeStoreTool();
    // Phase C: Close asset store
    await closeAssetStore();
    // v4.1: Close working-memory store
    await closeWorkingMemoryStore();
    if (_searchManager) {
        await _searchManager.close();
        _searchManager = null;
    }
    if (_store) {
        await _store.close();
        _store = null;
    }
    _config = null;
    _backendConfig = null;
    _toolContext = null;
    _toolContextInitPromise = null;
    _legacyMigrationManager = null;
}

/**
 * Get the shared store instance (for hooks and other internal consumers).
 * Returns null if not yet initialized.
 */
export function getStore() { return _store; }

/**
 * Get the shared search manager instance (for hooks and other internal consumers).
 * Returns null if not yet initialized.
 */
export function getSearchManager() { return _searchManager; }

/**
 * Get the current plugin config (for hooks and other internal consumers).
 * Returns null if not yet initialized.
 */
export function getPluginConfig() { return _config; }

/**
 * Get the current backend config (for hooks and other internal consumers).
 * Returns null if not yet initialized.
 */
export function getBackendConfig() { return _backendConfig; }

function getLegacyMigrationManager() {
    if (!_legacyMigrationManager) {
        _legacyMigrationManager = createLegacyMigrationManager();
    }
    return _legacyMigrationManager;
}
function coerceToolParams(args) {
    const [firstArg, secondArg] = args;
    const candidate = typeof firstArg === 'string' && secondArg !== undefined ? secondArg : firstArg;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        return candidate;
    }
    return {};
}
function adaptToolForHost(tool) {
    return {
        ...tool,
        execute: (async (...args) => {
            const params = coerceToolParams(args);
            return tool.execute(params);
        }),
    };
}
// ============================================================================
// Tool Schemas (plain JSON Schema objects)
// ============================================================================
const memoryStoreSchema = {
    type: "object",
    properties: {
        text: { type: "string", description: "Memory content to store" },
        scope: { type: "string", description: "Memory scope (optional)" },
        category: {
            type: "string",
            enum: ["preference", "fact", "decision", "entity", "reflection", "other"],
            description: "Memory category",
        },
        importance: { type: "number", minimum: 0, maximum: 1, description: "Importance score (0-1)" },
        // Phase C multimodal fields
        sourceType: {
            type: "string",
            enum: ["text", "image", "audio", "video", "file", "compound"],
            description: "Source type (multimodal)",
        },
        sourceRef: { type: "string", description: "Source reference path or URL (multimodal)" },
        assets: {
            type: "array",
            description: "Asset records to attach (multimodal)",
            items: {
                type: "object",
                properties: {
                    modality: { type: "string", enum: ["image", "audio", "video", "file"], description: "Asset modality" },
                    mimeType: { type: "string", description: "MIME type" },
                    storagePath: { type: "string", description: "Storage path" },
                    sha256: { type: "string", description: "SHA256 hash (optional)" },
                    sizeBytes: { type: "number", description: "Size in bytes (optional)" },
                    caption: { type: "string", description: "Caption/description (optional)" },
                    ocrText: { type: "string", description: "OCR text (optional)" },
                    transcript: { type: "string", description: "Transcript (optional)" },
                    summary: { type: "string", description: "Summary (optional)" },
                },
                required: ["modality", "mimeType", "storagePath"],
            },
        },
    },
    required: ["text"],
};
const memoryListSchema = {
    type: "object",
    properties: {
        scope: { type: "string", description: "Filter by scope" },
        category: { type: "string", description: "Filter by category" },
        limit: { type: "number", minimum: 1, maximum: 100, description: "Max results" },
        offset: { type: "number", minimum: 0, description: "Offset for pagination" },
    },
};
const memoryRecallSchema = {
    type: "object",
    properties: {
        query: { type: "string", description: "Search query" },
        scope: { type: "string", description: "Filter by scope" },
        category: { type: "string", description: "Filter by category" },
        limit: { type: "number", minimum: 1, maximum: 20, description: "Max results" },
        minScore: { type: "number", minimum: 0, maximum: 1, description: "Minimum relevance score" },
    },
    required: ["query"],
};
const memoryUpdateSchema = {
    type: "object",
    properties: {
        memoryId: { type: "string", description: "Memory ID to update" },
        text: { type: "string", description: "New content" },
        scope: { type: "string", description: "New scope" },
        category: { type: "string", description: "New category" },
        importance: { type: "number", minimum: 0, maximum: 1, description: "New importance" },
        scopeFilter: { type: "string", description: "Scope filter for lookup" },
        // Phase C multimodal fields
        sourceType: {
            type: "string",
            enum: ["text", "image", "audio", "video", "file", "compound"],
            description: "New source type (multimodal)",
        },
        sourceRef: { type: "string", description: "New source reference (multimodal)" },
        appendAssets: {
            type: "array",
            description: "Assets to append (multimodal)",
            items: {
                type: "object",
                properties: {
                    modality: { type: "string", enum: ["image", "audio", "video", "file"], description: "Asset modality" },
                    mimeType: { type: "string", description: "MIME type" },
                    storagePath: { type: "string", description: "Storage path" },
                    sha256: { type: "string", description: "SHA256 hash (optional)" },
                    sizeBytes: { type: "number", description: "Size in bytes (optional)" },
                    caption: { type: "string", description: "Caption (optional)" },
                    ocrText: { type: "string", description: "OCR text (optional)" },
                    transcript: { type: "string", description: "Transcript (optional)" },
                    summary: { type: "string", description: "Summary (optional)" },
                },
                required: ["modality", "mimeType", "storagePath"],
            },
        },
    },
    required: ["memoryId"],
};
const memoryArchiveSchema = {
    type: "object",
    properties: {
        memoryId: { type: "string", description: "Memory ID to archive/delete" },
        hard: { type: "boolean", description: "True for permanent delete, false for soft archive (not supported)" },
        query: { type: "string", description: "Search query to find memory if ID not provided" },
        scope: { type: "string", description: "Scope filter for query search" },
    },
};
const memoryPromoteSchema = {
    type: "object",
    properties: {
        memoryId: { type: "string", description: "Memory ID to promote" },
        layer: { type: "string", enum: ["durable", "working", "reflection", "archive"], description: "Target layer" },
        state: { type: "string", enum: ["pending", "confirmed", "archived"], description: "Target state" },
        query: { type: "string", description: "Search query if ID not provided" },
        scope: { type: "string", description: "Scope filter for query" },
    },
};
const memoryStatsSchema = {
    type: "object",
    properties: {
        scope: { type: "string", description: "Filter by scope" },
    },
};
const memoryDebugSchema = {
    type: "object",
    properties: {
        query: { type: "string", description: "Search query to debug" },
        scope: { type: "string", description: "Scope filter" },
        mode: { type: "string", enum: ["pipeline", "rank", "full"], description: "Debug output mode" },
        limit: { type: "number", minimum: 1, maximum: 20, description: "Max results" },
    },
    required: ["query"],
};
const memoryMigrateLegacySchema = {
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: ["probe", "dry-run", "migrate", "verify"],
            description: "Legacy memory action: probe source DB, dry-run migration, migrate, or verify results",
        },
        sourceDbPath: { type: "string", description: "Legacy database path (optional)" },
        targetDbPath: { type: "string", description: "Target v2 database path (optional, defaults to plugin dbPath)" },
        targetTableName: { type: "string", description: "Target table name (optional, defaults to plugin tableName)" },
        defaultScope: { type: "string", description: "Fallback scope for migrated records (optional)" },
        batchSize: { type: "number", minimum: 1, maximum: 500, description: "Batch size for migration (optional)" },
        skipExisting: { type: "boolean", description: "Use skip-existing mode during migrate" },
    },
    required: ["action"],
};
// ============================================================================
// Tool Definitions
// ============================================================================
/**
 * Create memory_store tool.
 */
function createMemoryStoreTool() {
    return {
        name: "memory_store",
        description: "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information.",
        parameters: memoryStoreSchema,
        execute: async (params) => {
            await ensureToolContextReady();
            const input = params;
            const result = await memoryStore(input);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
/**
 * Create memory_list tool.
 */
function createMemoryListTool() {
    return {
        name: "memory_list",
        description: "List recent memories with optional filtering by scope and category.",
        parameters: memoryListSchema,
        execute: async (params) => {
            await ensureToolContextReady();
            const options = params;
            const result = await memoryList(options);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
/**
 * Create memory_recall tool.
 */
function createMemoryRecallTool() {
    return {
        name: "memory_recall",
        description: "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: memoryRecallSchema,
        execute: async (params) => {
            await ensureToolContextReady();
            const options = params;
            const result = await memoryRecall(options);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
/**
 * Create memory_update tool.
 */
function createMemoryUpdateTool() {
    return {
        name: "memory_update",
        description: "Update an existing memory. For preferences/entities, changing text creates a new version (supersede) to preserve history.",
        parameters: memoryUpdateSchema,
        execute: async (params) => {
            await ensureToolContextReady();
            const input = params;
            const result = await memoryUpdate(input);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
/**
 * Create memory_archive tool.
 */
function createMemoryArchiveTool() {
    return {
        name: "memory_archive",
        description: "Permanently delete a memory record. In the v2 first release, soft archive is not implemented; use hard=true for actual deletion.",
        parameters: memoryArchiveSchema,
        execute: async (params) => {
            await ensureToolContextReady();
            const input = params;
            const result = await memoryArchive(input);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
/**
 * Create memory_forget tool (alias for memory_archive with hard=true).
 */
function createMemoryForgetTool() {
    return {
        name: "memory_forget",
        description: "Permanently delete a memory (alias for memory_archive with hard=true).",
        parameters: {
            type: "object",
            properties: {
                memoryId: { type: "string", description: "Memory ID to permanently delete" },
                query: { type: "string", description: "Search query to find memory if ID not provided" },
                scope: { type: "string", description: "Scope filter for query search" },
            },
        },
        execute: async (params) => {
            await ensureToolContextReady();
            const input = params;
            const result = await memoryArchive({ ...input, hard: true });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
/**
 * Create memory_promote tool.
 */
function createMemoryPromoteTool() {
    return {
        name: "memory_promote",
        description: "Apply a memory state/layer transition and append a content-free promotion audit; never writes memory content to MEMORY.md.",
        parameters: memoryPromoteSchema,
        execute: async (params) => {
            await ensureToolContextReady();
            const input = params;
            const result = await memoryPromote(input);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
/**
 * Create memory_stats tool.
 */
function createMemoryStatsTool() {
    return {
        name: "memory_stats",
        description: "Get statistics about memory usage, scopes, and categories.",
        parameters: memoryStatsSchema,
        execute: async (params) => {
            await ensureToolContextReady();
            const input = params;
            const result = await memoryStats(input);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
/**
 * Create memory_debug tool.
 */
function createMemoryDebugTool() {
    return {
        name: "memory_debug",
        description: "Debug memory retrieval with pipeline trace and rank explanation.",
        parameters: memoryDebugSchema,
        execute: async (params) => {
            await ensureToolContextReady();
            const input = params;
            const result = await memoryDebug(input);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
function createMemoryMigrateLegacyTool() {
    return {
        name: "memory_migrate_legacy",
        description: "Probe, migrate, or verify the legacy memory-lancedb-pro database so the v2 plugin can read historical memories.",
        parameters: memoryMigrateLegacySchema,
        execute: async (params) => {
            const input = params;
            const manager = getLegacyMigrationManager();
            const targetDbPath = input.targetDbPath ?? _backendConfig?.dbPath;
            const targetTableName = input.targetTableName ?? _backendConfig?.tableName ?? 'memories';
            const defaultScope = input.defaultScope ?? _config?.defaultScope ?? 'default';
            let result;
            switch (input.action) {
                case 'probe':
                    result = await manager.probe();
                    break;
                case 'dry-run':
                    result = await manager.migrate({
                        mode: 'dry-run',
                        sourceDbPath: input.sourceDbPath,
                        targetDbPath,
                        targetTableName,
                        defaultScope,
                        batchSize: input.batchSize,
                    });
                    break;
                case 'migrate':
                    result = await manager.migrate({
                        mode: input.skipExisting ? 'skip-existing' : 'run',
                        sourceDbPath: input.sourceDbPath,
                        targetDbPath,
                        targetTableName,
                        defaultScope,
                        batchSize: input.batchSize,
                    });
                    break;
                case 'verify': {
                    if (!targetDbPath) {
                        throw new Error('Target database path is unavailable for verify');
                    }
                    const probe = await manager.probe();
                    if (!probe.found || !probe.sourceDbPath) {
                        result = {
                            valid: false,
                            sourceCount: 0,
                            targetCount: 0,
                            matchedSamples: 0,
                            mismatchedSamples: [{ id: 'probe', issue: 'Legacy database not found' }],
                        };
                    }
                    else {
                        result = await manager.verify(input.sourceDbPath ?? probe.sourceDbPath, targetDbPath, targetTableName);
                    }
                    break;
                }
                default:
                    throw new Error(`Unsupported legacy migration action: ${input.action}`);
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    };
}
// ============================================================================
// Registration Functions
// ============================================================================
/**
 * Register all memory tools with OpenClaw.
 *
 * @param registerTool - OpenClaw registerTool function
 * @param options - Registration options
 */
export function registerAllMemoryTools(registerTool, options = {}) {
    const registerCompatibleTool = (tool, opts) => {
        registerTool(adaptToolForHost(tool), opts);
    };
    // Core tools (always registered)
    registerCompatibleTool(createMemoryStoreTool());
    registerCompatibleTool(createMemoryRecallTool());
    registerCompatibleTool(createMemoryListTool());
    registerCompatibleTool(createMemoryUpdateTool());
    registerCompatibleTool(createMemoryArchiveTool());
    // Management tools (optional)
    if (options.enableManagementTools) {
        registerCompatibleTool(createMemoryPromoteTool());
        registerCompatibleTool(createMemoryStatsTool());
        registerCompatibleTool(createMemoryDebugTool());
        registerCompatibleTool(createMemoryMigrateLegacyTool());
    }
    // Legacy aliases (optional, will be removed in future)
    if (options.enableAliases) {
        registerCompatibleTool(createMemoryForgetTool());
    }
    // Wiki tools (Phase W4)
    registerAllWikiTools(registerCompatibleTool);
    setWikiToolConfigGetter(() => _config);
    // Working-memory（工作任务）tools (v4.1): per-agent 工厂绑定车道，config 未就绪或 enabled=false 时工厂返回 null
    registerWmTools(registerTool, {
        getConfig: () => _config,
        adapt: adaptToolForHost,
    });
}
//# sourceMappingURL=register.js.map
