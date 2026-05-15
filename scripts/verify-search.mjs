/**
 * 端到端验证脚本：多词 AND/OR 搜索 + FTS5 全文搜索
 */
import { DatabaseManager } from '../dist/utils/database.js';
import { ContextRepository } from '../dist/repositories/ContextRepository.js';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(os.tmpdir(), `verify-search-${Date.now()}.db`);

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── 初始化 ─────────────────────────────────────────────────────────────────
const dbManager = new DatabaseManager(dbPath);
await dbManager.initialize();
const db = dbManager.getDatabase();
const repo = new ContextRepository(dbManager);

const sessionId = uuidv4();
db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(sessionId, 'verify-session');

// 插入测试数据
const items = [
  // 中英文混合：XTAR 和 结汇人 分散在不同字段
  { key: 'XTAR项目',        value: '这是结汇人审核流程的说明',  category: 'task' },
  // XTAR 在 value，结汇人 在 key
  { key: '结汇人配置',      value: '请联系XTAR团队确认',       category: 'task' },
  // 只含 XTAR
  { key: 'XTAR说明',        value: '项目背景介绍',              category: 'doc'  },
  // 只含 结汇人
  { key: '审核规则',        value: '结汇人需完成实名认证',      category: 'doc'  },
  // 两词都不含
  { key: 'other',           value: 'unrelated content',         category: 'misc' },
  // 英文多词
  { key: 'auth module',     value: 'handles user authentication and login', category: 'code' },
  { key: 'login page',      value: 'user interface for authentication',     category: 'code' },
  { key: 'database setup',  value: 'configures postgresql connection',      category: 'code' },
];

for (const item of items) {
  db.prepare(
    'INSERT INTO context_items (id, session_id, key, value, category) VALUES (?, ?, ?, ?, ?)'
  ).run(uuidv4(), sessionId, item.key, item.value, item.category);
}

// 检查 FTS5 是否可用
let fts5Available = false;
try {
  db.prepare("SELECT COUNT(*) FROM context_items_fts").get();
  fts5Available = true;
} catch {
  fts5Available = false;
}

console.log('\n═══════════════════════════════════════════════════');
console.log('  MCP Memory Keeper — 搜索功能端到端验证');
console.log('═══════════════════════════════════════════════════');
console.log(`  FTS5 可用：${fts5Available ? '✅ 是' : '⚠️  否（将跳过 FTS5 测试）'}\n`);

// ── 1. 向后兼容：单词查询行为不变 ─────────────────────────────────────────
console.log('【1】向后兼容 — 单词查询');
{
  const r = repo.searchEnhanced({ sessionId, query: 'XTAR', searchIn: ['key', 'value'] });
  assert('搜索 "XTAR" 返回含 XTAR 的条目（≥3）', r.items.length >= 3,
    `实际返回 ${r.items.length} 条`);
  assert('不返回完全无关的条目', r.items.every(i => i.key.includes('XTAR') || i.value.includes('XTAR')),
    `有条目不含 XTAR`);
}

// ── 2. 多词 AND（默认）——两词分散在不同字段也能命中 ───────────────────────
console.log('\n【2】多词 AND 搜索（默认 matchMode:"and"）');
{
  const r = repo.searchEnhanced({
    sessionId,
    query: 'XTAR 结汇人',
    searchIn: ['key', 'value'],
  });
  assert('两词分散在 key/value 的条目均被召回（应返回 2 条）', r.items.length === 2,
    `实际返回 ${r.items.length} 条：${r.items.map(i => i.key).join(', ')}`);
  assert('"XTAR说明"（只含XTAR，不含结汇人）不应在结果里',
    !r.items.some(i => i.key === 'XTAR说明'));
  assert('"审核规则"（只含结汇人，不含XTAR）不应在结果里',
    !r.items.some(i => i.key === '审核规则'));
}

// ── 3. 多词 AND 显式声明 ───────────────────────────────────────────────────
console.log('\n【3】多词 AND 显式声明（matchMode:"and"）');
{
  const r = repo.searchEnhanced({
    sessionId,
    query: 'user authentication',
    searchIn: ['key', 'value'],
    matchMode: 'and',
  });
  assert('"user authentication" AND 返回 2 条（auth module + login page）', r.items.length === 2,
    `实际 ${r.items.length} 条：${r.items.map(i => i.key).join(', ')}`);
}

