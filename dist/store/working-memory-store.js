/**
 * Working Memory（工作任务）Store - 任务执行态存储层
 *
 * 内化 .working-memory/ 文件层（current-task.yaml + archive/）到 LanceDB 独立表。
 *
 * Design:
 * - 独立 working_memory 表（无向量列，不参与 dreaming sweep / dedup / 晋升）
 * - scope = agent:<id> 车道，写入隔离由工具层工厂绑定强制
 * - status 状态机：planned / in_progress / blocked / completed / abandoned / archived
 * - 归档 = 状态迁移（status=archived + archived_at），记录仍可查询
 * - 结构化字段（plan/decisions/learnings/...）JSON Utf8 存储
 * - 时间戳 ISO 8601 +08:00（Asia/Shanghai），对齐文件层约定
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Field, Float64, Schema, Utf8 } from 'apache-arrow';

/** 任务状态枚举 */
export const WM_STATUSES = ['planned', 'in_progress', 'blocked', 'completed', 'abandoned', 'archived'];
/** 活动状态（缺省 taskId 解析的目标集合） */
export const WM_ACTIVE_STATUSES = ['planned', 'in_progress', 'blocked'];
/** 数组型 JSON 字段（append 操作目标） */
export const WM_ARRAY_FIELDS = ['plan', 'decisions', 'learnings', 'risks', 'blockers', 'artifacts', 'next_actions'];
/** 标量字段（update 补丁允许） */
export const WM_SCALAR_FIELDS = ['goal', 'status', 'priority', 'owner', 'source', 'outcome', 'current_step', 'notes'];
/** 归档前必填字段（ARCHIVE-RULES §3） */
export const WM_ARCHIVE_REQUIRED = ['goal', 'status', 'outcome', 'decisions', 'learnings', 'artifacts'];

const SCHEMA_VERSION = 1;

function makeWorkingMemorySchema() {
    return new Schema([
        new Field('id', new Utf8(), false),
        new Field('task_id', new Utf8(), false),
        new Field('scope', new Utf8(), false),
        new Field('goal', new Utf8(), true),
        new Field('status', new Utf8(), false),
        new Field('priority', new Utf8(), true),
        new Field('owner', new Utf8(), true),
        new Field('source', new Utf8(), true),
        new Field('outcome', new Utf8(), true),
        new Field('current_step', new Float64(), true),
        new Field('plan', new Utf8(), true),
        new Field('decisions', new Utf8(), true),
        new Field('learnings', new Utf8(), true),
        new Field('risks', new Utf8(), true),
        new Field('blockers', new Utf8(), true),
        new Field('artifacts', new Utf8(), true),
        new Field('next_actions', new Utf8(), true),
        new Field('notes', new Utf8(), true),
        new Field('schema_version', new Float64(), false),
        new Field('created_at', new Utf8(), false),
        new Field('updated_at', new Utf8(), false),
        new Field('completed_at', new Utf8(), true),
        new Field('archived_at', new Utf8(), true),
    ]);
}

// LanceDB eager load（2026-09-26 生产补丁，原因同 asset-store.js；createRequire 仅为避开 ESM/CJS 问题）
const require = createRequire(import.meta.url);
try {
    process.report.excludeNetwork = true;
}
catch { /* Node < 22 */ }
const lancedbModule = require('@lancedb/lancedb');
async function loadLanceDB() {
    return lancedbModule;
}

