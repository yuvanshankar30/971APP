import { supabase } from '$lib/supabase.js';
const fail = (error) => { if (error) throw error; };
export async function listSheets() { const { data, error } = await supabase.from('nesting_sheets').select('*, nesting_cuts(*)').order('updated_at', { ascending: false }); fail(error); return data || []; }
export async function createSheet(values) {
  const { data: sheet, error } = await supabase.from('nesting_sheets').insert(values).select().single(); fail(error);
  const { data: cut, error: cutError } = await supabase.from('nesting_cuts').insert({ sheet_id: sheet.id, name: 'Cut 1' }).select().single(); fail(cutError);
  const { error: updateError } = await supabase.from('nesting_sheets').update({ active_cut_id: cut.id }).eq('id', sheet.id); fail(updateError);
  return { ...sheet, active_cut_id: cut.id, nesting_cuts: [cut] };
}
export async function getSheet(id) { const { data, error } = await supabase.from('nesting_sheets').select('*, nesting_cuts(*, nesting_placements(*))').eq('id', id).single(); fail(error); return data; }
export async function savePlacements(cutId, placements) {
  const { error: removeError } = await supabase.from('nesting_placements').delete().eq('cut_id', cutId); fail(removeError);
  if (!placements.length) return;
  const rows = placements.map(({ id, ...placement }) => ({ ...placement, cut_id: cutId }));
  const { error } = await supabase.from('nesting_placements').insert(rows); fail(error);
}
export async function createCut(sheetId, name) { const { data, error } = await supabase.from('nesting_cuts').insert({ sheet_id: sheetId, name }).select().single(); fail(error); return data; }
export async function setActiveCut(sheetId, cutId) { const { error } = await supabase.from('nesting_sheets').update({ active_cut_id: cutId, updated_at: new Date().toISOString() }).eq('id', sheetId); fail(error); }
export async function recordEmission(values) { const { error } = await supabase.from('nesting_emissions').insert(values); fail(error); }
