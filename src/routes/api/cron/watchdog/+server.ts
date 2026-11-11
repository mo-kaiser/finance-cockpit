import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { assessSync, berlin } from '$lib/monitor/health';
import { recentSyncRuns, sendAlert } from '$lib/server/alert';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 30 };

/**
 * Wächter (Vercel Cron, täglich nachmittags): meldet per E-Mail, wenn seit über 2 Tagen kein Abruf
 * erfolgreich war oder ein Lauf hängen geblieben ist. Fehlgeschlagene Läufe meldet der Abruf selbst.
 */
export const GET: RequestHandler = async ({ request }) => {
	const secret = env.CRON_SECRET;
	if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) error(401, 'Nicht autorisiert');

	let problems: string[];
	let level: string;
	try {
		const admin = supabaseAdmin();
		const health = assessSync(await recentSyncRuns(admin));
		level = health.level;
		// Nur das melden, was der Abruf nicht schon selbst gemeldet hat
		problems = health.problems.filter((p) => !p.startsWith('Letzter Lauf fehlgeschlagen'));

		// Hängengebliebene Läufe als abgebrochen markieren, damit sie nur einmal gemeldet werden
		for (const r of health.stuck) {
			await admin
				.from('imports')
				.update({ status: 'failed', finished_at: new Date().toISOString(), note: `${r.note ?? ''} – abgebrochen (Wächter)`.slice(0, 2000) })
				.eq('id', r.id);
		}
		if (problems.length) problems.push('', `Letzter erfolgreicher Abruf: ${berlin(health.lastSuccess)}`);
	} catch (e) {
		level = 'error';
		problems = [`Der Wächter konnte den Zustand nicht lesen: ${(e as Error).message}`];
	}

	if (!problems.length) return json({ ok: true, level });

	const mail = await sendAlert('Bitget-Abruf braucht Aufmerksamkeit', [
		'Der Wächter hat beim täglichen Bitget-Abruf ein Problem gefunden.',
		'Bitget liefert Kontobuchungen nur 90 Tage rückwirkend – bitte zeitnah prüfen und auf der System-Seite nachladen.',
		'',
		...problems
	]);
	return json({ ok: false, level, problems, mail: mail.ok ? 'gesendet' : mail.error });
};
