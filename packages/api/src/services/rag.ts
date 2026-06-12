interface Chunk { content: string }

export function rankChunks(query: string, chunks: Chunk[]): Chunk[] {
  const queryTerms = tokenize(query);
  const idf = buildIdf(queryTerms, chunks);

  const scored = chunks.map(chunk => {
    const terms = tokenize(chunk.content);
    const tf = queryTerms.reduce((sum, t) => sum + terms.filter(w => w === t).length / (terms.length || 1), 0);
    const score = queryTerms.reduce((sum, t) => sum + (tf * (idf.get(t) || 0)), 0);
    return { chunk, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.chunk);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
}

function buildIdf(terms: string[], chunks: Chunk[]): Map<string, number> {
  const n = chunks.length || 1;
  const idf = new Map<string, number>();
  for (const t of terms) {
    const df = chunks.filter(c => c.content.toLowerCase().includes(t)).length || 1;
    idf.set(t, Math.log(n / df));
  }
  return idf;
}
