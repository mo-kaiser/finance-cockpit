import type { SupabaseClient } from '@supabase/supabase-js';
import { bitgetPublic, BitgetError } from './bitget';

/**
 * Tageskurse von Bitget (öffentliche Tageskerzen, ohne API-Key).
 * GET /api/v2/spot/market/history-candles?symbol=BTCUSDT&granularity=1Dutc&endTime=…&limit=200
 * Antwort: [[ts, open, high, low, close, baseVol, usdtVol, quoteVol], …] als Strings, ts = Beginn des UTC-Tages.
 */

const DAY = 86_400_000;
const LIMIT = 200;

export interface DailyClose {
	day: string; // YYYY-MM-DD (UTC)
	close: string;
}

export interface PriceSyncResult {
	coin: string;
	symbol: string;
	received: number;
	stored: number;
	first: string | null;
	last: string | null;
	/** Bitget kennt das Handelspaar nicht (z. B. delistete Airdrop-Token) */
	unavailable?: boolean;
	error?: string;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Bitget-Fehlercodes für „Symbol unbekannt/nicht handelbar“ */
const UNKNOWN_SYMBOL = new Set(['40034', '40309', '40019', '40054', '43117']);

/** Abgeschlossene Tageskerzen von `fromDay` bis gestern (UTC), neueste zuerst abgefragt. */
export async function fetchDailyCloses(coin: string, fromDay: string, maxPages = 12): Promise<DailyClose[]> {
	const symbol = `${coin}USDT`;
	const today = utcDay(Date.now());
	const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
	const out = new Map<string, string>();
	let endTime = Date.now();

	for (let page = 0; page < maxPages; page++) {
		const rows = await bitgetPublic<unknown[][]>('/api/v2/spot/market/history-candles', {
			symbol,
			granularity: '1Dutc',
			endTime,
			limit: LIMIT
		});
		if (!Array.isArray(rows) || rows.length === 0) break;
		let oldest = Infinity;
		for (const r of rows) {
			const ts = Number(r[0]);
			const close = String(r[4] ?? '');
			if (!Number.isFinite(ts) || !/^\d+(\.\d+)?(e-?\d+)?$/i.test(close) || Number(close) <= 0) continue;
			oldest = Math.min(oldest, ts);
			const day = utcDay(ts);
			// laufender Tag ist noch nicht abgeschlossen
			if (day < today && ts >= fromMs) out.set(day, close);
		}
		if (rows.length < LIMIT || oldest <= fromMs || !Number.isFinite(oldest)) break;
		endTime = oldest - 1;
	}
	return [...out.entries()].map(([day, close]) => ({ day, close })).sort((a, b) => a.day.localeCompare(b.day));
}

/** Holt und speichert die Tageskurse eines Coins ab `fromDay`. Bereits vorhandene Tage bleiben unverändert. */
export async function syncCoinPrices(admin: SupabaseClient, coin: string, fromDay: string): Promise<PriceSyncResult> {
	const symbol = `${coin}USDT`;
	const base: PriceSyncResult = { coin, symbol, received: 0, stored: 0, first: null, last: null };
	let closes: DailyClose[];
	try {
		closes = await fetchDailyCloses(coin, fromDay);
	} catch (e) {
		const err = e as BitgetError;
		if (err.code && UNKNOWN_SYMBOL.has(err.code)) return { ...base, unavailable: true, error: `${err.message} (${err.code})` };
		return { ...base, error: `${err.message}${err.code ? ` (${err.code})` : ''}` };
	}
	if (!closes.length) return { ...base, unavailable: true };

	let stored = 0;
	for (let i = 0; i < closes.length; i += 500) {
		const chunk = closes.slice(i, i + 500).map((c) => ({ coin, price_date: c.day, close: c.close, quote: 'USDT', source: 'bitget' }));
		const { error, count } = await admin
			.from('coin_prices')
			.upsert(chunk, { onConflict: 'coin,price_date,quote,source', ignoreDuplicates: true, count: 'exact' });
		if (error) return { ...base, received: closes.length, error: `Speichern: ${error.message}` };
		stored += count ?? 0;
	}
	return { ...base, received: closes.length, stored, first: closes[0]!.day, last: closes[closes.length - 1]!.day };
}

export interface PriceStatus {
	coin: string;
	first_day: string;
	last_day: string;
	n: number;
}

export async function priceStatus(db: SupabaseClient): Promise<PriceStatus[]> {
	const { data, error } = await db
		.from('v_coin_prices')
		.select('coin, first_day, last_day, n')
		.eq('quote', 'USDT')
		.eq('source', 'bitget');
	if (error) throw new Error(`v_coin_prices: ${error.message}`);
	return (data ?? []) as PriceStatus[];
}

export const dayBefore = (day: string, n = 1) => utcDay(Date.parse(`${day}T00:00:00Z`) - n * DAY);
