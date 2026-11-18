import { error, json } from '@sveltejs/kit';
import { syncCoinPrices } from '#lib/server/prices.ts';
import { supabaseAdmin } from '#lib/server/supabase-admin.ts';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

/** Lädt die Tageskurse eines Coins ab einem Tag nach (System-Seite, Coin für Coin). */
export const POST: RequestHandler = async ({ locals, request }) => {
	const claims = await locals.getClaims();
	if (claims?.aal !== 'aal2') error(401, 'Nicht angemeldet');

	const body = (await request.json()) as { coin?: string; from?: string };
	const coin = String(body.coin ?? '').toUpperCase();
	const from = String(body.from ?? '');
	if (!/^[A-Z0-9]{1,20}$/.test(coin)) error(400, 'Ungültiger Coin');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) error(400, 'Ungültiges Datum');

	return json(await syncCoinPrices(supabaseAdmin(), coin, from));
};
