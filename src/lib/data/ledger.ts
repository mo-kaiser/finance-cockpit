import type { SupabaseClient } from '@supabase/supabase-js';
import { mapApiLedger, type ApiLedgerRow } from '$lib/tax/bitget-api';
import type { FxRow } from '$lib/tax/fx';
import type { PriceSeriesRow } from '$lib/tax/prices';
import type { LedgerEntry } from '$lib/tax/types';

export interface LedgerData {
	ledger: LedgerEntry[];
	fx: FxRow[];
	/** Tageskurse je Coin (leer, solange noch keine geladen sind) */
	prices: PriceSeriesRow[];
	pricesError: string | null;
	sources: { cointracking: number; api: number; apiLast: string | null };
	loadedAt: number;
}

const PAGE = 1000;
const TTL = 5 * 60_000;
let cache: LedgerData | null = null;
let inflight: Promise<LedgerData> | null = null;

async function pages<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, label: string): Promise<T[]> {
	const all: T[] = [];
	for (let from = 0; ; from += PAGE) {
		const { data, error } = await fetchPage(from, from + PAGE - 1);
		if (error) throw new Error(`${label}: ${error.message}`);
		all.push(...((data ?? []) as T[]));
		if ((data?.length ?? 0) < PAGE) return all;
	}
}

/**
 * Lädt CoinTracking-Ledger, Bitget-API-Ledger und EZB-Kurse einmal pro Sitzung (5 Minuten Cache im Browser),
 * damit Dashboard, Analyse und Steuer nicht jeweils ~15.000 Zeilen neu holen.
 */
export function loadLedger(db: SupabaseClient, force = false): Promise<LedgerData> {
	if (!force && cache && Date.now() - cache.loadedAt < TTL) return Promise.resolve(cache);
	if (!force && inflight) return inflight;

	inflight = (async () => {
		// Kurse getrennt: ein Fehler (z. B. Tabelle noch nicht angelegt) soll den Rest nicht blockieren
		const pricesP = db
			.from('v_coin_prices')
			.select('coin, first_day, last_day, n, prices')
			.eq('quote', 'USDT')
			.eq('source', 'bitget')
			.then(({ data, error }) => ({ rows: (data ?? []) as PriceSeriesRow[], error: error?.message ?? null }));
		const [ct, api, fx] = await Promise.all([
			pages<LedgerEntry>((a, b) => db.from('v_ledger').select('*').order('ts').order('tx_id').range(a, b), 'CoinTracking-Daten'),
			pages<ApiLedgerRow>((a, b) => db.from('v_api_ledger').select('*').order('ts').order('tx_id').range(a, b), 'Bitget-API-Daten'),
			pages<FxRow>(
				(a, b) => db.from('fx_rates').select('rate_date, rate').eq('pair', 'EURUSD').eq('source', 'ECB').order('rate_date').range(a, b),
				'EZB-Kurse'
			)
		]);
		const apiEntries = mapApiLedger(api);
		const pr = await pricesP;
		cache = {
			ledger: [...ct, ...apiEntries],
			fx,
			prices: pr.rows,
			pricesError: pr.error,
			sources: { cointracking: ct.length, api: apiEntries.length, apiLast: api.length ? api[api.length - 1]!.ts : null },
			loadedAt: Date.now()
		};
		return cache;
	})().finally(() => {
		inflight = null;
	});
	return inflight;
}

export function clearLedgerCache() {
	cache = null;
}
