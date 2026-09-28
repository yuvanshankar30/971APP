// Shared budget spend calculation, used by the purchasing page and the admin
// Budgets tab. Previously each had its own copy, which drifted — keep all
// budget-matching rules here.

export const BUDGET_EXEMPT_PROJECT = 'Budget Exempt';

/**
 * Sum spending that counts against a budget.
 *
 * Rules:
 * - "Budget Exempt" project rows never count.
 * - Projects listed in budget.metadata.exclude_projects never count
 *   (e.g. the offseason grant budget excludes competition expenses).
 * - If budget.metadata.include_projects is set, ONLY those projects count.
 *   An allowlist mirroring exclude_projects, for a budget line that covers
 *   several categories at once rather than one project or everything -
 *   something 'overall' (which matches every purchase) cannot express.
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
