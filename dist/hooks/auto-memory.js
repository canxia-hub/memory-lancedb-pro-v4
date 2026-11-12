/**
 * Auto-Memory Hooks
 *
 * Ported from openclaw/openclaw extensions/memory-lancedb/index.ts L500-684
 * Provides before_prompt_build (auto-recall) and agent_end (reflection
 * distiller) hooks.
 *
 * Design decisions:
 * - autoRecall default false (灰度原则)
 * - Memory sub-session anti-recursion: sessionKey with reflection/distiller/dreaming prefix → skip
 * - Recall timeout: 6s; abort stalled embedding; coalesce duplicate requests
 */

import { dropMediaNoteLines } from '../capture/sanitization.js';
import {
  extractLatestUserText,
  normalizeRecallQuery,
  DEFAULT_RECALL_MAX_CHARS,
} from '../capture/policy.js';
import {
  cleanMemorySearchResults,
  formatRelevantMemoriesContext,
} from '../capture/prompt-defense.js';
import { computeRecallQueryId } from '../store/lancedb-store.js';
import {
  normalizeReflectionConfig,
  runReflectionPipeline,
  ReflectionLaneManager,
  ReflectionCache,
} from '../reflection/distiller.js';
import { registerReflectionInjector } from '../reflection/injector.js';

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 6000;
const RECALL_EMBEDDING_CACHE_TTL_MS = 60_000;
const RECALL_EMBEDDING_CACHE_LIMIT = 16;
const RECALL_INFLIGHT_LIMIT = 2;
const DEFAULT_AUTO_RECALL_OVERFETCH_LIMIT = 10;
const DEFAULT_AUTO_RECALL_RESULT_CAP = 3;

/** Minimum relevance score for auto-recall injection.
 *  score = 1/(1+cosine_distance); 0.7 ≈ cosine similarity ≥0.57.
 *  Below threshold → no injection at all (prevents floor-effect junk). */
const DEFAULT_RECALL_MIN_SCORE = 0.7;

/** Reflection distiller timeout (ms). See distiller.js for the 120s rationale (cold-start headroom). */
const DEFAULT_REFLECTION_DISTILLER_TIMEOUT_MS = 120_000;

/**
 * Session key prefixes that indicate plugin-internal sub-sessions.
 * These should be skipped to prevent recursive capture/recall.
 * Pre-embedded for M3/M4 (reflection/distiller/dreaming).
 */
const MEMORY_SUBSESSION_PREFIXES = [
  'memory:',
  'reflection:',
  'distiller:',
  'dreaming:',
  'temp:memory-reflection:',
];

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Check if a sessionKey belongs to a memory sub-session (anti-recursion guard).
 */
function isMemorySubSession(sessionKey) {
  if (!sessionKey) return false;
  return MEMORY_SUBSESSION_PREFIXES.some(prefix => sessionKey.startsWith(prefix));
}

/**
 * Check if a sessionKey is incognito (from SDK routing).
 * Inlined because isIncognitoSessionKey may not be available.
 */
function isIncognitoSessionKey(sessionKey) {
  if (!sessionKey) return false;
  return sessionKey.includes(':incognito') || sessionKey.startsWith('incognito:');
}

/**
 * Normalize agent ID (strip non-alphanumeric prefix).
 */
function normalizeAgentId(agentId) {
  if (!agentId) return undefined;
  return agentId.replace(/^[^a-zA-Z0-9]+/, '');
}

/**
 * Simple timeout wrapper for async operations.
 */
