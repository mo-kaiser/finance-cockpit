import { error, json } from '@sveltejs/kit';
import { BitgetError } from '$lib/server/bitget';
import { earliestStart, endpointByKey, fetchWindow, storeRecords } from '$lib/server/bitget-sync';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

/** Ruft genau ein Zeitfenster einer Schnittstelle ab und speichert die Rohdaten (für den manuellen Nachlauf). */
export const POST: RequestHandler = async ({ locals, request }) => {
	const claims = await locals.getClaims();
	if (claims?.aal !== 'aal2') error(401, 'Nicht angemeldet');

	const body = (await request.json()) as { key: string; start: number; end: number };
	const ep = endpointByKey(body.key);
	if (!ep) error(400, 'Unbekannte Schnittstelle');
	const end = body.end;
	const start = Math.max(body.start, earliestStart(ep));
	if (!(end > start) || end - start > ep.windowDays * 86_400_000 + 1000) error(400, 'Ungültiges Zeitfenster');

	try {
		const items = await fetchWindow(ep, start, end);
		const r = await storeRecords(supabaseAdmin(), claims.sub, null, ep, items);
		return json(r);
	} catch (e) {
		const err = e as BitgetError;
		error(502, `${err.message}${err.code ? ` (${err.code})` : ''}`);
	}
};
