// 测试环境下的 @huggingface/transformers mock（仅 jest 通过 moduleNameMapper 映射到此文件）
// 复用原 hash trigram 嵌入逻辑，保证单元/集成测试行为与引入神经嵌入之前完全一致，
// 同时 CI 无需下载 23MB ONNX 模型、无需网络、毫秒级返回。生产运行不经过此文件。
import * as crypto from 'crypto';

const DIMENSION = 384;

// 字符 trigram + 词级特征哈希，归一化到单位向量（与旧 VectorStore.createEmbedding 等价）
function hashTrigramEmbedding(text: string): Float32Array {
  const embedding = new Array(DIMENSION).fill(0);
  const normalizedText = String(text).toLowerCase().replace(/\s+/g, ' ').trim();

  const ngrams: string[] = [];
  for (let i = 0; i <= normalizedText.length - 3; i++) {
    ngrams.push(normalizedText.slice(i, i + 3));
  }
  const words = normalizedText.split(' ');
  for (const word of words) {
    if (word.length > 2) {
      ngrams.push(word);
    }
  }

  for (const ngram of ngrams) {
    const hash = crypto.createHash('md5').update(ngram).digest();
    for (let i = 0; i < 3; i++) {
      const position = ((hash[i * 2] << 8) | hash[i * 2 + 1]) % DIMENSION;
      const value = (hash[i * 2 + 2] % 256) / 255.0;
      embedding[position] += value;
    }
  }

  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= magnitude;
    }
  }

  return Float32Array.from(embedding);
}

// 模拟 @huggingface/transformers 的 pipeline 工厂：返回一个 feature-extraction extractor
export async function pipeline(_task: string, _model?: string, _options?: any) {
  return async (text: string, _opts?: any) => ({ data: hashTrigramEmbedding(text) });
}
