/**
 * PR-3: 重建 vector_embeddings 表的全量索引
 * 删除旧的 hash 嵌入数据，使用 all-MiniLM-L6-v2 ONNX 真语义嵌入重建
 *
 * 用法：npx tsx scripts/reindex-embeddings.ts
 *       npx tsx scripts/reindex-embeddings.ts --db /custom/path/context.db
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as os from 'os';

const args = process.argv.slice(2);
const dbFlagIdx = args.indexOf('--db');
const dbPath =
  dbFlagIdx >= 0 && args[dbFlagIdx + 1]
    ? args[dbFlagIdx + 1]
    : path.join(os.homedir(), 'mcp-data', 'memory-keeper', 'context.db');

console.log(`[reindex] DB path: ${dbPath}`);
console.log('[reindex] Loading all-MiniLM-L6-v2 ONNX pipeline (first time ~500ms)...');

async function main() {
  // 动态 import（ESM 模块在 CJS 环境下用 import()）
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await (pipeline as any)('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
  });
  console.log('[reindex] Pipeline ready.');

  const db = new Database(dbPath, { readonly: false });

  // 查待重建的条目
  const items = db
    .prepare(`SELECT id, key, value, category, priority FROM context_items`)
    .all() as any[];

  console.log(`[reindex] Found ${items.length} context_items. Clearing vector_embeddings...`);
  db.prepare('DELETE FROM vector_embeddings').run();

  const insert = db.prepare(`
    INSERT INTO vector_embeddings (id, content_id, content, embedding, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);

  let done = 0;
  const batchSize = 50;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const embedBatch = db.transaction(() => {
      for (const item of batch) {
        // 同步嵌入在事务外已拿到，这里只做写入
        insert.run(
          (item as any).__vecId,
          item.id,
          (item as any).__content,
          (item as any).__buffer,
          JSON.stringify({ key: item.key, category: item.category, priority: item.priority })
        );
      }
    });

    // 先异步生成嵌入（事务外）
    for (const item of batch) {
      const content = `${item.key}: ${item.value}`;
      const output = await extractor(content, { pooling: 'mean', normalize: true });
      const embedding = Array.from(output.data) as number[];
      const buffer = Buffer.from(new Float32Array(embedding).buffer);
      (item as any).__vecId = uuidv4();
      (item as any).__content = content;
      (item as any).__buffer = buffer;
    }

    // 再批量写入
    embedBatch();
    done += batch.length;
    console.log(`[reindex] ${done}/${items.length} embedded...`);
  }

  console.log(`[reindex] Done. ${done} embeddings rebuilt with all-MiniLM-L6-v2.`);
  db.close();
}

main().catch(err => {
  console.error('[reindex] Error:', err);
  process.exit(1);
});
