import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { getAuthHeader } from '$lib/supabase.js';

async function callManageFunction(payload) {
	const response = await fetch(`${PUBLIC_SUPABASE_URL}/functions/v1/jprog-output-manage`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: PUBLIC_SUPABASE_ANON_KEY,
			...(await getAuthHeader())
		},
		body: JSON.stringify(payload)
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || 'Could not reach the JProg output repository.');
	return body;
}

// entries: [{ name, path, type: 'file'|'dir', size }], sorted folders-first.
export async function listOutputRepoEntries(path = '') {
	const { entries } = await callManageFunction({ action: 'list', path });
	return entries || [];
}

export async function createOutputRepoFolder(path) {
	await callManageFunction({ action: 'mkdir', path });
}

export async function deleteOutputRepoEntry(path) {
	await callManageFunction({ action: 'delete', path });
}

export async function renameOutputRepoEntry(fromPath, toPath) {
	await callManageFunction({ action: 'rename', fromPath, toPath });
}

function readFileAsBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
		reader.onerror = () => reject(reader.error || new Error('Could not read that file.'));
		reader.readAsDataURL(file);
	});
}

// Every write here (upload/delete/mkdir/rename) is its own real commit via
// GitHub's Contents API - there is no separate "commit and push" step.
export async function uploadOutputRepoFile(path, file) {
	const content = await readFileAsBase64(file);
	await callManageFunction({ action: 'upload', path, content });
}
