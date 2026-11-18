import Decimal from 'decimal.js';
import { asset, FIAT_EUR, USD_STABLE } from './assets';
import type { LedgerEntry } from './types';

/** Zeile der View v_coin_prices: alle Tageskurse eines Coins als { "YYYY-MM-DD": "close" }. */
export interface PriceSeriesRow {
	coin: string;
	first_day?: string;
	last_day?: string;
	n?: number;
	prices: Record<string, string>;
}

/** Wie viele Tage ein Kurs höchstens zurückliegen darf, um noch verwendet zu werden. */
export const MAX_PRICE_AGE_DAYS = 3;

/**
 * Tagesschlusskurse je Coin in USDT (Bitget, UTC-Tageskerze). Für einen Kalendertag gilt der
 * Schlusskurs desselben Datums; fehlt er, der letzte davor (höchstens MAX_PRICE_AGE_DAYS alt).
 */
export class PriceTable {
	private series = new Map<string, { days: string[]; closes: Decimal[] }>();

	constructor(rows: PriceSeriesRow[] = []) {
		for (const r of rows) {
			const entries = Object.entries(r.prices ?? {}).sort(([a], [b]) => a.localeCompare(b));
			this.series.set(r.coin, { days: entries.map(([d]) => d), closes: entries.map(([, c]) => new Decimal(c)) });
		}
	}

	get coins() {
		return [...this.series.keys()];
	}

	has(coin: string) {
		return this.series.has(coin);
	}

	range(coin: string): { first: string; last: string; n: number } | null {
		const s = this.series.get(coin);
		return s && s.days.length ? { first: s.days[0]!, last: s.days[s.days.length - 1]!, n: s.days.length } : null;
	}

	/** Schlusskurs in USDT für Coin und Tag, oder null. */
	closeFor(coin: string, day: string): { close: Decimal; day: string } | null {
		const s = this.series.get(coin);
		if (!s) return null;
		let lo = 0;
		let hi = s.days.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (s.days[mid]! <= day) {
				found = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		if (found < 0) return null;
		const d = s.days[found]!;
		if ((Date.parse(day) - Date.parse(d)) / 86_400_000 > MAX_PRICE_AGE_DAYS) return null;
		return { close: s.closes[found]!, day: d };
	}

	/** Wert einer Menge in USDT (Stablecoins 1:1), oder null ohne Kurs. */
	valueUsdt(coin: string, qty: Decimal, day: string): Decimal | null {
		if (USD_STABLE.has(coin)) return qty;
		const p = this.closeFor(coin, day);
		return p ? qty.mul(p.close) : null;
	}
}

/**
 * Coins, für die Tageskurse gebraucht werden, mit dem ersten Tag, an dem sie in den Buchungen vorkommen.
 * Euro und US-Dollar-Stablecoins brauchen keinen Kurs.
 */
export function neededPriceCoins(ledger: LedgerEntry[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of ledger) {
		for (const c of [e.buy_cur, e.sell_cur, e.fee_cur]) {
			if (!c) continue;
			const a = asset(c);
			if (a === FIAT_EUR || USD_STABLE.has(a) || !/^[A-Z0-9]{1,20}$/.test(a)) continue;
			const prev = out.get(a);
			if (!prev || e.day < prev) out.set(a, e.day);
		}
	}
	return out;
}
