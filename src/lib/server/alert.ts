import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import type { SyncRun } from '$lib/monitor/health';

/**
 * E-Mail-Warnung über Resend (https://resend.com), ohne SDK.
 * RESEND_API_KEY und ALERT_EMAIL_TO kommen aus Vercel. Ohne eigene Domain darf Resend nur
 * von onboarding@resend.dev an die eigene Konto-Adresse senden – das reicht für Warnungen.
 */
export async function sendAlert(subject: string, lines: string[]): Promise<{ ok: boolean; error?: string }> {
	const key = env.RESEND_API_KEY?.trim();
	const to = env.ALERT_EMAIL_TO?.trim();
	if (!key || !to) return { ok: false, error: 'RESEND_API_KEY oder ALERT_EMAIL_TO fehlt' };
	const from = env.ALERT_EMAIL_FROM?.trim() || 'Cockpit <onboarding@resend.dev>';

	const text = [...lines, '', 'System-Seite: https://cockpit.moritz-kaiser.com/system'].join('\n');
	try {
		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
			body: JSON.stringify({ from, to: to.split(',').map((s) => s.trim()), subject: `[Cockpit] ${subject}`, text })
		});
		if (!res.ok) return { ok: false, error: `Resend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
		return { ok: true };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

/** Die letzten Läufe des Bitget-Abrufs (Cron und frühere API-Läufe). */
export async function recentSyncRuns(admin: SupabaseClient, limit = 30): Promise<SyncRun[]> {
	const { data, error } = await admin
		.from('imports')
		.select('id, status, note, created_at, finished_at')
		.eq('source', 'bitget_api')
		.order('created_at', { ascending: false })
		.limit(limit);
	if (error) throw new Error(`imports: ${error.message}`);
	return (data ?? []) as SyncRun[];
}
