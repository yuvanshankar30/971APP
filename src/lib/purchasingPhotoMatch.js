const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'item', 'part', 'inc', 'llc', 'www', 'com']);

export function tokenizePurchaseText(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)))];
}

function overlap(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length / left.length;
}

function vendorTokens(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch { /* optional vendor URL */ }
  return tokenizePurchaseText(`${item.vendor || ''} ${domain}`);
}

// Scores only meaningful token overlap. A loose substring check turns generic
// packaging words into false matches, which is particularly risky for a write
// action such as receiving an item.
export function rankPurchasingPhotoCandidates(extraction, items, limit = 5) {
  const productTokens = tokenizePurchaseText(extraction?.productName);
  const rawTokens = tokenizePurchaseText(extraction?.rawText);
  const guessedVendorTokens = tokenizePurchaseText(extraction?.vendorGuess);

  return (items || []).map((item) => {
    const itemTokens = tokenizePurchaseText(`${item.name || ''} ${item.part_number || ''}`);
    const nameScore = overlap(productTokens, itemTokens);
    const rawScore = overlap(itemTokens, rawTokens);
    const vendorScore = overlap(guessedVendorTokens, vendorTokens(item));
    const score = Math.min(1, (nameScore * 0.65) + (rawScore * 0.25) + (vendorScore * 0.10));
    return { item, score: Math.round(score * 100) / 100 };
  }).filter(({ score }) => score >= 0.2)
    .sort((a, b) => b.score - a.score || String(a.item.name || '').localeCompare(String(b.item.name || '')))
    .slice(0, limit);
}
