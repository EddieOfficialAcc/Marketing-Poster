// The index is derived from persisted asset metadata, never from OCR or guesses.
// Rebuild after upload, metadata changes, or API sync. Prices do not belong here.
// A decimal point between digits is kept (as ∙, which is not punctuation) so 1.5L and 15L stay different.
export const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/(?<=\p{N})\.(?=\p{N})/gu, '∙').replace(/[\p{P}\p{Z}\s_]+/gu, '');
export const basename = value => String(value ?? '').replace(/\.[^.]+$/, '');
export class ProductFileIndex {
  constructor(products = []) { this.rebuild(products); }
  rebuild(products) {
    this.records = products.map(product => ({ product, fields: [
      { kind: '商品名稱', value: product.name },
      { kind: 'SKU', value: product.sku },
      { kind: '檔案名稱', value: basename(product.filename) },
      { kind: '檔案名稱', value: product.filename },
      ...(product.aliases ?? []).map(value => ({ kind: '別名', value })),
    ].map(field => ({ ...field, key: normalize(field.value) })).filter(field => field.key) }));
  }
  search(query) {
    const q = normalize(query);
    if (!q) return this.records.map(({product}) => ({product, score: 0, exact: false, matchedBy: ''}));
    return this.records.flatMap(({product, fields}) => {
      const matches = fields.map(field => ({field, score: field.key === q ? 100 : field.key.startsWith(q) ? 70 : field.key.includes(q) ? 50 : 0})).filter(m => m.score);
      matches.sort((a,b) => b.score - a.score);
      return matches.length ? [{ product, score: matches[0].score, exact: matches[0].score === 100, matchedBy: matches[0].field.kind }] : [];
    }).sort((a,b) => b.score - a.score || a.product.name.localeCompare(b.product.name, 'zh-Hant'));
  }
  resolve(query) {
    if (!normalize(query)) return {status: 'empty', matches: []};
    const matches = this.search(query), exact = matches.filter(m => m.exact);
    // A unique exact name, SKU, alias, or filename can be linked automatically.
    // Partial matches and multiple exact matches always require user selection.
    if (exact.length === 1) return { status: 'matched', product: exact[0].product, matches };
    // An image and its own cutouts share name and code: that is one product, not a real
    // ambiguity. Prefer the newest cutout (transparent background).
    const family = exact.map(m => m.product), root = family.find(p => p.source !== 'cutout');
    if (root && family.every(p => p === root || (p.source === 'cutout' && p.originalAssetId === root.id))) {
      const cutouts = family.filter(p => p !== root);
      return { status: 'matched', product: cutouts.length ? cutouts.at(-1) : root, matches };
    }
    return { status: matches.length ? 'choose' : 'missing', matches };
  }
}
