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
			// Bitget-Kürzel: Endung r = lesen (z. B. coor, taxr); alles andere ist ein Schreib-/Handelsrecht
			const risky = authorities.filter((a) => !/(r|read|readonly)$/i.test(a));
			return { bitget: { ok: true, authorities, risky, ips: info.ips ?? '' } };
		} catch (e) {
			const err = e as BitgetError;
			return { bitget: { ok: false, error: `${err.message}${err.code ? ` (Code ${err.code})` : ''}` } };
		}
	},
	supabase: async () => {
		try {
			const { data, error, status } = await supabaseAdmin().from('imports').select('id').limit(100);
			if (error) {
				const detail = [error.message, error.code && `Code ${error.code}`, error.hint, `HTTP ${status}`].filter(Boolean).join(' · ');
				throw new Error(detail);
			}
			return { supabase: { ok: true, imports: data.length } };
		} catch (e) {
			return { supabase: { ok: false, error: (e as Error).message || 'Unbekannter Fehler ohne Meldung' } };
		}
	}
};
