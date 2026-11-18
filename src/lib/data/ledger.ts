import type { SupabaseClient } from '@supabase/supabase-js';
import { mapApiLedger, type ApiLedgerRow } from '#lib/tax/bitget-api.ts';
import type { FxRow } from '#lib/tax/fx.ts';
import type { PriceSeriesRow } from '#lib/tax/prices.ts';
import { OPENING_TYPE, type LedgerEntry } from '#lib/tax/types.ts';
import { mapKucoinLedger, type KucoinRecordRow } from '#lib/tax/kucoin-api.ts';
import { linkTransfers } from '#lib/tax/links.ts';

export interface LedgerData {
	ledger: LedgerEntry[];
	fx: FxRow[];
	/** Tageskurse je Coin (leer, solange noch keine geladen sind) */
	prices: PriceSeriesRow[];
	pricesError: string | null;
	/** Nachgetragene Anfangsbestände (manual_adjustments, kind opening_balance) */
	openings: OpeningBalance[];
	sources: { cointracking: number; api: number; apiLast: string | null; kucoin?: number };
	loadedAt: number;
}

export interface OpeningBalance {
	id: string;
	ts: string;
	asset: string;
	amount: string;
	cost_eur: string | null;
	note: string;
	created_at: string;
}

/** Kalendertag in Europe/Berlin */
export const berlinDay = (ts: string) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

/** Anfangsbestand als Ledger-Buchung (Bitget-Spot, ein FIFO-Topf über alle Konten) */
export const openingEntry = (o: OpeningBalance): LedgerEntry => ({
	tx_id: `manual:${o.id}`,
	ts: o.ts,
	day: berlinDay(o.ts),
	type: OPENING_TYPE,
	buy_amount: o.amount,
	buy_cur: o.asset,
	sell_amount: null,
	sell_cur: null,
	fee_amount: null,
	fee_cur: null,
	exchange: 'Bitget Spot',
	trade_group: null,
	comment: o.note,
	n: 1,
	cost_eur: o.cost_eur
});

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
		const openingsP = db
			.from('manual_adjustments')
			.select('id, ts, asset, amount::text, cost_eur::text, note, created_at')
			.eq('kind', 'opening_balance')
			.order('ts')
			.then(({ data, error }) => {
				if (error) throw new Error(`Anfangsbestände: ${error.message}`);
				return (data ?? []) as unknown as OpeningBalance[];
			});
		const [ct, api, fx, kcCt, kcApi] = await Promise.all([
			pages<LedgerEntry>((a, b) => db.from('v_ledger').select('*').order('ts').order('tx_id').range(a, b), 'CoinTracking-Daten'),
			pages<ApiLedgerRow>((a, b) => db.from('v_api_ledger').select('*').order('ts').order('tx_id').range(a, b), 'Bitget-API-Daten'),
			pages<FxRow>(
				(a, b) => db.from('fx_rates').select('rate_date, rate').eq('pair', 'EURUSD').eq('source', 'ECB').order('rate_date').range(a, b),
				'EZB-Kurse'
			),
			// KuCoin: CoinTracking (bis 08/2025) und eigene API (ab 11/2025)
			pages<LedgerEntry>(
				(a, b) =>
					db
						.from('ct_rows')
						.select('tx_id, ts, type, buy_amount::text, buy_cur, sell_amount::text, sell_cur, fee_amount::text, fee_cur, exchange, trade_group, comment')
						.eq('venue', 'kucoin')
						.order('ts')
						.order('tx_id')
						.range(a, b),
				'KuCoin (CoinTracking)'
			),
			pages<KucoinRecordRow>(
				(a, b) =>
					db
						.from('api_records')
						.select('record_id, ts, raw')
						.eq('source', 'kucoin')
						.eq('endpoint', 'kucoin_ledgers')
						.order('ts')
						.order('record_id')
						.range(a, b),
				'KuCoin-API-Daten'
			)
		]);
		const apiEntries = mapApiLedger(api);
		// CoinTracking-Zeilen haben keinen Tag und n; Zeiten wie in v_ledger in Europe/Berlin
		const kcCtEntries: LedgerEntry[] = kcCt.map((r) => ({ ...r, day: berlinDay(r.ts), n: 1 }));
		// API erst nach dem letzten CoinTracking-Eintrag (keine Doppelzählung bei späteren Re-Importen)
		const kcCtEnd = kcCtEntries.reduce((m, e) => (e.ts > m ? e.ts : m), '');
		const kcApiEntries = mapKucoinLedger(kcApi).filter((e) => !kcCtEnd || Date.parse(e.ts) > Date.parse(kcCtEnd));
		const pr = await pricesP;
		const openings = await openingsP;
		cache = {
			// Umbuchungen (KuCoin intern, KuCoin ↔ Bitget) verknüpfen, damit Bestände mit Kaufdatum mitwandern
			ledger: linkTransfers([...openings.map(openingEntry), ...ct, ...apiEntries, ...kcCtEntries, ...kcApiEntries]),
			openings,
			fx,
			prices: pr.rows,
			pricesError: pr.error,
			sources: {
				cointracking: ct.length + kcCtEntries.length,
				api: apiEntries.length + kcApiEntries.length,
				apiLast: api.length ? api[api.length - 1]!.ts : null,
				kucoin: kcCtEntries.length + kcApiEntries.length
			},
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
