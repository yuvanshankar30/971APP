import { supabase } from '$lib/supabase.js';
const BUCKET = 'manufacturing-drive';
const PART_ROOT = 'Nesting Parts Library';
const OUTPUT_ROOT = 'Nesting Output';
const clean = (value) => String(value || '').replace(/^\/+|\/+$/g, '');

export async function listPartsLibrary(prefix = PART_ROOT) {
  const base = clean(prefix);
  const { data, error } = await supabase.storage.from(BUCKET).list(base, { limit: 200, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw error;
  const entries = data || [];
  const nested = await Promise.all(entries.filter((entry) => entry.id === null).map(async (folder) => {
    const { data: files, error: nestedError } = await supabase.storage.from(BUCKET).list(`${base}/${folder.name}`, { limit: 200, sortBy: { column: 'name', order: 'asc' } });
    if (nestedError) throw nestedError;
    return (files || []).filter((file) => file.id !== null).map((file) => ({ ...file, path: `${base}/${folder.name}/${file.name}` }));
  }));
  return [...entries.filter((entry) => entry.id !== null).map((file) => ({ ...file, path: `${base}/${file.name}` })), ...nested.flat()];
}
export async function uploadPartFile(file, folder) {
  const path = `${PART_ROOT}/${clean(folder)}/${file.name}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}
export async function downloadText(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data.text();
}
export async function uploadEmittedGcode(filename, text) {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const path = `${OUTPUT_ROOT}/${day}/${filename}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, new Blob([text], { type: 'text/plain' }), { upsert: true });
  if (error) throw error;
  return path;
}
