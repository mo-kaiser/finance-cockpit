import { env } from '$env/dynamic/private';
import { bitgetGet, BitgetError } from '$lib/server/bitget';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import { ENDPOINTS } from '$lib/server/bitget-sync';
import { sendAlert } from '$lib/server/alert';
import type { SyncRun } from '$lib/monitor/health';
import type { Actions, PageServerLoad } from './$types';

const VARS = [
	'BITGET_API_KEY',
	'BITGET_API_SECRET',
	'BITGET_API_PASSPHRASE',
	'SUPABASE_SECRET_KEY',
	'CRON_SECRET',
	'RESEND_API_KEY',
	'ALERT_EMAIL_TO',
	'BACKUP_SECRET'
] as const;

export const load: PageServerLoad = async ({ locals }) => {
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
	const { data: runs, error: runsErr } = await locals.supabase
		.from('imports')
		.select('id, status, note, created_at, finished_at')
		.eq('source', 'bitget_api')
		.order('created_at', { ascending: false })
		.limit(30);
	return {
		vars,
		syncRuns: (runs ?? []) as SyncRun[],
		syncRunsError: runsErr?.message ?? null,
		vercelEnv: env.VERCEL_ENV ?? 'lokal',
		endpoints: ENDPOINTS.map((e) => ({ key: e.key, label: e.label, windowDays: e.windowDays, maxDays: e.maxDays, role: e.role }))
	};
};

interface AccountInfo {
	userId?: string;
	authorities?: string[];
	ips?: string;
	parentId?: number | string;
}

export const actions: Actions = {
	testmail: async () => {
		const r = await sendAlert('Test-E-Mail', [
			'Diese E-Mail wurde auf der System-Seite des Cockpits ausgelöst.',
			`Umgebung: ${env.VERCEL_ENV ?? 'lokal'}`,
			'Wenn sie ankommt, funktionieren die Warnungen des täglichen Abrufs.'
		]);
		return { testmail: r };
	},
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
