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

function base64ToBlob(base64) {
	const binary = atob(base64.replace(/\n/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes]);
}

// Output files exist in the GitHub repository, not in Supabase Storage.
// Save the fetched contents through a blob URL so the download stays in the
// current tab and retains the repository filename.
export async function downloadOutputRepoFile(path) {
	const { name, content } = await callManageFunction({ action: 'download', path });
	const blobUrl = URL.createObjectURL(base64ToBlob(content));
	const link = document.createElement('a');
	link.href = blobUrl;
	link.download = name || path.split('/').pop();
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(blobUrl);
}
