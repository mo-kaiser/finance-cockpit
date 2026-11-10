import { error, json } from '@sveltejs/kit';
import { parseEcbCsv } from '$lib/tax/fx';
import type { RequestHandler } from './$types';

// Referenzkurs: US-Dollar je 1 Euro, täglich (Quelle: EZB-Daten-API)
const ECB_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A';
const START = '2023-01-01';

export const POST: RequestHandler = async ({ locals, fetch }) => {
	const claims = await locals.getClaims();
	if (claims?.aal !== 'aal2') error(401, 'Nicht angemeldet');

	const res = await fetch(`${ECB_URL}?startPeriod=${START}&format=csvdata`, {
		headers: { Accept: 'text/csv' }
	});
	if (!res.ok) error(502, `EZB-Abruf fehlgeschlagen (HTTP ${res.status})`);

	let rows;
	try {
		rows = parseEcbCsv(await res.text());
	} catch (e) {
		error(502, (e as Error).message);
	}
	if (!rows.length) error(502, 'EZB hat keine Kurse geliefert');

	const payload = rows.map((r) => ({ rate_date: r.rate_date, pair: 'EURUSD', rate: r.rate, source: 'ECB' }));
	for (let i = 0; i < payload.length; i += 1000) {
		const { error: dbErr } = await locals.supabase
			.from('fx_rates')
			.upsert(payload.slice(i, i + 1000), { onConflict: 'rate_date,pair,source' });
		if (dbErr) error(500, dbErr.message);
	}

	return json({ count: rows.length, first: rows[0]!.rate_date, last: rows[rows.length - 1]!.rate_date });
};
