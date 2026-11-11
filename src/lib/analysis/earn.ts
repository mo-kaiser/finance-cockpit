import Decimal from 'decimal.js';
import { asset, USD_STABLE } from '$lib/tax/assets';
import { classify } from '$lib/tax/classify';
import type { LedgerEntry } from '$lib/tax/types';

export type EarnKind = 'zinsen' | 'airdrop' | 'bonus';

export const EARN_KIND_LABEL: Record<EarnKind, string> = {
	zinsen: 'Zinsen / Staking',
	airdrop: 'Airdrops',
	bonus: 'Boni / Gutscheine'
};

/** Ein Earn-Zufluss (bei Zinsen meist pro Tag und Coin zusammengefasst). */
export interface EarnEvent {
	day: string;
	coin: string;
	qty: Decimal;
	kind: EarnKind;
	n: number;
}

function kindOf(e: LedgerEntry): EarnKind {
	const c = (e.comment ?? '').toLowerCase();
	if (e.type === 'Airdrop' || c.includes('airdrop')) return 'airdrop';
	if (e.type === 'Staking' || c.includes('interest')) return 'zinsen';
	return 'bonus';
}

export function earnEvents(ledger: LedgerEntry[]): EarnEvent[] {
	const out: EarnEvent[] = [];
	for (const e of ledger) {
		if (classify(e) !== 'earn_income' || !e.buy_cur || !e.buy_amount) continue;
		const coin = asset(e.buy_cur);
		let qty = new Decimal(e.buy_amount);
		if (e.fee_amount && e.fee_cur && asset(e.fee_cur) === coin) qty = qty.sub(e.fee_amount);
		if (qty.lte(0)) continue;
		out.push({ day: e.day, coin, qty, kind: kindOf(e), n: e.n });
	}
	return out.sort((a, b) => a.day.localeCompare(b.day));
}

export interface CoinIncome {
	coin: string;
	qty: Decimal;
	bookings: number;
	days: number;
	valueUsdt: Decimal | null; // zum heutigen Kurs
	byKind: Record<EarnKind, Decimal>;
	first: string;
	last: string;
}

export interface EarnSummary {
	byCoin: CoinIncome[];
	byMonth: { month: string; valueUsdt: Decimal; unpriced: number }[];
	byKind: Record<EarnKind, Decimal>; // Wert zum heutigen Kurs
	totalUsdt: Decimal;
	unpricedCoins: string[];
	bookings: number;
}

const ZERO = new Decimal(0);
const zeroKinds = (): Record<EarnKind, Decimal> => ({ zinsen: ZERO, airdrop: ZERO, bonus: ZERO });

/** Erträge in einem Zeitraum, bewertet mit heutigen Kursen (USDT je Coin). */
export function summarizeEarn(events: EarnEvent[], from: string, to: string, prices: Record<string, Decimal>): EarnSummary {
	const coins = new Map<string, CoinIncome & { daySet: Set<string> }>();
	const months = new Map<string, { valueUsdt: Decimal; unpriced: number }>();
	const byKind = zeroKinds();
	let bookings = 0;

	const priceOf = (coin: string) => (USD_STABLE.has(coin) ? new Decimal(1) : (prices[coin] ?? null));

	for (const e of events) {
		if (e.day < from || e.day > to) continue;
		bookings += e.n;
		const p = priceOf(e.coin);
		const v = p ? e.qty.mul(p) : null;

		const c = coins.get(e.coin) ?? { coin: e.coin, qty: ZERO, bookings: 0, days: 0, valueUsdt: p ? ZERO : null, byKind: zeroKinds(), first: e.day, last: e.day, daySet: new Set<string>() };
		c.qty = c.qty.add(e.qty);
		c.bookings += e.n;
		c.daySet.add(e.day);
		c.byKind[e.kind] = c.byKind[e.kind].add(e.qty);
		if (v && c.valueUsdt) c.valueUsdt = c.valueUsdt.add(v);
		if (e.day > c.last) c.last = e.day;
		coins.set(e.coin, c);

		const m = months.get(e.day.slice(0, 7)) ?? { valueUsdt: ZERO, unpriced: 0 };
		if (v) m.valueUsdt = m.valueUsdt.add(v);
		else m.unpriced += e.n;
		months.set(e.day.slice(0, 7), m);

		if (v) byKind[e.kind] = byKind[e.kind].add(v);
	}

	const byCoin = [...coins.values()]
		.map(({ daySet, ...c }) => ({ ...c, days: daySet.size }))
		.sort((a, b) => (b.valueUsdt ?? ZERO).cmp(a.valueUsdt ?? ZERO) || b.bookings - a.bookings);

	return {
		byCoin,
		byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, ...m })),
		byKind,
		totalUsdt: byCoin.reduce((s, c) => s.add(c.valueUsdt ?? 0), ZERO),
		unpricedCoins: byCoin.filter((c) => c.valueUsdt === null).map((c) => c.coin),
		bookings
	};
}

/**
 * Tatsächliche Rendite p. a. aus den Erträgen eines Zeitfensters im Verhältnis zum aktuellen Bestand
 * (Näherung: Bestand als konstant angenommen, Zinseszins ignoriert).
 */
export function realizedApr(incomeQty: Decimal, holdingQty: Decimal, windowDays: number): number | null {
	if (holdingQty.lte(0) || windowDays <= 0) return null;
	return incomeQty.div(holdingQty).mul(365).div(windowDays).toNumber();
}
