import path from 'node:path';
import fs from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// @sentry/sveltekit's client entry isn't picked up by Vite's static
	// dependency scanner, so it gets discovered lazily on first request and
	// triggers a mid-request "optimized dependencies changed, reloading"
	// cycle — visible as repeated "file does not exist" chunk errors and a
	// page that never finishes loading. Force it into the upfront pre-bundle
	// instead so optimization happens once, before any request is served.
	optimizeDeps: {
		include: ['@sentry/sveltekit']
	},
	server: {
		fs: {
			// SvelteKit's own Vite plugin sets server.fs.allow to just
			// src/, node_modules/, and the .svelte-kit outDir - it has no
			// idea the $autocam alias (svelte.config.js) points at a
			// sibling top-level autocam/ folder. Vite's fs.strict check
			// runs against that allowlist regardless of alias resolution,
			// so every $autocam/* import 403s in dev without this entry.
			// Worktrees may share the primary checkout's node_modules through a
			// symlink. Vite checks the resolved path, so allow that real directory
			// as well or its own SvelteKit client entry returns 403 and hydration
			// never starts.
			allow: [path.resolve('autocam'), fs.realpathSync(path.resolve('node_modules'))]
		}
	}
});
