// The budget categories a purchase can be filed under, read from the
// database rather than hardcoded.
//
// These lived as a literal array in three .svelte files. Two problems the
// shop actually hit: the copies drifted apart, and adding a category meant a
// code change and a deploy. Direct instruction: anyone may add one, and it
// has to appear for everyone else - so the list is shared data.
//
// A category's NAME is the key. purchasing.project_id is plain text and
// stores that name directly, which is what calculateBudgetSpent matches on.

/** Every category, in the order the shop lists them. */
export async function loadPurchasingCategories(supabase) {
  const { data, error } = await supabase
    .from('purchasing_categories')
    .select('id, name, sort_order')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Add a category for everyone.
 *
 * Names are unique case-insensitively in the database, so "Field" and
 * "field" cannot become two categories quietly splitting one budget's spend
 * between them. That collision comes back as a readable message rather than
 * a raw Postgres unique-violation.
 */
export async function addPurchasingCategory(supabase, name, createdBy = null) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('A budget category needs a name.');

  const { data, error } = await supabase
    .from('purchasing_categories')
    .insert([{ name: trimmed, created_by: createdBy }])
    .select('id, name, sort_order')
    .single();

  if (error) {
    if (error.code === '23505') throw new Error(`"${trimmed}" already exists as a budget category.`);
    throw error;
  }
  return data;
}

/**
 * Rename a category.
 *
 * Purchases already filed under the old name keep that text, so a rename
 * splits one budget line into two unless those rows are moved too. The
 * caller is responsible for that; see the admin Budgets tab, which says so
 * before it renames anything.
 */
export async function renamePurchasingCategory(supabase, id, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('A budget category needs a name.');

  const { error } = await supabase
    .from('purchasing_categories')
    .update({ name: trimmed })
    .eq('id', id);

  if (error) {
    if (error.code === '23505') throw new Error(`"${trimmed}" already exists as a budget category.`);
    throw error;
  }
}

export async function deletePurchasingCategory(supabase, id) {
  const { error } = await supabase.from('purchasing_categories').delete().eq('id', id);
  if (error) throw error;
}
