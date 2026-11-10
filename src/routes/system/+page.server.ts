import { env } from '$env/dynamic/private';
import { bitgetGet, BitgetError } from '$lib/server/bitget';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import type { Actions, PageServerLoad } from './$types';

const VARS = ['BITGET_API_KEY', 'BITGET_API_SECRET', 'BITGET_API_PASSPHRASE', 'SUPABASE_SECRET_KEY', 'CRON_SECRET'] as const;

export const load: PageServerLoad = async () => {
	// Nur ob vorhanden und wie lang – niemals den Wert selbst
	const vars = VARS.map((name) => {
		const v = env[name] ?? '';
		return {
			name,
			present: v.length > 0,
			length: v.length,
			whitespace: v !== v.trim(),
			quoted: /^["'].*["']$/.test(v)
		};
	});
	return { vars, vercelEnv: env.VERCEL_ENV ?? 'lokal' };
};

interface AccountInfo {
	userId?: string;
	authorities?: string[];
	ips?: string;
	parentId?: number | string;
}

export const actions: Actions = {
	bitget: async () => {
		try {
			const info = await bitgetGet<AccountInfo>('/api/v2/spot/account/info');
			const authorities = info.authorities ?? [];
			const risky = authorities.filter((a) => !/read|readonly/i.test(a));
			return { bitget: { ok: true, authorities, risky, ips: info.ips ?? '' } };
		} catch (e) {
			const err = e as BitgetError;
			return { bitget: { ok: false, error: `${err.message}${err.code ? ` (Code ${err.code})` : ''}` } };
		}
	},
	supabase: async () => {
		try {
			const { count, error } = await supabaseAdmin().from('imports').select('id', { count: 'exact', head: true });
			if (error) throw new Error(error.message);
			return { supabase: { ok: true, imports: count ?? 0 } };
		} catch (e) {
			return { supabase: { ok: false, error: (e as Error).message } };
		}
	}
};
