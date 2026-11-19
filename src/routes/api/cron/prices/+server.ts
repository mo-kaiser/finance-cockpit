import { error, json } from '@sveltejs/kit';
import { CRON_SECRET } from '$app/env/private';
import { asset, FIAT_EUR, USD_STABLE } from '#lib/tax/assets.ts';
import { sendAlert } from '#lib/server/alert.ts';
import { dayBefore, priceStatus, syncCoinPrices, type PriceSyncResult } from '#lib/server/prices.ts';
import { supabaseAdmin } from '#lib/server/supabase-admin.ts';
import { parseEcbCsv } from '#lib/tax/fx.ts';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

/**
 * Täglicher Kursabruf (Vercel Cron, nach dem Bitget-Abruf):
 *   * alle Coins, für die schon Kurse vorliegen: die letzten Tage ergänzen
 *   * Coins, die in den letzten 10 Tagen neu in den Bitget- oder KuCoin-Buchungen auftauchen (z. B. neuer Airdrop): ab Erstauftreten
 *   * EZB-Referenzkurs EUR/USD: die letzten 14 Tage (die EZB veröffentlicht werktags gegen 16 Uhr)
 * Die Historie lädt man einmalig auf der System-Seite nach.
 */

const ECB_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A';

async function syncEcb(admin: ReturnType<typeof supabaseAdmin>) {
	const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
	const res = await fetch(`${ECB_URL}?startPeriod=${from}&format=csvdata`, { headers: { Accept: 'text/csv' } });
	if (!res.ok) throw new Error(`EZB-Abruf: HTTP ${res.status}`);
	const rows = parseEcbCsv(await res.text());
	if (!rows.length) return { count: 0, last: null };
	const { error } = await admin
		.from('fx_rates')
		.upsert(rows.map((r) => ({ rate_date: r.rate_date, pair: 'EURUSD', rate: r.rate, source: 'ECB' })), { onConflict: 'rate_date,pair,source' });
	if (error) throw new Error(`EZB-Kurse speichern: ${error.message}`);
	return { count: rows.length, last: rows[rows.length - 1]!.rate_date };
}
export const GET: RequestHandler = async ({ request }) => {
	const secret = CRON_SECRET;
	if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) error(401, 'Nicht autorisiert');

	const started = Date.now();
	const results: PriceSyncResult[] = [];
	let fatal: string | null = null;
	let ecb: { count: number; last: string | null } | null = null;
	let ecbError: string | null = null;

	try {
		const admin = supabaseAdmin();
		try {
			ecb = await syncEcb(admin);
		} catch (e) {
			ecbError = (e as Error).message;
		}
		const status = await priceStatus(admin);
		const yesterday = dayBefore(new Date().toISOString().slice(0, 10));
		const todo = new Map<string, string>();
		for (const s of status) if (s.last_day < yesterday) todo.set(s.coin, dayBefore(s.last_day, -1));

		// neue Coins aus den API-Buchungen der letzten 10 Tage (Bitget und KuCoin).
		// Direkt aus api_records statt über v_api_ledger: die View ist nur für angemeldete Nutzer freigegeben.
		const since = new Date(Date.now() - 10 * 86_400_000).toISOString();
		const { data: recent, error: recErr } = await admin
			.from('api_records')
			.select('ts, coin:raw->>coin, currency:raw->>currency')
			.gte('ts', since)
			.limit(5000);
		if (recErr) throw new Error(`api_records: ${recErr.message}`);
		const known = new Set(status.map((s) => s.coin));
		for (const r of (recent ?? []) as { ts: string; coin: string | null; currency: string | null }[]) {
			const raw = r.coin ?? r.currency;
			if (!raw) continue;
			const c = asset(raw);
			if (c === FIAT_EUR || USD_STABLE.has(c) || known.has(c)) continue;
			const day = new Date(r.ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
			const prev = todo.get(c);
			if (!prev || day < prev) todo.set(c, day);
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
	if (fatal || errors.length || ecbError) {
		await sendAlert('Täglicher Kursabruf mit Fehlern', [
			'Beim täglichen Abruf der Coin-Tageskurse ist etwas schiefgegangen. Fehlende Tage lassen sich auf der System-Seite nachladen.',
			'',
			...fatal ? [fatal] : [],
			...ecbError ? [ecbError] : [],
			...errors.map((r) => `${r.coin}: ${r.error}`)
		]);
	}

	return json(
		{ ok: !fatal && !errors.length && !ecbError, fatal, ecb, ecbError, coins: results.length, stored: results.reduce((s, r) => s + r.stored, 0), results },
		{ status: fatal || errors.length ? 500 : 200 }
	);
};
