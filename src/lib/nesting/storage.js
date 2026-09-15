import { supabase } from "$lib/supabase.js";
import { jprogOutputDateFolder } from "$lib/jprog_date.js";
const BUCKET = "manufacturing-drive";
const PART_ROOT = "Nesting Parts Library";
const OUTPUT_ROOT = "JustinProgOutput";
const AUTOCAM_ROOT = "AutoCAM";
const clean = (value) => String(value || "").replace(/^\/+|\/+$/g, "");

export function sheetPartLibraryRoot(sheetName) {
  const name = clean(sheetName).replaceAll("/", "-");
  if (!name)
    throw new Error("Save the sheet with a name before adding part programs.");
  return `${PART_ROOT}/${name}`;
}

export async function listPartsLibrary(sheetName) {
  const base = sheetPartLibraryRoot(sheetName);
  return listPartLibraryAtPath(base);
}

async function listDirectory(path) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(path, {
      limit: 200,
      sortBy: { column: "updated_at", order: "desc" },
    });
  if (error) throw error;
  return data || [];
}

// A sheet keeps its own recent library, while the browser can reach every
// uploaded part program without making those storage paths part of the UI.
export async function listAllPartsLibrary() {
  const sheetFolders = (await listDirectory(PART_ROOT)).filter(
    (entry) => entry.id === null,
  );
  const files = await Promise.all(
    sheetFolders.map(async (sheetFolder) => {
      const sheetPath = `${PART_ROOT}/${sheetFolder.name}`;
      const entries = await listDirectory(sheetPath);
      const directFiles = entries
        .filter((entry) => entry.id !== null)
        .map((file) => ({ ...file, path: `${sheetPath}/${file.name}` }));
      const groupedFiles = await Promise.all(
        entries
          .filter((entry) => entry.id === null)
          .map(async (partFolder) => {
            const partPath = `${sheetPath}/${partFolder.name}`;
            return (await listDirectory(partPath))
              .filter((file) => file.id !== null)
              .map((file) => ({ ...file, path: `${partPath}/${file.name}` }));
          }),
      );
      return [...directFiles, ...groupedFiles.flat()];
    }),
  );
  return files.flat();
}

// Completed Fusion jobs are published into Files / AutoCAM. Keep this
// traversal here so JProg can list both legacy flat uploads and the current
// per-job folders without duplicating storage traversal in the editor.
export async function listAutoCamPrograms() {
  const rootEntries = await listDirectory(AUTOCAM_ROOT);
  const nested = await Promise.all(rootEntries.map(async (entry) => {
    const path = `${AUTOCAM_ROOT}/${entry.name}`;
    if (entry.id !== null) return [{ ...entry, path }];
    return (await listDirectory(path)).filter((file) => file.id !== null).map((file) => ({ ...file, path: `${path}/${file.name}` }));
  }));
  return nested.flat();
}

// Keep old saved placements renderable after the library became sheet-scoped.
export async function listPartLibraryAtPath(base) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(base, { limit: 200, sortBy: { column: "name", order: "asc" } });
  if (error) throw error;
  const entries = data || [];
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.id === null)
      .map(async (folder) => {
        const { data: files, error: nestedError } = await supabase.storage
          .from(BUCKET)
          .list(`${base}/${folder.name}`, {
            limit: 200,
            sortBy: { column: "name", order: "asc" },
          });
        if (nestedError) throw nestedError;
        return (files || [])
          .filter((file) => file.id !== null)
          .map((file) => ({
            ...file,
            path: `${base}/${folder.name}/${file.name}`,
          }));
      }),
  );
  return [
    ...entries
      .filter((entry) => entry.id !== null)
      .map((file) => ({ ...file, path: `${base}/${file.name}` })),
    ...nested.flat(),
  ];
}
export async function uploadPartFile(file, sheetName, folder) {
  const path = `${sheetPartLibraryRoot(sheetName)}/${clean(folder)}/${file.name}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}
export async function renamePartLibraryGroup(path, name) {
  const cleanName = clean(name).replaceAll("/", "-");
  if (!cleanName) throw new Error("Enter a part name.");
  const pieces = clean(path).split("/");
  if (pieces.length < 3)
    throw new Error("This part library entry cannot be renamed.");
  const sourceFolder = clean(path);
  const targetFolder = [...pieces.slice(0, -1), cleanName].join("/");
  if (sourceFolder === targetFolder) return targetFolder;
  const files = (await listDirectory(sourceFolder)).filter(
    (file) => file.id !== null,
  );
  if (!files.length) throw new Error("This part library entry has no files.");
  await Promise.all(
    files.map(async (file) => {
      const { error } = await supabase.storage
        .from(BUCKET)
        .move(`${sourceFolder}/${file.name}`, `${targetFolder}/${file.name}`);
      if (error) throw error;
    }),
  );
  return targetFolder;
}
export async function downloadText(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data.text();
}
export function emittedGcodePath(filename, date = new Date()) {
  const day = jprogOutputDateFolder(date);
  return `${OUTPUT_ROOT}/${day}/${filename}`;
}
export async function uploadEmittedGcode(filename, text) {
  const path = emittedGcodePath(filename);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, new Blob([text], { type: "text/plain" }), { upsert: true });
  if (error) throw error;
  return path;
}