function runWithTimeout({ timeoutMs, task }) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Timeout after ${timeoutMs}ms`);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => task(controller.signal)),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Resolve hook config from plugin config with defaults.
 */
function resolveHookConfig(pluginConfig) {
  return {
    autoRecall: pluginConfig.autoRecall ?? false,
    recallMaxChars: pluginConfig.recallMaxChars ?? DEFAULT_RECALL_MAX_CHARS,
    recallMinScore: pluginConfig.recallMinScore ?? DEFAULT_RECALL_MIN_SCORE,
  };
}

// ── Hook Registration ──────────────────────────────────────────────────

/**
 * Register auto-memory hooks with the plugin API.
 *
 * @param {Object} api - OpenClaw plugin API (api.on, api.logger, etc.)
 * @param {Object} deps - Dependencies: { getStore, getEmbedder, pluginConfig }
 *   - getStore(): returns the LanceDB store instance (lazy, may not be ready)
 *   - getEmbedder(): returns the embedder instance (lazy)
 *   - pluginConfig: raw plugin config for hook settings
 */
export function registerAutoMemoryHooks(api, deps) {
  const { getStore, getEmbedder, pluginConfig } = deps;
  // Cache vectors only, never memory text/results; shared retrieval remains current.
  const embeddingCache = new Map();
  const inflightRecalls = new Map();
  const recall = (agentId, query, db, embedder, cfg) => {
    const key = JSON.stringify([agentId, query, cfg.recallMinScore]);
    if (inflightRecalls.has(key)) return inflightRecalls.get(key);
    if (inflightRecalls.size >= RECALL_INFLIGHT_LIMIT) return Promise.resolve([]);
    const work = runWithTimeout({
      timeoutMs: DEFAULT_AUTO_RECALL_TIMEOUT_MS,
      task: async (signal) => {
        const now = Date.now();
        for (const [k, entry] of embeddingCache) {
          if (entry.expiresAt <= now) embeddingCache.delete(k);
        }
        let vector = embeddingCache.get(query)?.vector;
        if (!vector) {
          vector = await embedder.embed(query, { signal });
          signal.throwIfAborted();
          if (!Array.isArray(vector) || vector.length === 0) return [];
          embeddingCache.set(query, { vector, expiresAt: Date.now() + RECALL_EMBEDDING_CACHE_TTL_MS });
          while (embeddingCache.size > RECALL_EMBEDDING_CACHE_LIMIT) {
            embeddingCache.delete(embeddingCache.keys().next().value);
          }
        }
        signal.throwIfAborted();
        // Native LanceDB search has no abort API; do not begin it after deadline.
        return await db.search(agentId, vector, DEFAULT_AUTO_RECALL_OVERFETCH_LIMIT, cfg.recallMinScore);
      },
    });
    inflightRecalls.set(key, work);
    const release = () => { if (inflightRecalls.get(key) === work) inflightRecalls.delete(key); };
    work.then(release, release);
    return work;
  };

  // ── Reflection infrastructure ──────────────────────────────────────
  const reflectionConfig = normalizeReflectionConfig(pluginConfig);
  const reflectionLaneManager = new ReflectionLaneManager(reflectionConfig.maxConcurrency);
  const reflectionCache = new ReflectionCache();

  // Register reflection injector (before_prompt_build, priority-layered)
  // Only active when reflection.enabled=true
  if (reflectionConfig.enabled) {
    registerReflectionInjector(api, {
      getStore,
      getEmbedder,
      pluginConfig,
      reflectionCache,
    });
  }

  // ── before_prompt_build: auto-recall ────────────────────────────────
  api.on('before_prompt_build', async (event, ctx) => {
    const cfg = resolveHookConfig(pluginConfig);
    if (!cfg.autoRecall) return undefined;

    const agentId = normalizeAgentId(ctx.agentId);
    if (!agentId) return undefined;

    // Anti-recursion: skip memory sub-sessions
    if (isMemorySubSession(ctx.sessionKey) || ctx.sessionKey?.includes(':internal-session-effects:')) return undefined;

    // Short message gate
    if (!event.prompt || event.prompt.length < 5) return undefined;

    try {
      await deps.ensureReady?.();
      const db = getStore();
      const embedder = getEmbedder();
      if (!db || !embedder) return undefined;

      const recallQuery = normalizeRecallQuery(
        dropMediaNoteLines(
          extractLatestUserText(Array.isArray(event.messages) ? event.messages : []) ??
            event.prompt,
        ),
        cfg.recallMaxChars,
      );
      if (!recallQuery) return undefined;

      const recalled = await recall(agentId, recallQuery, db, embedder, cfg);

      // Filter contaminated memories, then cap
      const cleaned = cleanMemorySearchResults(recalled);
      const cleanResults = cleaned
        .map(({ result, text }) => ({ category: (result.entry ?? result).category ?? 'other', text }))
        .slice(0, DEFAULT_AUTO_RECALL_RESULT_CAP);

      if (cleanResults.length === 0) return undefined;

      api.logger.info?.(`[memory-lancedb-pro] auto-recall: injecting ${cleanResults.length} memories into context`);

      // Access tracking (fire-and-forget): feed dreaming deep-promotion
      // signals (access_count / unique_query_count). Never blocks injection.
      try {
        const recalledIds = cleaned
          .map(({ result }) => result?.id ?? result?.entry?.id)
          .filter((x) => typeof x === 'string' && x.length > 0)
          .slice(0, DEFAULT_AUTO_RECALL_RESULT_CAP);
        if (recalledIds.length > 0 && typeof db.recordAccess === 'function') {
          db.recordAccess(recalledIds, computeRecallQueryId(recallQuery))
            .catch((err) => api.logger.warn?.(`[memory-lancedb-pro] access tracking failed: ${String(err)}`));
        }
      } catch { /* non-fatal */ }

      const context = formatRelevantMemoriesContext(cleanResults);
      if (!context) return undefined;

      return { prependContext: context };
    } catch (err) {
      // Fail-safe: don't block agent startup on recall failure
      api.logger.warn?.(`[memory-lancedb-pro] auto-recall failed: ${String(err)}`);
      return undefined;
    }
  });

  // ── agent_end: reflection distiller ────────────────────────────────
  api.on('agent_end', async (event, ctx) => {
    const agentId = normalizeAgentId(ctx.agentId);
    const isSubSession = isMemorySubSession(ctx.sessionKey);
    const isIncognito = isIncognitoSessionKey(ctx.sessionKey);

    // ── Reflection distiller (M3, only when enabled) ─────────────────
    if (reflectionConfig.enabled && !isSubSession && !isIncognito && agentId &&
        event.success && event.messages && event.messages.length > 0) {
      // Acquire lane slot (bounded concurrency per agent)
      const release = await reflectionLaneManager.acquire(agentId);
      try {
        await deps.ensureReady?.();
        await runReflectionPipeline({
          api,
          agentId,
          sessionKey: ctx.sessionKey || '',
          sessionId: ctx.sessionId || '',
          messages: event.messages,
          reflectionConfig,
          admissionConfig: pluginConfig?.reflection?.admissionPreset
            ? { preset: pluginConfig.reflection.admissionPreset }
            : undefined,
          getStore,
          getEmbedder,
          onLog: (level, msg) => {
            if (level === 'warn') api.logger.warn?.(`[memory-lancedb-pro] ${msg}`);
            else api.logger.info?.(`[memory-lancedb-pro] ${msg}`);
          },
          timeoutMs: DEFAULT_REFLECTION_DISTILLER_TIMEOUT_MS,
        });
        // Invalidate cache after new reflection items stored
        reflectionCache.invalidate(agentId);
      } catch (err) {
        api.logger.warn?.(`[memory-lancedb-pro] reflection distiller failed: ${String(err)}`);
      } finally {
        release();
      }
    }
    // Hook-runner budget: default agent_end void-hook timeout is only 30s
    // (DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK). The runner never cancels us
    // (Promise.race detach), but it logs a spurious timeout warn. Raise the
    // budget above the distiller worst case (120s internal + one retry)
    // so the runner-side warn only fires on genuine pathology.
  }, { timeoutMs: 300_000 });

  // ── memory delete cascade: invalidate reflection cache ─────────────
  // When memories are deleted, the reflection cache may contain stale references.
  // We hook into the tool execution lifecycle to detect delete operations.
  api.on('after_tool_call', async (event, ctx) => {
    if (!event?.toolName) return;
    const toolName = event.toolName;
    if (toolName === 'memory_archive' || toolName === 'memory_forget') {
      // Invalidate cache for the affected agent (or all if unknown)
      const agentId = normalizeAgentId(ctx.agentId);
      reflectionCache.invalidate(agentId);
    }
  });

  const enabledParts = [];
  if (reflectionConfig.enabled) enabledParts.push('reflection=on');
  const hookCfg = resolveHookConfig(pluginConfig);
  api.logger.info?.(
    `[memory-lancedb-pro] auto-memory hooks registered ` +
    `(autoRecall=${hookCfg.autoRecall}${enabledParts.length ? ', ' + enabledParts.join(', ') : ''})`
  );
}

// Export helpers for testing
export { resolveHookConfig, isMemorySubSession, isIncognitoSessionKey, normalizeAgentId };
