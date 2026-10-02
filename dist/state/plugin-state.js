/**
 * Plugin State Persistence — Phase 3
 *
 * Wraps OpenClaw's openKeyedStore (SQLite-backed) for plugin metadata.
 * Replaces hand-written state tracking with durable persistence.
 *
 * openKeyedStore API:
 *   register(key, value, opts?) → Promise<void>
 *   registerIfAbsent(key, value, opts?) → Promise<boolean>
 *   lookup(key) → Promise<T|undefined>
 *   consume(key) → Promise<T|undefined>
 *   delete(key) → Promise<boolean>
 *   entries() → Promise<PluginStateEntry<T>[]>
 *   clear() → Promise<void>
 */

/** @type {import('openclaw/plugin-sdk/plugin-entry').PluginStateKeyedStore|null} */
let _stateStore = null;
let _initialized = false;
let _fallbackMode = false;

/**
 * Initialize the plugin state store.
 * Must be called during plugin register(api).
 *
 * Primary: OpenClaw openKeyedStore (bundled/trusted plugins only).
 * Fallback: file-backed keyed store under opts.fallbackDir when the
 * host API is restricted (2026.7.x release).
 *
 * @param {object} api - OpenClawPluginApi (runtime.state.openKeyedStore)
 * @param {{fallbackDir?: string}} [opts]
 * @returns {Promise<boolean>} true if initialized
 */
export async function initPluginState(api, opts = {}) {
  if (_initialized && _stateStore) return true;

  try {
    // local-host-state-compat-v1
    if(typeof api?.runtime?.state?.openKeyedStore !== 'function') {
      const unavailable = new Error('Host does not expose plugin keyed state');
      unavailable.code = 'PLUGIN_STATE_UNAVAILABLE';
      throw unavailable;
    }
    _stateStore = await api.runtime.state.openKeyedStore({
      namespace: 'memory-lancedb-pro',
      maxEntries: 1000,
      defaultTtlMs: undefined, // permanent by default
    });
    _initialized = true;
    return true;
  } catch (error) {
    const expectedRestriction = error?.code === 'PLUGIN_TRUST_REFUSED' || error?.code === 'PLUGIN_STATE_UNAVAILABLE';
    if(!expectedRestriction) console.warn('[memory-lancedb-pro] openKeyedStore init failed:', error.message);
    if (opts.fallbackDir) {
      try {
        const { createFileKeyedStore } = await import('./file-keyed-store.js');
        _stateStore = createFileKeyedStore(opts.fallbackDir, 'memory-lancedb-pro', { maxEntries: 1000 });
        _initialized = true;
        _fallbackMode = true;
        console.log('[memory-lancedb-pro] state store active via file fallback:', opts.fallbackDir);
        return true;
      } catch (fallbackError) {
        console.warn('[memory-lancedb-pro] file fallback also failed (honest degradation):', fallbackError.message);
      }
    }
    _stateStore = null;
    return false;
  }
}

// ═══════════════════════════════════════════════════
// Migration State
// ═══════════════════════════════════════════════════

/**
 * Get the last successful migration version.
 * @returns {Promise<{version: number, timestamp: number}|null>}
 */
export async function getLastMigration() {
  if (!_stateStore) return null;
  try {
    return await _stateStore.lookup('migration:lastVersion');
  } catch { return null; }
}

/**
 * Record a successful migration.
 * @param {number} version
 */
export async function setLastMigration(version) {
  if (!_stateStore) return;
  try {
    await _stateStore.register('migration:lastVersion', {
      version,
      timestamp: Date.now(),
    });
  } catch { /* silent */ }
}

// ═══════════════════════════════════════════════════
// Plugin Stats
// ═══════════════════════════════════════════════════

/**
 * Get persistent stats snapshot.
 * @returns {Promise<object|null>}
 */
export async function getStats() {
  if (!_stateStore) return null;
  try {
    return await _stateStore.lookup('stats');
  } catch { return null; }
}

/**
 * Update persistent stats.
 * @param {object} stats
 */
export async function setStats(stats) {
  if (!_stateStore) return;
  try {
    await _stateStore.register('stats', {
      ...stats,
      updatedAt: Date.now(),
    });
  } catch { /* silent */ }
}

// ═══════════════════════════════════════════════════
// Search Cache (TTL-based)
// ═══════════════════════════════════════════════════

/**
 * Cache a search result with TTL (default 5 min).
 * @param {string} cacheKey
 * @param {unknown} result
 * @param {number} [ttlMs=300000]
 */
export async function cacheSearch(cacheKey, result, ttlMs = 300000) {
  if (!_stateStore) return;
  try {
    await _stateStore.register(`search:${cacheKey}`, result, { ttlMs });
  } catch { /* silent */ }
}

/**
 * Look up a cached search result.
 * @param {string} cacheKey
 * @returns {Promise<unknown|null>}
 */
export async function getSearchCache(cacheKey) {
  if (!_stateStore) return null;
  try {
    return await _stateStore.lookup(`search:${cacheKey}`);
  } catch { return null; }
}

// ═══════════════════════════════════════════════════
// Status
// ═══════════════════════════════════════════════════

/**
 * Check if the state store is active.
 * @returns {boolean}
 */
export function isStateActive() {
  return _initialized && _stateStore !== null;
}

/**
 * Check whether the active store is the file fallback.
 * @returns {boolean}
 */
export function isStateFallbackMode() {
  return _fallbackMode;
}
