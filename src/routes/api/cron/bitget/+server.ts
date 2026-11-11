import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { DAY_MS, ENDPOINTS, fetchWindow, ownerId, storeRecords, windows } from '$lib/server/bitget-sync';
import { sendAlert } from '$lib/server/alert';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

/** Rückblick pro Lauf: mehrere Tage Überlappung, damit ein ausgefallener Lauf nichts verliert. */
const LOOKBACK_DAYS = 5;

/** Täglicher Abruf durch Vercel Cron (nur auf Production). Vercel sendet „Authorization: Bearer CRON_SECRET“. */
export const GET: RequestHandler = async ({ request }) => {
	const secret = env.CRON_SECRET;
	if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) error(401, 'Nicht autorisiert');

	let importId: string | null = null;
	const summary: Record<string, unknown> = {};
	let failed = false;

	try {
		const admin = supabaseAdmin();
		const userId = await ownerId(admin);

		const { data: imp, error: impErr } = await admin
			.from('imports')
			.insert({ user_id: userId, source: 'bitget_api', note: 'Cron', source_timezone: 'UTC' })
			.select('id')
			.single();
		if (impErr) throw new Error(`Lauf anlegen: ${impErr.message}`);
		importId = imp.id as string;

		const end = Date.now();
		const start = end - LOOKBACK_DAYS * DAY_MS;

		for (const ep of ENDPOINTS) {
			try {
				let received = 0;
				let stored = 0;
				for (const w of windows(ep, start, end)) {
					const items = await fetchWindow(ep, w.start, w.end);
					const r = await storeRecords(admin, userId, importId, ep, items);
					received += r.received;
					stored += r.stored;
				}
				summary[ep.key] = { received, stored };
			} catch (e) {
				failed = true;
				summary[ep.key] = { error: (e as Error).message };
			}
		}

		await admin
			.from('imports')
			.update({
				status: failed ? 'failed' : 'done',
				finished_at: new Date().toISOString(),
				note: JSON.stringify(summary).slice(0, 2000)
			})
			.eq('id', importId);
	} catch (e) {
		// Fehler vor oder nach dem Abruf (Supabase, Secret Key …): ebenfalls melden
		failed = true;
		summary.fatal = (e as Error).message;
	}

	if (failed) {
		const mail = await sendAlert('Täglicher Bitget-Abruf fehlgeschlagen', [
			'Der tägliche Abruf der Bitget-Buchungen ist fehlgeschlagen.',
			'Bitget liefert Kontobuchungen nur 90 Tage rückwirkend – bitte zeitnah prüfen und auf der System-Seite nachladen.',
			'',
			...Object.entries(summary).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		]);
		summary.mail = mail.ok ? 'gesendet' : mail.error;
	}

	return json({ ok: !failed, importId, summary }, { status: failed ? 500 : 200 });
};
