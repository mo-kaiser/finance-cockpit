import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { asset, FIAT_EUR, USD_STABLE } from '$lib/tax/assets';
import { sendAlert } from '$lib/server/alert';
import { dayBefore, priceStatus, syncCoinPrices, type PriceSyncResult } from '$lib/server/prices';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

/**
 * Täglicher Kursabruf (Vercel Cron, nach dem Bitget-Abruf):
 *   * alle Coins, für die schon Kurse vorliegen: die letzten Tage ergänzen
 *   * Coins, die in den letzten 10 Tagen neu in den Bitget-Buchungen auftauchen (z. B. neuer Airdrop): ab Erstauftreten
 * Die Historie lädt man einmalig auf der System-Seite nach.
 */
export const GET: RequestHandler = async ({ request }) => {
	const secret = env.CRON_SECRET;
	if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) error(401, 'Nicht autorisiert');

	const started = Date.now();
	const results: PriceSyncResult[] = [];
	let fatal: string | null = null;

	try {
		const admin = supabaseAdmin();
		const status = await priceStatus(admin);
		const yesterday = dayBefore(new Date().toISOString().slice(0, 10));
		const todo = new Map<string, string>();
		for (const s of status) if (s.last_day < yesterday) todo.set(s.coin, dayBefore(s.last_day, -1));

		// neue Coins aus den API-Buchungen der letzten 10 Tage
		const since = new Date(Date.now() - 10 * 86_400_000).toISOString();
		const { data: recent, error: recErr } = await admin.from('v_api_ledger').select('coin, day').gte('ts', since);
		if (recErr) throw new Error(`v_api_ledger: ${recErr.message}`);
		const known = new Set(status.map((s) => s.coin));
		for (const r of (recent ?? []) as { coin: string | null; day: string }[]) {
			if (!r.coin) continue;
			const c = asset(r.coin);
			if (c === FIAT_EUR || USD_STABLE.has(c) || known.has(c)) continue;
			const prev = todo.get(c);
			if (!prev || r.day < prev) todo.set(c, r.day);
		}

		for (const [coin, from] of todo) {
			if (Date.now() - started > 50_000) {
				fatal = `Zeitlimit: ${todo.size - results.length} Coins nicht mehr abgerufen`;
				break;
			}
			results.push(await syncCoinPrices(admin, coin, from));
		}
	} catch (e) {
		fatal = (e as Error).message;
	}

	// Fehlende Handelspaare sind kein Fehler (delistete Token); echte Fehler melden
	const errors = results.filter((r) => r.error && !r.unavailable);
	if (fatal || errors.length) {
		await sendAlert('Täglicher Kursabruf mit Fehlern', [
			'Beim täglichen Abruf der Coin-Tageskurse ist etwas schiefgegangen. Fehlende Tage lassen sich auf der System-Seite nachladen.',
			'',
			...(fatal ? [fatal] : []),
			...errors.map((r) => `${r.coin}: ${r.error}`)
		]);
	}

	return json(
		{ ok: !fatal && !errors.length, fatal, coins: results.length, stored: results.reduce((s, r) => s + r.stored, 0), results },
		{ status: fatal || errors.length ? 500 : 200 }
	);
};