function escapeSqlLiteral(value) {
    return value.replace(/'/g, "''");
}

/** ISO 8601 +08:00 时间戳（Asia/Shanghai，对齐文件层约定） */
export function nowIsoCn() {
    const now = new Date();
    const cn = new Date(now.getTime() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${cn.getUTCFullYear()}-${pad(cn.getUTCMonth() + 1)}-${pad(cn.getUTCDate())}T${pad(cn.getUTCHours())}:${pad(cn.getUTCMinutes())}:${pad(cn.getUTCSeconds())}+08:00`;
}

/** task_id 格式校验：wm-YYYY-MM-DD-简短主题（小写 kebab-case），宽松模式允许历史变体 */
const TASK_ID_PATTERN = /^wm-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
export function isValidTaskId(taskId) {
    return typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId);
}

/**
 * Resolve working-memory store config from backend config.
 */
export function resolveWorkingMemoryConfig(backendConfig, pluginConfig) {
    const wmCfg = pluginConfig?.workingMemory ?? {};
    return {
        dbPath: backendConfig.dbPath,
        tableName: wmCfg.tableName ?? 'working_memory',
        readConsistencyIntervalSeconds: backendConfig.readConsistencyIntervalSeconds,
    };
}

/**
 * Create Working Memory Store instance.
 */
export function createWorkingMemoryStore(config) {
    let _connected = false;
    let _db = null;
    let _table = null;
    let _initPromise = null;

    function generateId() {
        return randomUUID();
    }

    async function ensureInitialized() {
        if (_table)
            return;
        if (_initPromise)
            return _initPromise;
        _initPromise = doInitialize().catch((err) => {
            _initPromise = null;
            throw err;
        });
        return _initPromise;
    }

    async function doInitialize() {
        const lancedb = await loadLanceDB();
        const readConsistencyInterval = config.readConsistencyIntervalSeconds ?? 5;
        let db;
        try {
            db = await lancedb.connect(config.dbPath, { readConsistencyInterval });
        }
        catch (err) {
            throw new Error(`Failed to open LanceDB at "${config.dbPath}": ${err.code || ''} ${err.message}`);
        }
        let table;
        try {
            table = await db.openTable(config.tableName);
        }
        catch (_openErr) {
            try {
                table = await db.createEmptyTable(config.tableName, makeWorkingMemorySchema(), { existOk: true });
            }
            catch (createErr) {
                if (String(createErr).includes('already exists')) {
                    table = await db.openTable(config.tableName);
                }
                else {
                    throw createErr;
                }
            }
        }
        _db = db;
        _table = table;
        _connected = true;
    }

    /** 解析 JSON 数组字段（防御：坏数据降级为空数组） */
    function parseArrayField(raw) {
        if (raw === null || raw === undefined || raw === '')
            return [];
        if (Array.isArray(raw))
            return raw;
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    }

    function mapRowToRecord(row) {
        const record = {
            id: row.id,
            task_id: row.task_id,
            scope: row.scope,
            goal: row.goal ?? '',
            status: row.status,
            priority: row.priority ?? 'medium',
            owner: row.owner ?? '',
            source: row.source ?? '',
            outcome: row.outcome ?? '',
            current_step: row.current_step ?? 0,
            notes: row.notes ?? '',
            schema_version: row.schema_version ?? SCHEMA_VERSION,
            created_at: row.created_at,
            updated_at: row.updated_at,
            completed_at: row.completed_at ?? '',
            archived_at: row.archived_at ?? '',
        };
        for (const field of WM_ARRAY_FIELDS) {
            record[field] = parseArrayField(row[field]);
        }
        return record;
    }

    function mapRecordToRow(record) {
        const row = {
            id: record.id,
            task_id: record.task_id,
            scope: record.scope,
            goal: record.goal ?? '',
            status: record.status,
            priority: record.priority ?? 'medium',
            owner: record.owner ?? '',
            source: record.source ?? '',
            outcome: record.outcome ?? '',
            current_step: record.current_step ?? 0,
            notes: record.notes ?? '',
            schema_version: record.schema_version ?? SCHEMA_VERSION,
            created_at: record.created_at,
            updated_at: record.updated_at,
            completed_at: record.completed_at ?? '',
            archived_at: record.archived_at ?? '',
        };
        for (const field of WM_ARRAY_FIELDS) {
            const value = record[field];
            row[field] = JSON.stringify(Array.isArray(value) ? value : []);
        }
        return row;
    }

    /** 全表读取（表规模小：每 agent 活动任务 ≤1 + 归档历史，app 层过滤足够） */
    async function allRows() {
        await ensureInitialized();
        return _table.query().toArray();
    }

    async function findRow(scope, taskId) {
        const safeScope = escapeSqlLiteral(scope);
        const safeTaskId = escapeSqlLiteral(taskId);
        const rows = await _table.query()
            .where(`scope = '${safeScope}' AND task_id = '${safeTaskId}'`)
            .limit(1)
            .toArray();
        return rows.length > 0 ? rows[0] : null;
    }

    /** mergeInsert 原子 upsert，失败回退 delete+add（对齐 lancedb-store 模式） */
    async function upsertRow(row) {
        await ensureInitialized();
        try {
            await _table
                .mergeInsert('id')
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute([row]);
        }
        catch (mergeErr) {
            const safeId = escapeSqlLiteral(row.id);
            await _table.delete(`id = '${safeId}'`);
            await _table.add([row]);
        }
    }

    const store = {
        async initialize() {
            await ensureInitialized();
        },
        async close() {
            _connected = false;
            _db = null;
            _table = null;
            _initPromise = null;
        },

        /**
         * 创建任务。task_id 在 scope 车道内唯一。
         * @returns {{record: object|null, success: boolean, error?: string}}
         */
        async create(input) {
            await ensureInitialized();
            if (!input.task_id || typeof input.task_id !== 'string') {
                return { record: null, success: false, error: 'task_id is required (format: wm-YYYY-MM-DD-topic)' };
            }
            if (!input.scope) {
                return { record: null, success: false, error: 'scope is required' };
            }
            const status = input.status ?? 'planned';
            if (!WM_STATUSES.includes(status)) {
                return { record: null, success: false, error: `invalid status "${status}" (allowed: ${WM_STATUSES.join('/')})` };
            }
            const existing = await findRow(input.scope, input.task_id);
            if (existing) {
                return { record: null, success: false, error: `task_id "${input.task_id}" already exists in scope "${input.scope}"` };
            }
            const now = nowIsoCn();
            const record = {
                id: generateId(),
                task_id: input.task_id,
                scope: input.scope,
                goal: input.goal ?? '',
                status,
                priority: input.priority ?? 'medium',
                owner: input.owner ?? '',
                source: input.source ?? '',
                outcome: input.outcome ?? '',
                current_step: input.current_step ?? 0,
                notes: input.notes ?? '',
                schema_version: SCHEMA_VERSION,
                created_at: now,
                updated_at: now,
                completed_at: input.completed_at ?? '',
                archived_at: '',
            };
            for (const field of WM_ARRAY_FIELDS) {
                record[field] = Array.isArray(input[field]) ? input[field] : [];
            }
            await _table.add([mapRecordToRow(record)]);
            return { record, success: true };
        },

        /** 按 scope + task_id 精确查询 */
        async getByTaskId(scope, taskId) {
            await ensureInitialized();
            const row = await findRow(scope, taskId);
            return row ? mapRowToRecord(row) : null;
        },

        /**
         * 迁移导入：保留原始时间戳，task_id+scope 冲突时按 skipExisting 跳过。
         * 仅供一次性迁移脚本使用（tools 不暴露）。
         */
        async importRecord(record, options = {}) {
            await ensureInitialized();
            if (!record.task_id || !record.scope) {
                return { imported: false, skipped: false, error: 'task_id and scope are required' };
            }
            const existing = await findRow(record.scope, record.task_id);
            if (existing) {
                if (options.skipExisting !== false) {
                    return { imported: false, skipped: true };
                }
                return { imported: false, skipped: false, error: `task_id "${record.task_id}" already exists in scope "${record.scope}"` };
            }
            const now = nowIsoCn();
            const full = {
                id: record.id ?? generateId(),
                task_id: record.task_id,
                scope: record.scope,
                goal: record.goal ?? '',
                status: WM_STATUSES.includes(record.status) ? record.status : 'archived',
                priority: record.priority ?? 'medium',
                owner: record.owner ?? '',
                source: record.source ?? '',
                outcome: record.outcome ?? '',
                current_step: record.current_step ?? 0,
                notes: record.notes ?? '',
                schema_version: SCHEMA_VERSION,
                created_at: record.created_at || now,
                updated_at: record.updated_at || record.created_at || now,
                completed_at: record.completed_at ?? '',
                archived_at: record.archived_at ?? '',
            };
            for (const field of WM_ARRAY_FIELDS) {
                full[field] = Array.isArray(record[field]) ? record[field] : [];
            }
            await _table.add([mapRecordToRow(full)]);
            return { imported: true, skipped: false, record: full };
        },

        /** 缺省解析：车道内最新更新的活动任务；无活动任务返回 null */
        async getActive(scope) {
            const rows = await allRows();
            const candidates = rows
                .filter((r) => r.scope === scope && WM_ACTIVE_STATUSES.includes(r.status))
                .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
            return candidates.length > 0 ? mapRowToRecord(candidates[0]) : null;
        },

        /**
         * 补丁式更新标量字段。status→completed/abandoned 自动写 completed_at。
         */
        async update(scope, taskId, patch) {
            const row = await findRow(scope, taskId);
            if (!row)
                return { record: null, success: false, error: `task "${taskId}" not found in scope "${scope}"` };
            const existing = mapRowToRecord(row);
            if (existing.status === 'archived') {
                return { record: null, success: false, error: `task "${taskId}" is archived (read-only)` };
            }
            const next = { ...existing, updated_at: nowIsoCn() };
            for (const field of WM_SCALAR_FIELDS) {
                if (patch[field] !== undefined) {
                    next[field] = patch[field];
                }
            }
            for (const field of WM_ARRAY_FIELDS) {
                if (patch[field] !== undefined) {
                    if (!Array.isArray(patch[field])) {
                        return { record: null, success: false, error: `field "${field}" must be an array` };
                    }
                    next[field] = patch[field];
                }
            }
            if (patch.status !== undefined && !WM_STATUSES.includes(patch.status)) {
                return { record: null, success: false, error: `invalid status "${patch.status}"` };
            }
            if ((next.status === 'completed' || next.status === 'abandoned') && !next.completed_at) {
                next.completed_at = next.updated_at;
            }
            await upsertRow(mapRecordToRow(next));
            return { record: next, success: true };
        },

        /**
         * 追加式更新数组字段（高频操作：decisions/learnings/...）。
         * @param {object} additions - { decisions: [...], learnings: [...], ... }
         */
        async append(scope, taskId, additions) {
            const row = await findRow(scope, taskId);
            if (!row)
                return { record: null, success: false, error: `task "${taskId}" not found in scope "${scope}"` };
            const existing = mapRowToRecord(row);
            if (existing.status === 'archived') {
                return { record: null, success: false, error: `task "${taskId}" is archived (read-only)` };
            }
            const appended = [];
            for (const field of WM_ARRAY_FIELDS) {
                const items = additions[field];
                if (items === undefined)
                    continue;
                if (!Array.isArray(items)) {
                    return { record: null, success: false, error: `field "${field}" must be an array` };
                }
                existing[field] = [...existing[field], ...items];
                appended.push(field);
            }
            if (appended.length === 0) {
                return { record: null, success: false, error: `no array fields to append (allowed: ${WM_ARRAY_FIELDS.join('/')})` };
            }
            if (additions.notes !== undefined) {
                existing.notes = additions.notes;
            }
            existing.updated_at = nowIsoCn();
            await upsertRow(mapRecordToRow(existing));
            const lengths = {};
            for (const field of appended) {
                lengths[field] = existing[field].length;
            }
            return { record: existing, success: true, appended: lengths };
        },

        /**
         * 归档任务：状态迁移为 archived（ARCHIVE-RULES §3 必填字段校验）。
         */
        async archive(scope, taskId, options = {}) {
            const row = await findRow(scope, taskId);
            if (!row)
                return { record: null, success: false, error: `task "${taskId}" not found in scope "${scope}"` };
            const existing = mapRowToRecord(row);
            if (existing.status === 'archived') {
                return { record: null, success: false, error: `task "${taskId}" is already archived` };
            }
            // 先应用收尾补丁（outcome/notes/status），再校验
            if (options.outcome !== undefined)
                existing.outcome = options.outcome;
            if (options.notes !== undefined)
                existing.notes = options.notes;
            if (options.status !== undefined) {
                if (!['completed', 'abandoned'].includes(options.status)) {
                    return { record: null, success: false, error: 'archive requires status completed|abandoned' };
                }
                existing.status = options.status;
            }
            if ((existing.status === 'completed' || existing.status === 'abandoned') && !existing.completed_at) {
                existing.completed_at = nowIsoCn();
            }
            const missing = [];
            if (!existing.goal)
                missing.push('goal');
            if (!existing.outcome)
                missing.push('outcome');
            if (!WM_STATUSES.includes(existing.status))
                missing.push('status');
            for (const field of ['decisions', 'learnings', 'artifacts']) {
                if (!Array.isArray(existing[field]) || existing[field].length === 0) {
                    missing.push(field);
                }
            }
            if (missing.length > 0) {
                return { record: mapRowToRecord(mapRecordToRow(existing)), success: false, error: `archive validation failed, missing required fields: ${missing.join(', ')}`, missing };
            }
            const now = nowIsoCn();
            existing.status = 'archived';
            existing.archived_at = now;
            existing.updated_at = now;
            await upsertRow(mapRecordToRow(existing));
            return { record: existing, success: true };
        },

        /**
         * 列出任务。scope 可选（缺省全车道）；status 可选；按 updated_at 降序。
         */
        async list(options = {}) {
            const rows = await allRows();
            let filtered = rows;
            if (options.scope) {
                filtered = filtered.filter((r) => r.scope === options.scope);
            }
            if (options.status) {
                filtered = filtered.filter((r) => r.status === options.status);
            }
            else if (options.excludeArchived !== false) {
                filtered = filtered.filter((r) => r.status !== 'archived');
            }
            filtered = filtered.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
            const offset = options.offset ?? 0;
            const limit = Math.min(options.limit ?? 20, 100);
            return {
                tasks: filtered.slice(offset, offset + limit).map(mapRowToRecord),
                total: filtered.length,
                hasMore: filtered.length > offset + limit,
                success: true,
            };
        },

        /** 全车道概览：每 scope 的活动/归档计数 + 最新活动任务 */
        async laneOverview() {
            const rows = await allRows();
            const lanes = {};
            for (const row of rows) {
                const lane = lanes[row.scope] ?? (lanes[row.scope] = { scope: row.scope, active: 0, archived: 0, latestActive: null });
                if (row.status === 'archived') {
                    lane.archived += 1;
                }
                else {
                    lane.active += 1;
                    if (!lane.latestActive || String(row.updated_at) > String(lane.latestActive.updated_at)) {
                        lane.latestActive = { task_id: row.task_id, status: row.status, goal: String(row.goal ?? '').slice(0, 120), updated_at: row.updated_at };
                    }
                }
            }
            return { lanes: Object.values(lanes).sort((a, b) => a.scope.localeCompare(b.scope)), success: true };
        },

        async status() {
            if (!_table) {
                return { initialized: false, tableName: config.tableName, totalTasks: 0, error: 'Working memory store not initialized' };
            }
            try {
                const rows = await _table.query().toArray();
                return { initialized: _connected, tableName: config.tableName, totalTasks: rows.length };
            }
            catch (err) {
                return { initialized: _connected, tableName: config.tableName, totalTasks: 0, error: err.message };
            }
        },
    };
    return store;
}

/** 全局单例（与 asset-store 同款管理） */
let _wmStore = null;
let _wmStoreConfig = null;

export async function initializeWorkingMemoryStore(backendConfig, pluginConfig) {
    _wmStoreConfig = resolveWorkingMemoryConfig(backendConfig, pluginConfig);
    _wmStore = createWorkingMemoryStore(_wmStoreConfig);
    await _wmStore.initialize();
}

export function getWorkingMemoryStore() {
    if (!_wmStore) {
        throw new Error('Working memory store not initialized - call initializeWorkingMemoryStore() first');
    }
    return _wmStore;
}

export async function closeWorkingMemoryStore() {
    if (_wmStore) {
        await _wmStore.close();
        _wmStore = null;
    }
    _wmStoreConfig = null;
}
