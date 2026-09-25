/**
 * memory-lancedb-pro v3 Plugin Entry
 *
 * v3 changelog (from v2.0.0):
 * - Uses SDK definePluginEntry from openclaw/plugin-sdk/plugin-entry
 * - OpenClawPluginApi type for type-safe register(api)
 * - peerDeps: >=2026.5.6
 * - hooks.timeoutMs: 60000 in manifest
 * - contracts.tools declared in openclaw.plugin.json (17 tools)
 * - Phase 2: Type-safe tool types in src/tools/types.ts
 *
 * All business logic preserved from v2.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { resolveConfig } from './config/resolve-config.js';
import { resolveMemoryBackendConfig } from './config/resolve-backend-config.js';

// Tool registration
import { registerAllMemoryTools, initializeToolContext, getStore, getPluginConfig, getBackendConfig } from './tools/register.js';

// Interop imports
import { createMemoryCapabilityRuntime } from './interop/memory-capability.js';
import { createPublicArtifactsProvider } from './interop/public-artifacts.js';
import { createHostEventsManager } from './interop/host-events.js';

// Wiki supplement imports
import { createWikiCorpusSupplement, createWikiPromptSectionBuilder } from './wiki/wiki-supplement.js';

// Wiki vault root injection (DV-1 fix, 4.2.3)
import { configureWikiRoot } from './wiki/wiki-store.js';

// Wiki CLI registration
import { registerWikiCli } from './wiki/wiki-command.js';

// Phase 3: Plugin state persistence (openKeyedStore)
import { initPluginState, setStats, isStateActive, isStateFallbackMode } from './state/plugin-state.js';

// M2: Auto-memory hooks (capture/recall)
import { registerAutoMemoryHooks } from './hooks/auto-memory.js';

// M4: Dreaming engine
import { createDreamingEngine } from './dreaming/engine.js';

// M5: Doctor CLI registration
import { registerDoctorCli } from './doctor/cli.js';

/**
 * Plugin metadata
 */
const id = 'memory-lancedb-pro';
const name = 'Memory LanceDB Pro';
const description = 'Capability-first LanceDB memory plugin with hybrid retrieval, wiki tools, and host interop (v3)';

/**
 * Internal state for capability runtime.
 */
let _capabilityRuntime = null;
let _eventsManager = null;
let _promptBuilder = null;
let _initialized = false;

/**
 * OpenClaw plugin registration.
 */
