import { createServerClient } from '@supabase/ssr';
import { redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { dev } from '$app/environment';
import { env as privateEnv } from '$env/dynamic/private';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '$lib/supabase-config';
import type { AuthClaims } from './app';

/** Seiten, die ohne Login erreichbar sind. */
const PUBLIC_PATHS = ['/login', '/api/cron/']; // Cron prüft selbst den CRON_SECRET
/** Seiten, die mit Login, aber noch ohne zweiten Faktor erreichbar sind. */
const AAL1_PATHS = ['/mfa', '/logout'];

const supabase: Handle = async ({ event, resolve }) => {
	event.locals.supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
		cookies: {
			getAll: () => event.cookies.getAll(),
			setAll: (cookiesToSet) => {
				for (const { name, value, options } of cookiesToSet) {
					event.cookies.set(name, value, { ...options, path: '/' });
				}
			}
		}
	});

	let cached: Promise<AuthClaims | null> | undefined;
	// Nur lokal (vite dev) mit COCKPIT_DEMO=1: Ansicht ohne Login für Tests mit Beispieldaten.
	// `dev` ist im Produktivbuild fest false, dieser Zweig existiert dort nicht.
	if (dev && privateEnv.COCKPIT_DEMO === '1') {
		event.locals.getClaims = async () => ({ sub: '00000000-0000-0000-0000-000000000000', aal: 'aal2' });
		return resolve(event);
	}
	event.locals.getClaims = () => {
		cached ??= event.locals.supabase.auth.getClaims().then(({ data, error }) => {
			if (error || !data?.claims?.sub) return null;
			const c = data.claims as Record<string, unknown>;
			return {
				sub: String(c.sub),
				email: typeof c.email === 'string' ? c.email : undefined,
				aal: c.aal === 'aal2' ? 'aal2' : 'aal1'
			};
		});
		return cached;
	};

	return resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'content-range' || name === 'x-supabase-api-version'
	});
};

const guard: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

	if (!isPublic) {
		const claims = await event.locals.getClaims();
		if (!claims) redirect(303, '/login');
		const aal1Ok = AAL1_PATHS.some((p) => path.startsWith(p));
		if (claims.aal !== 'aal2' && !aal1Ok) redirect(303, '/mfa');
	}

	return resolve(event);
};

const headers: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	return response;
};

export const handle = sequence(supabase, guard, headers);