// ── 4. 多词 OR ─────────────────────────────────────────────────────────────
console.log('\n【4】多词 OR 搜索（matchMode:"or"）');
{
  const r = repo.searchEnhanced({
    sessionId,
    query: 'XTAR 结汇人',
    searchIn: ['key', 'value'],
    matchMode: 'or',
  });
  assert('OR 返回更多（包含只含 XTAR 或只含 结汇人 的条目，应 ≥4）', r.items.length >= 4,
    `实际 ${r.items.length} 条`);
  assert('OR 包含只含 XTAR 的条目（"XTAR说明"）', r.items.some(i => i.key === 'XTAR说明'));
  assert('OR 包含只含 结汇人 的条目（"审核规则"）', r.items.some(i => i.key === '审核规则'));
}

// ── 5. AND 中有一词完全不存在 → 返回空 ────────────────────────────────────
console.log('\n【5】AND — 有一词完全不存在时返回空');
{
  const r = repo.searchEnhanced({
    sessionId,
    query: 'XTAR 不存在的词xyz',
    searchIn: ['key', 'value'],
    matchMode: 'and',
  });
  assert('AND 所有词都必须命中，有词不存在则返回 0 条', r.items.length === 0,
    `实际 ${r.items.length} 条`);
}

// ── 6. searchAcrossSessionsEnhanced 也支持 matchMode ──────────────────────
console.log('\n【6】跨会话搜索也支持 matchMode');
{
  const r = repo.searchAcrossSessionsEnhanced({
    query: 'XTAR 结汇人',
    searchIn: ['key', 'value'],
    matchMode: 'and',
  });
  assert('跨会话 AND 搜索返回正确条目（≥2）', r.items.length >= 2,
    `实际 ${r.items.length} 条`);
}

// ── 7. FTS5 搜索 ───────────────────────────────────────────────────────────
if (fts5Available) {
  console.log('\n【7】FTS5 全文搜索（useFts5:true）');

  // 7a. 3字以上词能被命中
  {
    const r = repo.searchEnhanced({
      sessionId,
      query: '结汇人',
      searchIn: ['key', 'value'],
      useFts5: true,
    });
    assert('FTS5 能找到 3 字中文词"结汇人"（≥2 条）', r.items.length >= 2,
      `实际 ${r.items.length} 条`);
  }

  // 7b. 短于 3 字的词自动降级到 LIKE，不崩溃
  {
    const r = repo.searchEnhanced({
      sessionId,
      query: '结汇',   // 2 字，trigram 无法处理
      searchIn: ['key', 'value'],
      useFts5: true,
    });
    assert('FTS5 短词（<3字）自动降级 LIKE，不崩溃，返回结果', r.items.length >= 0);
    assert('降级后 LIKE 仍能找到"结汇"相关条目', r.items.length >= 2,
      `实际 ${r.items.length} 条`);
  }

  // 7c. FTS5 多词 AND 交叉匹配
  {
    const r = repo.searchEnhanced({
      sessionId,
      query: 'XTAR 结汇人',
      searchIn: ['key', 'value'],
      useFts5: true,
      matchMode: 'and',
    });
    assert('FTS5 多词 AND 交叉匹配（应返回 2 条）', r.items.length === 2,
      `实际 ${r.items.length} 条：${r.items.map(i => i.key).join(', ')}`);
  }

  // 7d. useFts5:false 结果与 LIKE 一致
  {
    const rLike = repo.searchEnhanced({
      sessionId,
      query: 'authentication',
      searchIn: ['key', 'value'],
      useFts5: false,
    });
    const rFts = repo.searchEnhanced({
      sessionId,
      query: 'authentication',
      searchIn: ['key', 'value'],
      useFts5: true,
    });
    const likeKeys = new Set(rLike.items.map(i => i.key));
    const ftsKeys  = new Set(rFts.items.map(i => i.key));
    const sameCount = rLike.items.length === rFts.items.length;
    const sameItems = [...likeKeys].every(k => ftsKeys.has(k));
    assert('FTS5 与 LIKE 对相同单词返回相同条目集合', sameCount && sameItems,
      `LIKE:${rLike.items.length} FTS5:${rFts.items.length}`);
  }

  // 7e. BM25 排序——更相关的在前
  {
    const r = repo.searchEnhanced({
      sessionId,
      query: 'authentication',
      searchIn: ['key', 'value'],
      useFts5: true,
    });
    assert('FTS5 BM25 排序正常执行（有结果且不崩溃）', r.items.length > 0);
    console.log(`     排序结果：${r.items.map(i => i.key).join(' > ')}`);
  }
} else {
  console.log('\n【7】FTS5 — ⚠️  trigram 不可用，跳过（LIKE 兜底已在上方验证）');
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════');
console.log(`  结果：${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
console.log('═══════════════════════════════════════════════════\n');

// 清理
dbManager.close();
fs.rmSync(dbPath, { force: true });

process.exit(failed > 0 ? 1 : 0);