function register(api) {
    if (_initialized) {
        registerAllMemoryTools(api.registerTool, {
            enableManagementTools: true,
            enableAliases: true,
        });
        if (api.registerMemoryCapability && _capabilityRuntime) {
            const primaryWorkspaceRoot = api.config?.agents?.defaults?.workspace ?? process.cwd();
            const publicArtifactsProvider = createPublicArtifactsProvider(primaryWorkspaceRoot);
            api.registerMemoryCapability({
                runtime: _capabilityRuntime,
                publicArtifacts: publicArtifactsProvider,
                promptBuilder: _promptBuilder ?? undefined,
            });
        }
        return;
    }
    _initialized = true;

    const rawConfig = api.pluginConfig;
    const config = resolveConfig(rawConfig);
    const backendConfig = resolveMemoryBackendConfig(config);

    // DV-1 fix (4.2.3): the wiki storage layer must honor the configured vault root.
    // resolveConfig already implements the priority chain
    // config.vault.path > env WIKI_ROOT/OPENCLAW_WIKI_ROOT > default $HOME/.openclaw/wiki;
    // injecting it here makes it the single source for every wiki module (live bindings).
    configureWikiRoot(config.vault?.path);

    api.logger.info('[memory-lancedb-pro] capability-ready (v3 / Phase 2)');
    api.logger.info(`  dbPath: ${backendConfig.dbPath}`);
    api.logger.info(`  connectionMode: ${backendConfig.connectionMode}`);
    api.logger.info(`  tableName: ${backendConfig.tableName}`);
    api.logger.info(`  embeddingDimension: ${backendConfig.embeddingDimension}`);
    api.logger.info(`  retrieval.hybrid: ${config.retrieval.hybrid}`);
    api.logger.info(`  retrieval.rerank: ${config.retrieval.rerank}`);
    api.logger.info(`  hostInterop.enableArtifacts: ${config.hostInterop.enableArtifacts}`);
    api.logger.info(`  hostInterop.enableEvents: ${config.hostInterop.enableEvents}`);
    api.logger.info(`  vault.path: ${config.vault?.path ?? 'default'}`);

    registerAllMemoryTools(api.registerTool, {
        enableManagementTools: true,
        enableAliases: true,
    });
    api.logger.info('[memory-lancedb-pro] memory tools registered');

    void initializeToolContext({ config, backendConfig });
    const primaryWorkspaceRoot = api.config?.agents?.defaults?.workspace ?? process.cwd();
    api.logger.info(`[memory-lancedb-pro] workspace root resolved: ${primaryWorkspaceRoot}`);

    // Wiki supplements
    try {
        _promptBuilder = createWikiPromptSectionBuilder(config);
        if (api.registerMemoryPromptSupplement) {
            api.registerMemoryPromptSupplement(_promptBuilder);
            api.logger.info('[memory-lancedb-pro] wiki prompt supplement registered');
        }
        if (api.registerMemoryCorpusSupplement) {
            const corpusSupplement = createWikiCorpusSupplement({ config, appConfig: api.config });
            api.registerMemoryCorpusSupplement(corpusSupplement);
            api.logger.info('[memory-lancedb-pro] wiki corpus supplement registered');
        }
    } catch (error) {
        api.logger.error?.(`[memory-lancedb-pro] failed to register wiki supplements: ${error}`);
    }

    // Wiki CLI
    if (api.registerCli) {
        try {
            api.registerCli(({ program }) => {
                registerWikiCli(program, config, api.config);
            }, {
                descriptors: [{
                    name: 'wiki',
                    description: 'Inspect and initialize the memory wiki vault',
                    hasSubcommands: true,
                }],
            });
            api.logger.info('[memory-lancedb-pro] wiki CLI registered');
        } catch (error) {
            api.logger.error?.(`[memory-lancedb-pro] failed to register wiki CLI: ${error}`);
        }
    }

    // M5: Doctor CLI
    if (api.registerCli) {
        try {
            api.registerCli(({ program }) => {
                registerDoctorCli(program, config, api.config);
            }, {
                descriptors: [{
                    name: 'doctor',
                    description: 'Memory LanceDB Pro doctor — schema validation & contamination cleanup',
                    hasSubcommands: true,
                }],
            });
            api.logger.info('[memory-lancedb-pro] doctor CLI registered');
        } catch (error) {
            api.logger.error?.(`[memory-lancedb-pro] failed to register doctor CLI: ${error}`);
        }
    }

    // Capability runtime
    try {
        _capabilityRuntime = createMemoryCapabilityRuntime({ config });
        api.logger.info('[memory-lancedb-pro] capability runtime created');
        if (api.registerMemoryCapability) {
            const publicArtifactsProvider = createPublicArtifactsProvider(primaryWorkspaceRoot);
            api.registerMemoryCapability({
                runtime: _capabilityRuntime,
                publicArtifacts: publicArtifactsProvider,
                promptBuilder: _promptBuilder ?? undefined,
            });
            api.logger.info('[memory-lancedb-pro] memory capability registered with host');
        }
    } catch (error) {
        api.logger.error?.(`[memory-lancedb-pro] failed to create capability runtime: ${error}`);
        _capabilityRuntime = null;
    }

    // Host events
    if (config.hostInterop.enableEvents) {
        try {
            _eventsManager = createHostEventsManager({ eventsDir: `${primaryWorkspaceRoot}/memory/events` });
            api.logger.info('[memory-lancedb-pro] host events manager created');
        } catch (error) {
            api.logger.error?.(`[memory-lancedb-pro] failed to create events manager: ${error}`);
            _eventsManager = null;
        }
    }

    api.logger.info(`[memory-lancedb-pro] interop status: ${JSON.stringify({
        capability: _capabilityRuntime !== null,
        events: _eventsManager !== null,
        vaultRoot: primaryWorkspaceRoot,
    })}`);

    // Phase 3: Initialize persistent state (fire-and-forget, non-blocking)
    void initPluginState(api, { fallbackDir: backendConfig.dbPath }).then((stateOk) => {
        if (stateOk) {
            // DV-2 fix (4.2.3): report the actual active mode instead of always claiming openKeyedStore.
            const stateMode = isStateFallbackMode() ? 'file-fallback' : 'openKeyedStore';
            api.logger.info(`[memory-lancedb-pro] state store active (${stateMode})`);
            void setStats({
                dbPath: backendConfig.dbPath,
                tableName: backendConfig.tableName,
                connectionMode: backendConfig.connectionMode,
                embeddingDimension: backendConfig.embeddingDimension,
                registeredAt: Date.now(),
            });
        }
    }).catch((error) => {
        api.logger.warn?.(`[memory-lancedb-pro] state store unavailable: ${error.message}`);
    });

    // M2: Register auto-memory hooks (capture/recall)
    // Probe api.on availability before registering (defensive)
    if (typeof api.on === 'function') {
        try {
            const embeddingConfig = config.embedding ?? {};
            const embeddingDimension = config.embeddingDimension ?? 2560;

            // Lazy embedder wrapper for hooks (embedMultimodal is sync-importable)
            const hookEmbedder = {
                async embed(text) {
                    const { embedMultimodal } = await import('./retrieval/embedder.js');
                    const result = await embedMultimodal({ text }, { ...embeddingConfig, dimension: embeddingDimension });
                    return result.embedding;
                },
            };

            // Lazy store getter — waits for tool context initialization
            const hookStoreGetter = () => getStore();
            const hookEmbedderGetter = () => hookEmbedder;

            registerAutoMemoryHooks(api, {
                getStore: hookStoreGetter,
                getEmbedder: hookEmbedderGetter,
                pluginConfig: rawConfig,
            });
        } catch (error) {
            api.logger.warn?.(`[memory-lancedb-pro] auto-memory hooks not registered: ${error}`);
        }
    } else {
        api.logger.info?.('[memory-lancedb-pro] api.on not available, auto-memory hooks skipped');
    }

    // M4: Initialize dreaming engine (lazy, zero overhead when disabled)
    try {
        const dreamingEngine = createDreamingEngine({
            store: {
                list: async (scopes, category, limit, offset) => {
                    const db = getStore();
                    if (!db) return [];
                    // Adapt to our store API
                    if (db.listEntries) return db.listEntries(scopes, category, limit, offset);
                    return [];
                },
                fetchForCompaction: async (beforeTimestamp, scopes, limit) => {
                    const db = getStore();
                    if (!db || !db.fetchForCompaction) return [];
                    return db.fetchForCompaction(beforeTimestamp, scopes, limit);
                },
                patchMetadata: async (id, patch, scopes) => {
                    const db = getStore();
                    if (!db) return null;
                    if (db.patchMetadata) return db.patchMetadata(id, patch, scopes);
                    return null;
                },
                update: async (id, updates, scopes) => {
                    const db = getStore();
                    if (!db) return null;
                    if (db.update) return db.update(id, updates, scopes);
                    return null;
                },
                store: async (entry) => {
                    const db = getStore();
                    if (!db) return null;
                    return db.store(entry.scope ?? 'default', entry);
                },
                stats: async (scopes) => {
                    const db = getStore();
                    if (!db || !db.stats) return { totalCount: 0, scopeCounts: {} };
                    return db.stats(scopes);
                },
            },
            embedder: {
                async embed(text) {
                    const { embedMultimodal } = await import('./retrieval/embedder.js');
                    const embConfig = config.embedding ?? {};
                    const result = await embedMultimodal({ text }, { ...embConfig, dimension: config.embeddingDimension ?? 2560 });
                    return result.embedding;
                },
            },
            config: rawConfig?.dreaming,
            logger: api.logger,
        });

        if (dreamingEngine.config.enabled) {
            dreamingEngine.start();
            api.logger.info?.(`[memory-lancedb-pro] dreaming engine started (frequency=${dreamingEngine.config.frequency}, timezone=${dreamingEngine.config.timezone})`);
        } else {
            api.logger.info?.('[memory-lancedb-pro] dreaming engine created (disabled, zero overhead)');
        }
    } catch (error) {
        api.logger.warn?.(`[memory-lancedb-pro] dreaming engine not initialized: ${error}`);
    }
}

