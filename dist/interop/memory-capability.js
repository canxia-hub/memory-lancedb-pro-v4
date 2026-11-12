/**
 * Memory Capability Registration
 *
 * Host-facing runtime bridge for shared search + status consumers.
 *
 * IMPORTANT CONTRACTS:
 * - getMemorySearchManager(params) => Promise<{ manager, error }>
 * - resolveMemoryBackendConfig(params) => backend summary object
 * - closeAllMemorySearchManagers() supported for host cleanup
 */
import { resolveMemoryBackendConfig } from '../config/resolve-backend-config.js';
import { initializeToolContext, getSearchManager } from '../tools/register.js';
let _runtime = null;
let _config = null;
let _backendConfig = null;
let _searchManager = null;
export function createMemoryCapabilityRuntime(options) {
    _config = options.config;
    _backendConfig = options.backendConfig ?? resolveMemoryBackendConfig(options.config);
    _searchManager = null;
    let _initialized = false;
    async function ensureInitialized() {
        if (_initialized) {
            return;
        }
        await initializeToolContext({ config: _config, backendConfig: _backendConfig });
        _searchManager = getSearchManager();
        if (!_searchManager) throw new Error('Shared search manager not created');
        _initialized = true;
    }
    const runtime = {
        async getMemorySearchManager() {
            try {
                await ensureInitialized();
                return {
                    manager: _searchManager,
                };
            }
            catch (error) {
                return {
                    manager: null,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        },
        resolveMemoryBackendConfig() {
            return {
                backend: 'builtin',
                citations: false,
                custom: _backendConfig ? {
                    pluginId: 'memory-lancedb-pro-v2',
                    dbPath: _backendConfig.dbPath,
                    tableName: _backendConfig.tableName,
                    connectionMode: _backendConfig.connectionMode,
                } : undefined,
            };
        },
        async closeAllMemorySearchManagers() {
            if (!_searchManager || !_initialized) {
                return;
            }
            await _searchManager.close();
            _initialized = false;
        },
        async getCapabilityStatus() {
            const managerResult = await runtime.getMemorySearchManager();
            const searchStatus = managerResult.manager
                ? await managerResult.manager.status()
                : {
                    ready: false,
                    store: {
                        connected: false,
                        dbPath: _backendConfig?.dbPath ?? '',
                        tableName: _backendConfig?.tableName ?? '',
                        totalRecords: 0,
                    },
                    retrieval: {
                        lexicalAvailable: false,
                        vectorAvailable: false,
                        hybridAvailable: false,
                        embeddingAvailable: false,
                    },
                    embedding: {
                        hasProvider: false,
                        isFunctional: false,
                    },
                    vector: {
                        hasVectorColumn: false,
                        hasPopulatedVectors: false,
                    },
                    rerank: {
                        hasRerankModule: true,
                        hasRerankProvider: false,
                        isFunctional: false,
                        unavailableReason: managerResult.error ?? 'Search manager unavailable',
                    },
                    config: {
                        hybrid: _config?.retrieval?.hybrid ?? false,
                        rerank: _config?.retrieval?.rerank ?? false,
                        defaultScope: _config?.defaultScope ?? 'default',
                    },
                };
            return {
                capabilityId: 'memory-lancedb-pro-v2',
                registered: _initialized,
                search: searchStatus,
                artifactsEnabled: _config?.hostInterop?.enableArtifacts ?? true,
                eventsEnabled: _config?.hostInterop?.enableEvents ?? true,
                backend: {
                    dbPath: _backendConfig?.dbPath ?? '',
                    tableName: _backendConfig?.tableName ?? '',
                    connectionMode: _backendConfig?.connectionMode ?? 'embedded',
                },
            };
        },
        async initialize() {
            await ensureInitialized();
        },
        async close() {
            await runtime.closeAllMemorySearchManagers();
        },
    };
    _runtime = runtime;
    return runtime;
}
export function getMemoryCapabilityRuntime() {
    return _runtime;
}
export async function getMemorySearchManager(params) {
    const runtime = getMemoryCapabilityRuntime();
    if (!runtime) {
        return {
            manager: null,
            error: 'Memory capability runtime not created',
        };
    }
    return runtime.getMemorySearchManager(params);
}
export function resolveBackendConfigForCapability(config) {
    return resolveMemoryBackendConfig(config);
}
export async function createAndInitializeMemoryCapability(config) {
    const runtime = createMemoryCapabilityRuntime({ config });
    await runtime.initialize();
    return runtime;
}
//# sourceMappingURL=memory-capability.js.map