import { describe, it, expect } from 'vitest';
import { calculateBudgetSpent, BUDGET_CATEGORY_GROUPS, PURCHASING_CATEGORIES } from './budget.js';

const overall = (extra = {}) => ({ scope_type: 'overall', ...extra });

const item = (overrides = {}) => ({
  project_id: 'Lab Supply',
  status: 'approved',
  price: 10,
  quantity: 1,
  final_price: null,
  created_at: '2026-06-01T00:00:00Z',
  ...overrides
});

describe('calculateBudgetSpent', () => {
  it('sums price × quantity for matching items', () => {
    const spent = calculateBudgetSpent(overall(), [
      item({ price: 10, quantity: 2 }),
      item({ price: 5.5 })
    ]);
    expect(spent).toBeCloseTo(25.5);
  });

  it('prefers final_price over price', () => {
    const spent = calculateBudgetSpent(overall(), [
      item({ price: 10, final_price: 8, quantity: 3 })
    ]);
    expect(spent).toBeCloseTo(24);
  });

  it('defaults missing quantity to 1 and missing prices to 0', () => {
    const spent = calculateBudgetSpent(overall(), [
      item({ quantity: null }),
      item({ price: null, final_price: null })
    ]);
    expect(spent).toBeCloseTo(10);
  });

  it('excludes rejected items', () => {
    const spent = calculateBudgetSpent(overall(), [
      item(),
      item({ status: 'rejected', price: 100 })
    ]);
    expect(spent).toBeCloseTo(10);
  });

  it('excludes the Budget Exempt project (with whitespace tolerance)', () => {
    const spent = calculateBudgetSpent(overall(), [
      item({ project_id: 'Budget Exempt', price: 100 }),
      item({ project_id: '  Budget Exempt  ', price: 100 }),
      item()
    ]);
    expect(spent).toBeCloseTo(10);
  });

  it('excludes projects listed in metadata.exclude_projects', () => {
    const budget = overall({ metadata: { exclude_projects: ['Competition'] } });
    const spent = calculateBudgetSpent(budget, [
      item({ project_id: 'Competition', price: 500 }),
      item()
    ]);
    expect(spent).toBeCloseTo(10);
  });

  it('tolerates missing or malformed metadata', () => {
    expect(calculateBudgetSpent(overall({ metadata: null }), [item()])).toBeCloseTo(10);
    expect(
      calculateBudgetSpent(overall({ metadata: { exclude_projects: 'Competition' } }), [item()])
    ).toBeCloseTo(10);
  });

  it('applies the start_date filter on created_at', () => {
    const budget = overall({ start_date: '2026-05-01' });
    const spent = calculateBudgetSpent(budget, [
      item({ created_at: '2026-04-20T00:00:00Z', price: 100 }), // season spend
      item({ created_at: '2026-06-13T00:00:00Z', price: 31 })
    ]);
    expect(spent).toBeCloseTo(31);
  });

  it('applies the end_date filter on created_at', () => {
    const budget = overall({ start_date: '2026-05-01', end_date: '2026-07-01' });
    const spent = calculateBudgetSpent(budget, [
      item({ created_at: '2026-06-13T00:00:00Z', price: 31 }),
      item({ created_at: '2026-07-13T00:00:00Z', price: 100 })
    ]);
    expect(spent).toBeCloseTo(31);
  });

  it('matches project scope exactly', () => {
    const budget = { scope_type: 'project', scope_value: 'Lab Supply' };
    const spent = calculateBudgetSpent(budget, [
      item(),
      item({ project_id: 'Lab Supply Extra', price: 100 }),
      item({ project_id: 'Other', price: 100 })
    ]);
    expect(spent).toBeCloseTo(10);
  });

  it('matches subsystem/build_group scope by substring', () => {
    const budget = { scope_type: 'subsystem', scope_value: 'Shooter' };
    const spent = calculateBudgetSpent(budget, [
      item({ project_id: '2026Shooter2-V172', price: 9.99 }),
      item({ project_id: '2026Slapdown-slapdowning', price: 100 })
    ]);
    expect(spent).toBeCloseTo(9.99);
  });

  it('returns 0 for unknown scope types and empty inputs', () => {
    expect(calculateBudgetSpent({ scope_type: 'bogus' }, [item()])).toBe(0);
    expect(calculateBudgetSpent(overall(), [])).toBe(0);
    expect(calculateBudgetSpent(overall(), null)).toBe(0);
  });

  it('reproduces the Offseason 2026 budget shape end-to-end', () => {
    const offseason = {
      scope_type: 'overall',
      start_date: '2026-05-01',
      end_date: null,
      metadata: { exclude_projects: ['Competition'] }
    };
    const parts = [
      item({ project_id: 'Lab Supply', price: 79.98, created_at: '2026-07-13T00:00:00Z' }),
      item({ project_id: 'Lab Supply', price: 38.0, quantity: 6, created_at: '2026-07-13T00:00:00Z' }),
      item({ project_id: 'Lab Supply', price: 35.88, quantity: 2, created_at: '2026-07-13T00:00:00Z' }),
      item({ project_id: 'Other', price: 31.0, created_at: '2026-06-13T00:00:00Z' }),
      item({ project_id: 'Competition', price: 5000, created_at: '2026-06-20T00:00:00Z' }),
      item({ project_id: '2026Slapdown-slapdowning', price: 30.5, quantity: 4, created_at: '2026-04-21T00:00:00Z' })
    ];
    expect(calculateBudgetSpent(offseason, parts)).toBeCloseTo(410.74);
  });

  describe('include_projects allowlist', () => {
    it('counts only the listed projects', () => {
      // What "General Supplies" needs and 'overall' could not express: a
      // budget covering a named set of categories, not every purchase.
      const generalSupplies = overall({
        metadata: { include_projects: ['Lab Supply', 'Mechanical Consumable'] }
      });
      const spent = calculateBudgetSpent(generalSupplies, [
        item({ project_id: 'Lab Supply', price: 100 }),
        item({ project_id: 'Mechanical Consumable', price: 50 }),
        item({ project_id: 'Competition', price: 5000 }),
        item({ project_id: '2026Shooter-V146', price: 900 })
      ]);
      expect(spent).toBeCloseTo(150);
    });

    it('still counts everything when it is absent', () => {
      const spent = calculateBudgetSpent(overall(), [
        item({ project_id: 'Competition', price: 40 }),
        item({ project_id: 'Lab Supply', price: 2 })
      ]);
      expect(spent).toBeCloseTo(42);
    });

    it('never overrides the exclusions that already applied', () => {
      const budget = overall({
        metadata: {
          include_projects: ['Lab Supply', 'Budget Exempt'],
          exclude_projects: ['Lab Supply']
        }
      });
      const spent = calculateBudgetSpent(budget, [
        item({ project_id: 'Lab Supply', price: 10 }),
        item({ project_id: 'Budget Exempt', price: 999 }),
        item({ project_id: 'Lab Supply', price: 10, status: 'rejected' })
      ]);
      expect(spent).toBe(0);
    });
  });

  describe('BUDGET_CATEGORY_GROUPS', () => {
    it('files every selectable category under exactly one budget', () => {
      const seen = new Set();
      for (const group of BUDGET_CATEGORY_GROUPS) {
        for (const category of group.categories) {
          expect(seen.has(category)).toBe(false);
          seen.add(category);
        }
      }
      expect(PURCHASING_CATEGORIES).toHaveLength(seen.size);
    });

    it('keeps Budget Exempt out of the real budget lines', () => {
      const realLines = BUDGET_CATEGORY_GROUPS.filter(
        (group) => group.budget !== 'Not tracked against a budget'
      );
      expect(realLines.flatMap((group) => group.categories)).not.toContain('Budget Exempt');
    });
  });
});
