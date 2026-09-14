import { supabase } from '$lib/supabase.js';
const BUCKET = 'manufacturing-drive';
const PART_ROOT = 'Nesting Parts Library';
const OUTPUT_ROOT = 'Jprog Output';
const clean = (value) => String(value || '').replace(/^\/+|\/+$/g, '');

export function sheetPartLibraryRoot(sheetName) {
  const name = clean(sheetName).replaceAll('/', '-');
  if (!name) throw new Error('Save the sheet with a name before adding part programs.');
  return `${PART_ROOT}/${name}`;
}

export async function listPartsLibrary(sheetName) {
  const base = sheetPartLibraryRoot(sheetName);
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
export async function uploadPartFile(file, sheetName, folder) {
  const path = `${sheetPartLibraryRoot(sheetName)}/${clean(folder)}/${file.name}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}
export async function downloadText(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data.text();
}
export function emittedGcodePath(filename, date = new Date()) {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return `${OUTPUT_ROOT}/${day}/${filename}`;
}
export async function uploadEmittedGcode(filename, text) {
  const path = emittedGcodePath(filename);
  const { error } = await supabase.storage.from(BUCKET).upload(path, new Blob([text], { type: 'text/plain' }), { upsert: true });
  if (error) throw error;
  return path;
}
