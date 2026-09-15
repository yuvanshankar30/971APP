import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { getAuthHeader } from '$lib/supabase.js';
import { jprogOutputDateFolder } from '$lib/jprog_date.js';

const OUTPUT_ROOT = 'JustinProgOutput';
const OUTPUT_PATH = /^JustinProgOutput\/\d{8}\/[^/\\\0]+\.(?:ngc|tap)$/i;
const OUTPUT_FOLDER_PATH = /^JustinProgOutput\/\d{8}$/;
const OUTPUT_FILENAME = /^[^/\\\0]+\.(?:ngc|tap)$/i;

export function isJprogOutputPath(storagePath) {
	return OUTPUT_PATH.test(String(storagePath || ''));
}

// Files added at the JProg root belong in the current date folder. Once an
// operator opens a date folder, preserve that folder so manual additions can
// be made to an existing day's output and mirrored to the same GitHub path.
export function jprogOutputUploadPath(currentPath, filename, date = new Date()) {
	const folder = String(currentPath || '').replace(/\/+$/, '');
	const name = String(filename || '').trim();
	if (folder !== OUTPUT_ROOT && !OUTPUT_FOLDER_PATH.test(folder)) return null;
	if (!OUTPUT_FILENAME.test(name)) {
		throw new Error('JustinProgOutput accepts only .ngc or .tap files without path separators.');
	}
	const targetFolder = folder === OUTPUT_ROOT ? `${OUTPUT_ROOT}/${jprogOutputDateFolder(date)}` : folder;
	return `${targetFolder}/${name}`;
}

export async function publishJprogOutput(storagePath, content) {
	if (!isJprogOutputPath(storagePath)) return;
	const response = await fetch(`${PUBLIC_SUPABASE_URL}/functions/v1/jprog-output`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: PUBLIC_SUPABASE_ANON_KEY,
			...(await getAuthHeader())
		},
		body: JSON.stringify({ storagePath, content })
	});
	if (!response.ok) {
		const detail = await response.json().catch(() => ({}));
		throw new Error(detail.error || 'Could not publish JProg output to GitHub.');
	}
}
