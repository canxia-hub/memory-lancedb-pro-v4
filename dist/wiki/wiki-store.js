/**
 * Wiki Store - Wiki 数据存取层
 *
 * 对照 Python 实现：
 * - wiki_common.py: WIKI_ROOT, normalize_link_target, resolve_link_to_path
 * - wiki-new.py: slugify, create_entry, sync_after_write
 */
import * as fs from 'fs';
import * as path from 'path';
import { WIKI_CATEGORIES, } from './types.js';
// ============================================================================
// Constants
// ============================================================================
/**
 * Wiki root directory — 单一解析点（DV-1 修复，4.2.3）。
 *
 * 优先级链：register 时注入的 config.vault.path（configureWikiRoot）
 *   > 环境变量 WIKI_ROOT / OPENCLAW_WIKI_ROOT
 *   > 默认 $HOME/.openclaw/wiki
 *
 * 导出绑定为 `let`：所有 importer（doctor/index/sync-links/graph/traverse/
 * hybrid/supplement/digest）通过 ESM live binding 在调用时读到已配置根，
 * 不允许再各自内联 env 链旁路解析。
 */
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';
export let WIKI_ROOT = process.env.WIKI_ROOT
    || process.env.OPENCLAW_WIKI_ROOT
    || (HOME_DIR ? `${HOME_DIR}/.openclaw/wiki` : '.openclaw/wiki');
/**
 * 用已解析的插件配置覆盖 vault 根（config.vault.path）。
 * 仅接受非空字符串；resolve-config 已实现 config > env > default 优先级，
 * 因此这里无条件注入即可保持链条一致。
 */
export function configureWikiRoot(vaultPath) {
    if (typeof vaultPath === 'string' && vaultPath.trim() !== '') {
        WIKI_ROOT = vaultPath.trim();
    }
}
/** 当前解析出的 wiki vault 根（供不希望直接绑定常量的模块使用）。 */
export function getWikiRoot() {
    return WIKI_ROOT;
}
/**
 * Category to template mapping (对照 Python CATEGORY_TO_TEMPLATE)
 */
const CATEGORY_TO_TEMPLATE = {
    concepts: 'concept.md',
    decisions: 'decision.md',
    procedures: 'procedure.md',
    references: 'reference.md',
    snippets: 'snippet.md',
};
/**
 * Category to kind mapping (对照 Python CATEGORY_TO_KIND)
 */
const CATEGORY_TO_KIND = {
    concepts: 'concept',
    decisions: 'decision',
    procedures: 'procedure',
    references: 'reference',
    snippets: 'snippet',
};
// ============================================================================
// Utility Functions
// ============================================================================
/**
 * 标题转 slug（对照 Python wiki-new.py slugify）
 *
 * Python 实现:
 *   slug = text.lower()
 *   slug = re.sub(r"[^\w\s-]", "", slug)
 *   slug = re.sub(r"[\s_]+", "-", slug)
 *   return slug.strip("-")
 */
export function slugify(text) {
    let slug = text.toLowerCase();
    // Remove non-word characters (except spaces and hyphens)
    slug = slug.replace(/[^\w\s-]/g, '');
    // Replace spaces and underscores with hyphens
    slug = slug.replace(/[\s_]+/g, '-');
    // Strip leading/trailing hyphens
    return slug.replace(/^-+|-+$/g, '');
}
/**
 * 获取当前 ISO 8601 时间戳（对照 Python get_timestamp）
 */
function getTimestamp() {
    const now = new Date();
    // ISO 8601 with timezone (like Python's isoformat())
    const offset = -now.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const hours = Math.floor(Math.abs(offset) / 60).toString().padStart(2, '0');
    const minutes = (Math.abs(offset) % 60).toString().padStart(2, '0');
    return now.toISOString().slice(0, -1) + sign + hours + ':' + minutes;
}
/**
 * Normalize link target (对照 Python wiki_common.py normalize_link_target)
 */
export function normalizeLinkTarget(target) {
    let normalized = target.trim().replace(/\\/g, '/');
    if (normalized.endsWith('.md')) {
        normalized = normalized.slice(0, -3);
    }
    normalized = normalized.replace(/^\.\/+/, '');
    return normalized;
}
/**
 * Resolve link to absolute path (对照 Python wiki_common.py resolve_link_to_path)
 */
