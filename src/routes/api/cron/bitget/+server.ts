import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { DAY_MS, ENDPOINTS, fetchWindow, ownerId, storeRecords, windows } from '$lib/server/bitget-sync';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

/** Rückblick pro Lauf: mehrere Tage Überlappung, damit ein ausgefallener Lauf nichts verliert. */
const LOOKBACK_DAYS = 5;

/** Täglicher Abruf durch Vercel Cron (nur auf Production). Vercel sendet „Authorization: Bearer CRON_SECRET“. */
export const GET: RequestHandler = async ({ request }) => {
	const secret = env.CRON_SECRET;
	if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) error(401, 'Nicht autorisiert');

	const admin = supabaseAdmin();
	const userId = await ownerId(admin);

	const { data: imp, error: impErr } = await admin
		.from('imports')
		.insert({ user_id: userId, source: 'bitget_api', note: 'Cron', source_timezone: 'UTC' })
		.select('id')
		.single();
	if (impErr) error(500, impErr.message);

	const end = Date.now();
	const start = end - LOOKBACK_DAYS * DAY_MS;
	const summary: Record<string, unknown> = {};
	let failed = false;

	for (const ep of ENDPOINTS) {
		try {
			let received = 0;
			let stored = 0;
			for (const w of windows(ep, start, end)) {
				const items = await fetchWindow(ep, w.start, w.end);
				const r = await storeRecords(admin, userId, imp.id, ep, items);
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
		.eq('id', imp.id);

	return json({ ok: !failed, summary });
};
