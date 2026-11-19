import Decimal from 'decimal.js';
import type { EarnItem, LiveData } from './portfolio';
import type { Venue } from '#lib/tax/types.ts';

/**
 * Aktuelle Earn- und Staking-Positionen je Börse aus den Live-Daten:
 *   Bitget: Savings flexibel/fest (mit Haltedauer, Laufzeit, bisherigem Ertrag), On-Chain (Elite),
 *           Rest des Earn-Kontos als „sonstiges Earn-Produkt“, On-Chain-Staking laut Buchungen
 *   KuCoin: hold-assets (Kategorie, Zinssatz, Sperrfrist)
 */
export interface EarnPosition {
	venue: Venue;
	coin: string;
	qty: Decimal;
	product: string;
	/** Prozent p. a. */
	apy: number | null;
	/** bisheriger Ertrag in Coin (falls die Börse ihn liefert) */
	profit: Decimal | null;
	start: string | null;
	end: string | null;
	valueUsdt: Decimal | null;
	note?: string;
}

const D = (v: unknown) => {
	try {
		return new Decimal(typeof v === 'string' || typeof v === 'number' ? v || 0 : 0);
	} catch {
		return new Decimal(0);
	}
};
const num = (v: unknown) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const day = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const msOf = (v: unknown) => {
	const n = num(v);
	return n && n > 1e11 ? n : null;
};

const KUCOIN_CATEGORY: Record<string, string> = {
	DEMAND: 'Flexibel',
	SAVING: 'Sparen',
	ACTIVITY: 'Aktion',
	STAKING: 'Staking',
	KCS_STAKING: 'KCS-Staking',
	ETH2: 'ETH-Staking'
};

function fromItem(e: EarnItem, fixed: boolean, now: number): Omit<EarnPosition, 'valueUsdt'> {
	const venue: Venue = e.venue ?? 'bitget';
	const r = e.raw ?? {};
	let start: string | null = null;
	let end: string | null = null;
	let product = fixed ? 'Fest' : 'Flexibel';
	let profit: Decimal | null = null;
	if (venue === 'kucoin') {
		const cat = String(r.productCategory ?? '');
		product = KUCOIN_CATEGORY[cat] ?? (cat || product);
		if (fixed && cat !== 'DEMAND' && !/staking/i.test(product)) product = `${product} (fest)`;
		const s = msOf(r.lockStartTime) ?? msOf(r.purchaseTime);
		const t = msOf(r.lockEndTime);
		start = s ? day(s) : null;
		end = t ? day(t) : null;
		if (String(r.status ?? '') === 'REDEEMING') product += ' · wird ausgezahlt';
	} else {
		const hold = num(r.holdDays);
		const period = num(r.period);
		if (hold !== null) start = day(now - hold * 86_400_000);
		if (fixed && period && hold !== null) end = day(now + Math.max(0, period - hold) * 86_400_000);
		if (fixed && period) product = `Fest ${period} Tage`;
		if (r.totalProfit !== undefined && r.totalProfit !== '') profit = D(r.totalProfit);
	}
	return { venue, coin: e.coin, qty: D(e.qty), product, apy: num(e.apy), profit, start, end };
}

export function earnPositions(live: LiveData | null, onChainLedger: Map<string, Decimal> = new Map(), now = Date.now()): EarnPosition[] {
	if (!live) return [];
	const prices = live.tickers.ok ? live.tickers.data : {};
	const value = (coin: string, q: Decimal) => (prices[coin] ? q.mul(prices[coin]!) : null);
	const out: EarnPosition[] = [];

	for (const [sec, fixed] of [
		[live.earnFlex, false],
		[live.earnFixed, true]
	] as const) {
		if (!sec.ok) continue;
		for (const e of sec.data) {
			const p = fromItem(e, fixed, now);
			if (p.qty.lte(0)) continue;
			out.push({ ...p, valueUsdt: value(p.coin, p.qty) });
		}
	}

	if (live.elite?.ok) {
		for (const e of live.elite.data) {
			const q = D(e.qty);
			if (q.lte(0)) continue;
			out.push({
				venue: 'bitget',
				coin: e.coin,
				qty: q,
				product: 'On-Chain',
				apy: num(e.apr),
				profit: null,
				start: null,
				end: null,
				valueUsdt: e.valueUsdt ? D(e.valueUsdt) : value(e.coin, q),
				note: e.underlying && e.underlying !== e.coin ? `entspricht ${D(e.underlyingQty).toString()} ${e.underlying}` : undefined
			});
		}
	}

	// Earn-Konto: was über die einzelnen Positionen hinausgeht (z. B. andere Earn-Produkte)
	if (live.earnAccount?.ok) {
		for (const a of live.earnAccount.data) {
			const venue: Venue = a.venue ?? 'bitget';
			const listed = out.filter((p) => p.venue === venue && p.coin === a.coin).reduce((s, p) => s.add(p.qty), new Decimal(0));
			const rest = D(a.qty).sub(listed);
			const v = value(a.coin, rest);
			if (rest.lte(0) || (v !== null && v.lt(1)) || rest.lte(D(a.qty).mul('1e-6'))) continue;
			out.push({ venue, coin: a.coin, qty: rest, product: 'Sonstiges Earn-Produkt', apy: null, profit: null, start: null, end: null, valueUsdt: v });
		}
	}

	// Bitget On-Chain-Staking, das nur aus den Buchungen bekannt ist (nicht in Elite enthalten)
	const eliteUnderlying = new Set(live.elite?.ok ? live.elite.data.map((e) => e.underlying || e.coin) : []);
	for (const [coin, q] of onChainLedger) {
		if (q.lte(0) || eliteUnderlying.has(coin)) continue;
		out.push({
			venue: 'bitget',
			coin,
			qty: q,
			product: 'On-Chain-Staking',
			apy: null,
			profit: null,
			start: null,
			end: null,
			valueUsdt: value(coin, q),
			note: 'laut Buchungen (ohne noch nicht ausgezahlte Erträge)'
		});
	}

	return out.sort((a, b) => (b.valueUsdt?.toNumber() ?? 0) - (a.valueUsdt?.toNumber() ?? 0));
}
