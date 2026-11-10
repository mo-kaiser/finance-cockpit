import { error, json } from '@sveltejs/kit';
import { bitgetGet, BitgetError } from '$lib/server/bitget';
import { DAY_MS, endpointByKey } from '$lib/server/bitget-sync';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

/**
 * Reichweiten-Prüfung für eine Schnittstelle: fragt Monatsfenster rückwärts ab (je nur die erste Seite),
 * liefert eine Beispielbuchung und prüft, ob Bitget-IDs als Tx-ID im CoinTracking-Import vorkommen.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const claims = await locals.getClaims();
	if (claims?.aal !== 'aal2') error(401, 'Nicht angemeldet');

	const { key, months = 14 } = (await request.json()) as { key: string; months?: number };
	const ep = endpointByKey(key);
	if (!ep) error(400, 'Unbekannte Schnittstelle');

	const now = Date.now();
	const results: { from: string; to: string; count: number | null; error?: string }[] = [];
	let sample: unknown = null;
	const ids: string[] = [];

	// Fenster in der Breite, die die Schnittstelle erlaubt, gebündelt pro ca. 30 Tage
	const step = Math.min(30, ep.windowDays) * DAY_MS;
	const span = Math.ceil((months * 30) / Math.min(30, ep.windowDays));
	for (let i = 0; i < span; i++) {
		const end = now - i * step;
		const start = end - step;
		const row = { from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10), count: null as number | null, error: undefined as string | undefined };
		try {
			const data = await bitgetGet(ep.path, { ...ep.params, startTime: start, endTime: end, limit: ep.limit });
			const items = ep.list(data);
			row.count = items.length;
			if (items.length && !sample) sample = items[0];
			for (const it of items.slice(0, 20)) if (it[ep.idField] != null) ids.push(String(it[ep.idField]));
		} catch (e) {
			const err = e as BitgetError;
			row.error = `${err.message}${err.code ? ` (${err.code})` : ''}`;
		}
		results.push(row);
		if (row.error && i > 0 && results[i - 1]?.error) break; // zwei Fehler hintereinander: Ende der Reichweite
		await new Promise((r) => setTimeout(r, 120)); // Rate-Limit schonen
	}

	// Passen Bitget-IDs zu CoinTracking-Tx-IDs (exakt oder mit Suffix wie _earn)?
	let ctMatches: { checked: number; matched: number; examples: string[] } | null = null;
	if (ids.length) {
		const sampleIds = ids.slice(0, 40);
		const { data, error: dbErr } = await supabaseAdmin()
			.from('ct_rows')
			.select('tx_id')
			.or(sampleIds.map((id) => `tx_id.like.${id}*`).join(','))
			.limit(100);
		ctMatches = dbErr
			? { checked: sampleIds.length, matched: -1, examples: [dbErr.message] }
			: {
					checked: sampleIds.length,
					matched: new Set(sampleIds.filter((id) => data.some((r) => r.tx_id.startsWith(id)))).size,
					examples: data.slice(0, 5).map((r) => r.tx_id)
				};
	}

	return json({ key, label: ep.label, windowDays: ep.windowDays, results, sample, ctMatches });
};
