import adapter from '@sveltejs/adapter-vercel';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		// SvelteKit's own built-in checkOrigin has no per-route escape hatch,
		// and /install/fusion-runner/setup (the browser page setup.py opens
		// to collect the Fusion Runner admin token) is a genuine, non-JS
		// HTML <form method="post"> that legitimately needs one - see
		// src/hooks.server.js's own csrfCheck, which re-implements this
		// exact protection for every other route. Confirmed by grep: no
		// route in this app uses SvelteKit's form-actions
		// (`export const actions`) anywhere else, so this route is the
		// *only* thing checkOrigin was ever protecting here.
		csrf: {
			checkOrigin: false
		},
		// AutoCAM's engine/components/docs live in a dedicated top-level
		// autocam/ folder (not under src/lib) - +page.svelte/+server.js files
		// can't move there themselves (SvelteKit's routing is determined by
		// their location under src/routes/), but everything else that isn't
		// routing-bound does, and imports it via this alias instead of a
		// relative path.
		alias: {
			$autocam: 'autocam',
			'$autocam/*': 'autocam/*'
		}
	}
};

export default config;
