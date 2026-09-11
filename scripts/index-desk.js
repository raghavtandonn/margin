import { reindex, indexSize, MODEL_ID } from '../lib/vectors.js';

// Batch indexer. The only permitted progress output is the word INDEXING.
console.log('INDEXING');
const t0 = Date.now();
const r = reindex({
  onProgress: (done, total) => process.stdout.write(`INDEXING ${done}/${total}\n`)
});
console.log(`INDEXING COMPLETE  ${r.books} BOOKS · ${r.notes} NOTES · ${r.vocabulary} TERMS · ${Date.now() - t0}MS · ${MODEL_ID}`);
