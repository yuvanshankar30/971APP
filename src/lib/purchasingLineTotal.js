/**
 * Return a purchasing line total from its unit price and quantity.
 *
 * A missing price stays missing so the UI does not imply that an unpriced
 * item costs $0. Quantity follows the purchasing table's existing fallback
 * of one item when no valid positive quantity is stored.
 */
export function purchasingLineTotal(unitPrice, quantity) {
  if (unitPrice === null || unitPrice === undefined || unitPrice === '') return null;
  const price = Number(unitPrice);
  if (!Number.isFinite(price)) return null;

  const parsedQuantity = Number(quantity);
  const itemCount = Number.isFinite(parsedQuantity) && parsedQuantity > 0
    ? parsedQuantity
    : 1;

  return price * itemCount;
}
