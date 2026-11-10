import { createBrowserClient, createServerClient, isBrowser } from '@supabase/ssr';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '$lib/supabase-config';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ data, depends, fetch }) => {
	depends('supabase:auth');

	const supabase = isBrowser()
		? createBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
				global: { fetch }
			})
		: createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
				global: { fetch },
				cookies: { getAll: () => data.cookies }
			});

	return { supabase, claims: data.claims };
};