function getCapability() { return _capabilityRuntime; }
function getEvents() { return _eventsManager; }

export default definePluginEntry({ id, name, description, register });

// ── Exports (preserved from v2) ──
export { DEFAULT_CONFIG } from './config/schema.js';
export { resolveConfig } from './config/resolve-config.js';
export { resolveMemoryBackendConfig } from './config/resolve-backend-config.js';
export { resolveAssetStoreConfig, createAssetStore, initializeAssetStore, getAssetStore, closeAssetStore } from './store/asset-store.js';
export { CURRENT_SCHEMA_VERSION, LATEST_SCHEMA_VERSION, MIGRATION_CAPABILITIES, createMigrationManager, createLegacyMigrationManager, createLegacyMigrator } from './store/migrations.js';
export { LegacyMigrator, findLegacyDatabase, readLegacyEntries, mapLegacyToV2, migrateFromLegacy } from './migration/index.js';
export { createMemoryCapabilityRuntime, getMemoryCapabilityRuntime, getMemorySearchManager, resolveBackendConfigForCapability, createAndInitializeMemoryCapability } from './interop/memory-capability.js';
export { ARTIFACT_PATHS, listPublicArtifacts, hasStandardArtifacts, getArtifactContent, createPublicArtifactsProvider } from './interop/public-artifacts.js';
export { ALLOWED_EVENT_TYPES, isValidEventType, createHostEventsManager, createRecallRecordedEvent, createPromotionAppliedEvent } from './interop/host-events.js';
export { getCapability, getEvents };

// M2: Policy/Prompt-Defense exports (capture removed 2026-08-04)
export { looksLikeEnvelopeSludge, dropMediaNoteLines } from './capture/sanitization.js';
export { normalizeRecallQuery, extractLatestUserText, DEFAULT_RECALL_MAX_CHARS } from './capture/policy.js';
export { looksLikePromptInjection, escapeMemoryForPrompt, formatRelevantMemoriesContext, cleanMemorySearchResults } from './capture/prompt-defense.js';
export { registerAutoMemoryHooks, resolveHookConfig, isMemorySubSession } from './hooks/auto-memory.js';

// M4: Dreaming engine exports
export { createDreamingEngine, normalizeDreamingConfig, parseDailyCron, computeNextDreamingDelayMs, DEFAULT_DREAMING_CONFIG } from './dreaming/engine.js';
export { DREAMING_SOURCE_ALIASES, STORED_MEMORY_SOURCES, VALID_DREAMING_SOURCE_FILTERS } from './dreaming/config.js';

export * from './wiki/index.js';
