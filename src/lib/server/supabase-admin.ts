import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { SUPABASE_URL } from '$lib/supabase-config';

/** Supabase-Client mit Secret Key: umgeht RLS. Nur serverseitig (Cron) verwenden. */
export function supabaseAdmin() {
	if (!env.SUPABASE_SECRET_KEY) throw new Error('SUPABASE_SECRET_KEY fehlt');
	return createClient(SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});
}
