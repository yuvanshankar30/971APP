// Shared budget spend calculation, used by the purchasing page and the admin
// Budgets tab. Previously each had its own copy, which drifted — keep all
// budget-matching rules here.

export const BUDGET_EXEMPT_PROJECT = 'Budget Exempt';

/**
 * The categories a purchase can be filed under, grouped by the real budget
 * line each one is spent against.
 *
 * The purchasing dropdown used to be one flat list with no hint of where the
 * money actually came from, so an item's category and the budget it hit were
 * only connected in somebody's head. Grouping them here - once - keeps the
 * purchasing page and the admin Budgets tab agreeing on both the list and the
 * roll-up; all three copies of this list used to drift independently.
 *
 * Build-linked purchases (a specific subsystem release) are robot spend too,
 * but their project_ids come from the builds table rather than this list.
 */
export const BUDGET_CATEGORY_GROUPS = [
  { budget: 'Robot', categories: ['Manufacturing Stock'] },
  {
    budget: 'General Supplies',
    categories: [
      'Mechanical Supply',
      'Mechanical Consumable',
      'Electrical Supply',
      'Electrical Consumable',
      'Lab Supply',
      'Lab Consumable',
      'Software Supply',
      'Software Consumable'
    ]
  },
  { budget: 'Competition', categories: ['Competition'] },
  { budget: 'Admin', categories: ['Outreach + Fundraising'] },
  { budget: '9584', categories: ['9584 misc'] },
  // Not a budget line. "Other" sits here rather than among the real
  // categories because anything filed under it is money that cannot be
  // reported against any budget - worth making that visible at the moment
  // somebody picks it.
  { budget: 'Not tracked against a budget', categories: [BUDGET_EXEMPT_PROJECT, 'Other'] }
];

/** Flat list of every selectable purchasing category, in group order. */
export const PURCHASING_CATEGORIES = BUDGET_CATEGORY_GROUPS.flatMap((group) => group.categories);

/**
 * Sum spending that counts against a budget.
 *
 * Rules:
 * - "Budget Exempt" project rows never count.
 * - Projects listed in budget.metadata.exclude_projects never count
 *   (e.g. the offseason grant budget excludes competition expenses).
 * - If budget.metadata.include_projects is set, ONLY those projects count.
 *   An allowlist mirroring exclude_projects, for a budget that covers a
 *   named set of categories rather than one project or everything: a
 *   "General Supplies" line is the eight supply/consumable categories and
 *   nothing else, which 'overall' (matches every purchase) could not say.
 * - Rejected items never count.
 * - Items must fall inside the budget's start/end dates (by created_at).
 * - Scope: 'overall' matches everything; 'project'/'build' match project_id
 *   exactly; 'subsystem'/'build_group' match by substring.
 * - Cost is (final_price || price) × quantity; shipping is not included.
 */
export function calculateBudgetSpent(budget, allPurchases) {
  const excludedProjects = Array.isArray(budget?.metadata?.exclude_projects)
    ? budget.metadata.exclude_projects
    : [];

  const includedProjects = Array.isArray(budget?.metadata?.include_projects)
    ? budget.metadata.include_projects
    : null;

  const matches = (allPurchases || []).filter((p) => {
    if ((p.project_id || '').trim() === BUDGET_EXEMPT_PROJECT) return false;
    if (excludedProjects.includes((p.project_id || '').trim())) return false;
    if (includedProjects && !includedProjects.includes((p.project_id || '').trim())) return false;

    if (p.status === 'rejected') return false;

    if (budget.start_date && new Date(p.created_at) < new Date(budget.start_date)) return false;
    if (budget.end_date && new Date(p.created_at) > new Date(budget.end_date)) return false;

    if (budget.scope_type === 'overall') return true;
    if (budget.scope_type === 'project') {
      return p.project_id === budget.scope_value;
    }
    if (budget.scope_type === 'subsystem') {
      return p.project_id && p.project_id.includes(budget.scope_value);
    }
    if (budget.scope_type === 'build') {
      return p.project_id === budget.scope_value;
    }
    if (budget.scope_type === 'build_group') {
      return p.project_id && p.project_id.includes(budget.scope_value);
    }
    return false;
  });

  return matches.reduce((sum, p) => {
    return sum + ((p.final_price || p.price || 0) * (p.quantity || 1));
  }, 0);
}