export function resolveLinkToPath(target) {
    const normalized = normalizeLinkTarget(target);
    // Try direct path
    const direct = path.join(WIKI_ROOT, `${normalized}.md`);
    if (fs.existsSync(direct)) {
        return direct;
    }
    // Try under each category
    for (const category of WIKI_CATEGORIES) {
        const candidate = path.join(WIKI_ROOT, category, `${normalized}.md`);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}
// ============================================================================
// Front Matter Parsing
// ============================================================================
/**
 * 解析 YAML Front Matter（对照 Python wiki-index.py parse_frontmatter）
 *
 * 格式:
 * ---
 * title: ...
 * category: ...
 * tags: ["tag1", "tag2"]
 * status: draft
 * ---
 */
export function parseFrontMatter(content) {
    if (!content.startsWith('---')) {
        return null;
    }
    const parts = content.split('---');
    if (parts.length < 3) {
        return null;
    }
    const yamlContent = parts[1].trim();
    const metadata = {};
    for (const line of yamlContent.split('\n')) {
        if (!line.includes(':'))
            continue;
        // Split only on first colon (like Python's line.split(':', 1))
        // This preserves colons in values like ISO timestamps
        const colonIdx = line.indexOf(':');
        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        if (key === 'tags') {
            // Parse array format: ["tag1", "tag2"] or [tag1, tag2]
            if (value.startsWith('[') && value.endsWith(']')) {
                const inner = value.slice(1, -1);
                metadata.tags = inner
                    .split(',')
                    .map(t => t.trim().replace(/^["']|["']$/g, ''))
                    .filter(t => t.length > 0);
            }
        }
        else if (key === 'confidence') {
            metadata.confidence = parseFloat(value);
        }
        else if (key === 'title' || key === 'category' || key === 'status' ||
            key === 'agent' || key === 'created' || key === 'updated') {
            // String fields
            metadata[key] = value;
        }
    }
    // Validate required fields
    if (!metadata.title || !metadata.category) {
        return null;
    }
    // Apply defaults
    return {
        title: metadata.title,
        category: metadata.category,
        tags: metadata.tags || [],
        status: metadata.status || 'draft',
        agent: metadata.agent,
        confidence: metadata.confidence,
        created: metadata.created,
        updated: metadata.updated,
    };
}
/**
 * 序列化 Front Matter 为 YAML（对照 Python wiki-new.py 模板替换）
 */
export function serializeFrontMatter(fm) {
    const lines = ['---'];
    lines.push(`title: ${fm.title}`);
    lines.push(`category: ${fm.category}`);
    // Tags as YAML array
    if (fm.tags.length > 0) {
        const tagsStr = fm.tags.map(t => `"${t}"`).join(', ');
        lines.push(`tags: [${tagsStr}]`);
    }
    else {
        lines.push('tags: []');
    }
    lines.push(`status: ${fm.status}`);
    if (fm.agent) {
        lines.push(`agent: ${fm.agent}`);
    }
    if (fm.confidence !== undefined) {
        lines.push(`confidence: ${fm.confidence}`);
    }
    if (fm.created) {
        lines.push(`created: ${fm.created}`);
    }
    if (fm.updated) {
        lines.push(`updated: ${fm.updated}`);
    }
    lines.push('---');
    return lines.join('\n');
}
// ============================================================================
// Wiki Entry Operations
// ============================================================================
/**
 * 列出所有分类及其条目计数
 */
export function listCategories() {
    const counts = {
        concepts: 0,
        decisions: 0,
        procedures: 0,
        references: 0,
        snippets: 0,
    };
    for (const category of WIKI_CATEGORIES) {
        const categoryPath = path.join(WIKI_ROOT, category);
        if (!fs.existsSync(categoryPath))
            continue;
        const files = fs.readdirSync(categoryPath);
        for (const file of files) {
            if (file.endsWith('.md') && !file.startsWith('_')) {
                counts[category]++;
            }
        }
    }
    return counts;
}
/**
 * 读取 Wiki 条目
 */
export function getEntry(relativePath) {
    const fullPath = path.join(WIKI_ROOT, relativePath);
    if (!fs.existsSync(fullPath)) {
        return null;
    }
    const rawContent = fs.readFileSync(fullPath, 'utf-8');
    const frontMatter = parseFrontMatter(rawContent);
    if (!frontMatter) {
        return null;
    }
    // Extract content after front matter
    const parts = rawContent.split('---');
    let content = '';
    if (parts.length >= 3) {
        content = parts.slice(2).join('---').trim();
    }
    return {
        path: relativePath,
        frontMatter,
        content,
        rawContent,
    };
}
/**
 * 创建 Wiki 条目（对照 Python wiki-new.py create_entry）
 *
 * 创建后自动触发 sync + index
 */
export async function createEntry(category, title, options) {
    const categoryPath = path.join(WIKI_ROOT, category);
    if (!fs.existsSync(categoryPath)) {
        throw new Error(`分类目录不存在: ${categoryPath}`);
    }
    // Generate filename (decisions use date prefix)
    const slug = slugify(title);
    let filename;
    if (category === 'decisions') {
        const datePrefix = new Date().toISOString().slice(0, 10);
        filename = `${datePrefix}-${slug}.md`;
    }
    else {
        filename = `${slug}.md`;
    }
    const filePath = path.join(categoryPath, filename);
    if (fs.existsSync(filePath)) {
        throw new Error(`文件已存在: ${filePath}`);
    }
    // Load template
    const templateName = CATEGORY_TO_TEMPLATE[category];
    const templatePath = path.join(WIKI_ROOT, 'templates', templateName);
    let templateContent = '';
    if (fs.existsSync(templatePath)) {
        templateContent = fs.readFileSync(templatePath, 'utf-8');
    }
    else {
        // Default template if file not found
        templateContent = getDefaultTemplate(category);
    }
    // Build front matter
    const now = getTimestamp();
    const fm = {
        title,
        category,
        tags: options?.tags || [],
        status: options?.status || 'draft',
        agent: options?.agent || 'main',
        confidence: options?.confidence || 0.8,
        created: now,
        updated: now,
    };
    // Replace placeholders in template
    const kind = CATEGORY_TO_KIND[category];
    let content = templateContent;
    // Replace title placeholders
    const titlePlaceholders = [
        '<概念标题>',
        '<决策标题>',
        '<流程标题>',
        '<参考标题>',
        '<片段标题>',
    ];
    for (const ph of titlePlaceholders) {
        content = content.replace(ph, title);
    }
    content = content.replace('<kebab-case>', slug);
    content = content.replace('<ISO-8601>', now);
    content = content.replace('<创建者>', fm.agent || 'main');
    content = content.replace(`wiki-${kind}-<kebab-case>`, `wiki-${kind}-${slug}`);
    // Replace front matter in template
    const frontMatterStr = serializeFrontMatter(fm);
    // If template has front matter block, replace it
    if (content.startsWith('---')) {
        const parts = content.split('---');
        if (parts.length >= 3) {
            content = frontMatterStr + '\n' + parts.slice(2).join('---');
        }
    }
    else {
        content = frontMatterStr + '\n\n' + content;
    }
    // Write file
    fs.writeFileSync(filePath, content, 'utf-8');
    // Trigger sync + index (异步导入，避免循环依赖)
    // 实际项目中会在工具层调用，这里只是标记需要同步
    // await syncWikiAfterWrite();
    // Return relative path
    return path.join(category, filename);
}
/**
 * 更新 Wiki 条目正文
 */
export async function updateEntry(relativePath, content) {
    const fullPath = path.join(WIKI_ROOT, relativePath);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`条目不存在: ${relativePath}`);
    }
    const entry = getEntry(relativePath);
    if (!entry) {
        throw new Error(`无法解析条目: ${relativePath}`);
    }
    // Update timestamp
    const updatedFm = {
        ...entry.frontMatter,
        updated: getTimestamp(),
    };
    const frontMatterStr = serializeFrontMatter(updatedFm);
    const newContent = frontMatterStr + '\n\n' + content;
    fs.writeFileSync(fullPath, newContent, 'utf-8');
}
/**
 * 删除 Wiki 条目
 */
export async function deleteEntry(relativePath) {
    const fullPath = path.join(WIKI_ROOT, relativePath);
    if (!fs.existsSync(fullPath)) {
        return false;
    }
    fs.unlinkSync(fullPath);
    return true;
}
// ============================================================================
// Helper Functions
// ============================================================================
/**
 * 默认模板（当模板文件不存在时使用）
 */
function getDefaultTemplate(category) {
    const kind = CATEGORY_TO_KIND[category];
    return `---
title: <${kind}标题>
category: ${category}
tags: []
status: draft
agent: main
confidence: 0.8
created: <ISO-8601>
updated: <ISO-8601>
---

# <${kind}标题>

> 概述待补充

## 内容

待补充

---

## 参考

- 相关条目: [[wiki-${kind}-<kebab-case>]]
`;
}
//# sourceMappingURL=wiki-store.js.map