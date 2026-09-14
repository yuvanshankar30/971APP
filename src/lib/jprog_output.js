import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { getAuthHeader } from '$lib/supabase.js';

const OUTPUT_PATH = /^Jprog Output\/\d{8}\/[A-Za-z0-9._-]+\.(?:ngc|tap)$/i;

export function isJprogOutputPath(storagePath) {
	return OUTPUT_PATH.test(String(storagePath || ''));
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
