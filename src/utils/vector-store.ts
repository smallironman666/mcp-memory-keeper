import { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, any>;
}

export interface SearchResult {
  id: string;
  contentId: string; // context_items.id，供 hybrid search RRF 合并使用
  content: string;
  similarity: number;
  metadata?: Record<string, any>;
}

// 延迟初始化的 ONNX embedding pipeline（lazy singleton）
let _pipeline: any = null;

async function getEmbeddingPipeline(): Promise<any> {
  if (!_pipeline) {
    const { pipeline } = await import('@huggingface/transformers');
    _pipeline = await (pipeline as any)('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true, // 量化版 ~23MB，M1 Max ARM64 原生支持
    });
  }
  return _pipeline;
}

export class VectorStore {
  private db: Database;
  private dimension: number = 384;

  constructor(db: Database) {
    this.db = db;
    this.initializeTables();
  }

  private initializeTables(): void {
    // Create vector storage table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_embeddings (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (content_id) REFERENCES context_items(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_vector_content_id ON vector_embeddings(content_id);
    `);
  }

  // 使用 @huggingface/transformers ONNX 真语义嵌入（all-MiniLM-L6-v2，量化版 23MB）
  // 首次调用加载模型 ~500ms，之后常驻内存 <10ms/条
  async createEmbedding(text: string): Promise<number[]> {
    const extractor = await getEmbeddingPipeline();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data) as number[];
  }

  // Cosine similarity between two embeddings
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude > 0 ? dotProduct / magnitude : 0;
  }

  // Store a document with its embedding
  async storeDocument(
    contentId: string,
    content: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    const id = uuidv4();
    const embedding = await this.createEmbedding(content);

    // Convert embedding to buffer for storage
    const buffer = Buffer.from(new Float32Array(embedding).buffer);

    const stmt = this.db.prepare(`
      INSERT INTO vector_embeddings (id, content_id, content, embedding, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, contentId, content, buffer, metadata ? JSON.stringify(metadata) : null);

    return id;
  }

  // Search for similar documents
  async search(
    query: string,
    topK: number = 10,
    minSimilarity: number = 0.3
  ): Promise<SearchResult[]> {
    const queryEmbedding = await this.createEmbedding(query);

    const rows = this.db
      .prepare('SELECT id, content_id, content, embedding, metadata FROM vector_embeddings')
      .all() as any[];

    const results: SearchResult[] = [];

    for (const row of rows) {
      const buffer = row.embedding as Buffer;
      const embedding = Array.from(
        new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      );

      const similarity = this.cosineSimilarity(queryEmbedding, embedding);

      if (similarity >= minSimilarity) {
        results.push({
          id: row.id,
          contentId: row.content_id,
          content: row.content,
          similarity,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, topK);
  }

  // Search within a specific session
  async searchInSession(
    sessionId: string,
    query: string,
    topK: number = 10,
    minSimilarity: number = 0.1
  ): Promise<SearchResult[]> {
    const queryEmbedding = await this.createEmbedding(query);

    const rows = this.db
      .prepare(
        `SELECT ve.id, ve.content_id, ve.content, ve.embedding, ve.metadata
         FROM vector_embeddings ve
         JOIN context_items ci ON ve.content_id = ci.id
         WHERE ci.session_id = ?`
      )
      .all(sessionId) as any[];

    const results: SearchResult[] = [];

    for (const row of rows) {
      const buffer = row.embedding as Buffer;
      const embedding = Array.from(
        new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      );

      const similarity = this.cosineSimilarity(queryEmbedding, embedding);

      if (similarity >= minSimilarity) {
        results.push({
          id: row.id,
          contentId: row.content_id,
          content: row.content,
          similarity,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, topK);
  }

  // Find related documents to a given document
  async findRelated(
    documentId: string,
    topK: number = 10,
    minSimilarity: number = 0.3
  ): Promise<SearchResult[]> {
    const doc = this.db
      .prepare('SELECT content, embedding FROM vector_embeddings WHERE id = ?')
      .get(documentId) as any;

    if (!doc) {
      return [];
    }

    const buffer = doc.embedding as Buffer;
    const targetEmbedding = Array.from(
      new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
    );

    const rows = this.db
      .prepare(
        'SELECT id, content_id, content, embedding, metadata FROM vector_embeddings WHERE id != ?'
      )
      .all(documentId) as any[];

    const results: SearchResult[] = [];

    for (const row of rows) {
      const rowBuffer = row.embedding as Buffer;
      const embedding = Array.from(
        new Float32Array(rowBuffer.buffer, rowBuffer.byteOffset, rowBuffer.byteLength / 4)
      );

      const similarity = this.cosineSimilarity(targetEmbedding, embedding);

      if (similarity >= minSimilarity) {
        results.push({
          id: row.id,
          contentId: row.content_id,
          content: row.content,
          similarity,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, topK);
  }

  // Update embeddings for all context items in a session
  async updateSessionEmbeddings(sessionId: string): Promise<number> {
    // Get all context items without embeddings
    const items = this.db
      .prepare(
        `
      SELECT ci.id, ci.key, ci.value, ci.category, ci.priority
      FROM context_items ci
      LEFT JOIN vector_embeddings ve ON ci.id = ve.content_id
      WHERE ci.session_id = ? AND ve.id IS NULL
    `
      )
      .all(sessionId) as any[];

    let count = 0;
    for (const item of items) {
      const content = `${item.key}: ${item.value}`;
      const metadata = {
        key: item.key,
        category: item.category,
        priority: item.priority,
      };

      await this.storeDocument(item.id, content, metadata);
      count++;
    }

    return count;
  }

  // Delete embeddings for a content item
  deleteEmbedding(contentId: string): void {
    this.db.prepare('DELETE FROM vector_embeddings WHERE content_id = ?').run(contentId);
  }

  // Get statistics
  getStats(): { totalDocuments: number; avgSimilarity?: number } {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM vector_embeddings').get() as any;

    return {
      totalDocuments: count.count,
    };
  }
}
