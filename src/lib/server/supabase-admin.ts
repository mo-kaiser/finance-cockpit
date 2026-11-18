import { createClient } from '@supabase/supabase-js';
import { SUPABASE_SECRET_KEY } from '$app/env/private';
import { SUPABASE_URL } from '#lib/supabase-config.ts';

/** Supabase-Client mit Secret Key: umgeht RLS. Nur serverseitig (Cron) verwenden. */
export function supabaseAdmin() {
	if (!SUPABASE_SECRET_KEY) throw new Error('SUPABASE_SECRET_KEY fehlt');

	return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
