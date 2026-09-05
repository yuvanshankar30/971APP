/** Planning groups only: a shared stock category does not establish geometric fit. */
export function groupFusionParts(parts, categories) {
  const knownCategories = new Map(categories.map((category) => [String(category.id), category]));
  const groups = new Map();
  for (const part of parts) {
    const categoryId = part.category_id == null ? null : String(part.category_id);
    // Keep unresolved stock separate per part; never imply it is compatible.
    const category = knownCategories.get(categoryId);
    const key = category ? `category:${categoryId}` : `unresolved:${part.id}`;
    if (!groups.has(key)) {
      groups.set(key, { key, categoryId: category ? categoryId : null, category: category || null, parts: [], remainingQuantity: 0 });
    }
    const group = groups.get(key);
    group.parts.push(part);
    const quantity = Number(part.quantity);
    if (Number.isSafeInteger(quantity) && quantity > 0) group.remainingQuantity += quantity;
  }
  return [...groups.values()];
}

export function platePartQuantity(plate, part) {
  return Number(plate.fusion_part_category_assignments?.find((a) => String(a.fusion_parts?.id) === String(part.id))?.quantity || 0);
}

export function eligiblePlateParts(plate, parts) {
  return parts.filter((part) => part.category_id != null && plate.category_id != null
    && String(part.category_id) === String(plate.category_id)
    && (Number(part.quantity) > 0 || platePartQuantity(plate, part) > 0));
}
