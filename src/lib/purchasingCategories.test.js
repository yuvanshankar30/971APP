import { describe, it, expect } from 'vitest';
import {
  loadPurchasingCategories,
  addPurchasingCategory,
  renamePurchasingCategory,
  deletePurchasingCategory
} from './purchasingCategories.js';

// A thin stand-in for the supabase client: records what was asked of it and
// replays a canned result, so these tests pin the query shape and the error
// translation rather than needing a database.
function fakeSupabase({ result = { data: [], error: null } } = {}) {
  const calls = { table: null, select: null, order: [], insert: null, update: null, deleted: null, eq: null };
  const builder = {
    select(columns) {
      calls.select = columns;
      return builder;
    },
    order(column, options) {
      calls.order.push({ column, ...options });
      return builder;
    },
    insert(rows) {
      calls.insert = rows;
      return builder;
    },
    update(patch) {
      calls.update = patch;
      return builder;
    },
    delete() {
      calls.deleted = true;
      return builder;
    },
    eq(column, value) {
      calls.eq = { column, value };
      return builder;
    },
    single() {
      return Promise.resolve(result);
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    }
  };
  return {
    calls,
    from(table) {
      calls.table = table;
      return builder;
    }
  };
}

describe('loadPurchasingCategories', () => {
  it('reads the shared table in the shop\'s own order', async () => {
    const rows = [{ id: '1', name: 'Manufacturing', sort_order: 10 }];
    const supabase = fakeSupabase({ result: { data: rows, error: null } });

    const categories = await loadPurchasingCategories(supabase);

    expect(categories).toEqual(rows);
    expect(supabase.calls.table).toBe('purchasing_categories');
    // sort_order first so the shop's own ordering wins, name only to break ties.
    expect(supabase.calls.order.map((o) => o.column)).toEqual(['sort_order', 'name']);
  });

  it('returns an array when the table is empty rather than null', async () => {
    const supabase = fakeSupabase({ result: { data: null, error: null } });
    await expect(loadPurchasingCategories(supabase)).resolves.toEqual([]);
  });

  it('surfaces a read failure instead of pretending there are no categories', async () => {
    const supabase = fakeSupabase({ result: { data: null, error: new Error('nope') } });
    await expect(loadPurchasingCategories(supabase)).rejects.toThrow('nope');
  });
});

describe('addPurchasingCategory', () => {
  it('trims the name and records who added it', async () => {
    const created = { id: '2', name: 'Superpit', sort_order: 100 };
    const supabase = fakeSupabase({ result: { data: created, error: null } });

    const result = await addPurchasingCategory(supabase, '  Superpit  ', 'user-1');

    expect(result).toEqual(created);
    expect(supabase.calls.insert).toEqual([{ name: 'Superpit', created_by: 'user-1' }]);
  });

  it('refuses a blank name', async () => {
    const supabase = fakeSupabase();
    await expect(addPurchasingCategory(supabase, '   ')).rejects.toThrow(/needs a name/);
    expect(supabase.calls.insert).toBeNull();
  });

  it('explains a duplicate rather than leaking the unique-violation code', async () => {
    // Names are unique case-insensitively, so this is what someone typing
    // "field" when "Field" already exists actually hits.
    const supabase = fakeSupabase({ result: { data: null, error: { code: '23505' } } });
    await expect(addPurchasingCategory(supabase, 'field')).rejects.toThrow(/already exists/);
  });
});

describe('renamePurchasingCategory', () => {
  it('trims the new name and targets the right row', async () => {
    const supabase = fakeSupabase({ result: { data: null, error: null } });

    await renamePurchasingCategory(supabase, 'cat-1', '  Field  ');

    expect(supabase.calls.update).toEqual({ name: 'Field' });
    expect(supabase.calls.eq).toEqual({ column: 'id', value: 'cat-1' });
  });

  it('refuses a blank name', async () => {
    const supabase = fakeSupabase();
    await expect(renamePurchasingCategory(supabase, 'cat-1', '')).rejects.toThrow(/needs a name/);
    expect(supabase.calls.update).toBeNull();
  });

  it('explains a duplicate the same way adding one does', async () => {
    const supabase = fakeSupabase({ result: { data: null, error: { code: '23505' } } });
    await expect(renamePurchasingCategory(supabase, 'cat-1', 'Field')).rejects.toThrow(/already exists/);
  });
});

describe('deletePurchasingCategory', () => {
  it('deletes by id', async () => {
    const supabase = fakeSupabase({ result: { data: null, error: null } });

    await deletePurchasingCategory(supabase, 'cat-9');

    expect(supabase.calls.deleted).toBe(true);
    expect(supabase.calls.eq).toEqual({ column: 'id', value: 'cat-9' });
  });

  it('surfaces a delete failure', async () => {
    const supabase = fakeSupabase({ result: { data: null, error: new Error('denied') } });
    await expect(deletePurchasingCategory(supabase, 'cat-9')).rejects.toThrow('denied');
  });
});
