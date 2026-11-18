import Decimal from 'decimal.js';
import { asset, FIAT_EUR, USD_STABLE } from '$lib/tax/assets';
import { classify } from '$lib/tax/classify';
import { computeTax } from '$lib/tax/engine';
import type { FxTable } from '$lib/tax/fx';
import type { PriceTable } from '$lib/tax/prices';
import type { LedgerEntry } from '$lib/tax/types';

/**
 * Wertverlauf des Portfolios: Bestand je Coin am Ende jedes Tages (aus der Buchungshistorie, alle Bitget-Konten)
 * × Tagesschlusskurs, umgerechnet mit dem EZB-Kurs. Dazu die Netto-Einzahlungen (was von außen hineinkam).
 * Nicht enthalten: offene Futures-Positionen (unrealisiert), noch nicht ausgezahlte On-Chain-Erträge,
 * Coins ohne Bitget-Kurs.
 */
export interface ValuePoint {
	day: string;
	valueEur: number;
	/** kumulierte Netto-Einzahlungen in EUR (Einzahlungen + Anfangsbestand − Auszahlungen, je zum Tageswert) */
	investedEur: number;
}

export interface ValueHistory {
	points: ValuePoint[];
	/** Coins mit Bestand, aber ohne Kurs am letzten Tag */
	unpriced: string[];
}

const DAY = 86_400_000;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

export function valueHistory(ledger: LedgerEntry[], fx: FxTable, prices: PriceTable, untilDay: string): ValueHistory {
	// 1. Bestand je Coin am Ende jedes Buchungstages
	const snaps = new Map<string, Map<string, Decimal>>();
	computeTax(ledger, fx, 'all', prices, {
		onDayEnd: (day, qty) => {
			const m = new Map<string, Decimal>();
			for (const [c, q] of qty) if (q.gt(0)) m.set(c, q);
			snaps.set(day, m);
		}
	});
	if (!snaps.size) return { points: [], unpriced: [] };

	// 2. Netto-Einzahlungen je Tag (EUR)
	const flows = new Map<string, Decimal>();
	const addFlow = (day: string, eur: Decimal | null) => {
		if (eur) flows.set(day, (flows.get(day) ?? new Decimal(0)).add(eur));
	};
	const eurValue = (cur: string, q: Decimal, day: string): Decimal | null => {
		if (cur === FIAT_EUR) return q;
		const usdt = prices.valueUsdt(cur, q, day);
		return usdt === null ? null : fx.usdToEur(usdt, day);
	};
	for (const e of ledger) {
		const cat = classify(e);
		const buy = e.buy_cur ? asset(e.buy_cur) : null;
		const sell = e.sell_cur ? asset(e.sell_cur) : null;
		if (cat === 'opening_in' && buy) {
			addFlow(e.day, e.cost_eur ? new Decimal(e.cost_eur) : eurValue(buy, new Decimal(e.buy_amount ?? 0), e.day));
		} else if (cat === 'external_in' && buy) {
			addFlow(e.day, eurValue(buy, new Decimal(e.buy_amount ?? 0), e.day));
		} else if (cat === 'external_out' && sell) {
			addFlow(e.day, eurValue(sell, new Decimal(e.sell_amount ?? 0), e.day)?.neg() ?? null);
		} else if (cat === 'spot_trade' && sell === FIAT_EUR) {
			addFlow(e.day, new Decimal(e.sell_amount ?? 0)); // Euro-Einzahlung per Überweisung (als Kauf gebucht)
		} else if (cat === 'spot_trade' && buy === FIAT_EUR) {
			addFlow(e.day, new Decimal(e.buy_amount ?? 0).neg());
		}
	}

	// 3. Jeden Kalendertag bewerten (Bestand des letzten Buchungstages fortschreiben)
	const days = [...snaps.keys()].sort();
	const points: ValuePoint[] = [];
	let held = new Map<string, Decimal>();
	let invested = new Decimal(0);
	let unpriced: string[] = [];
	for (let day = days[0]!; day <= untilDay; day = nextDay(day)) {
		held = snaps.get(day) ?? held;
		invested = invested.add(flows.get(day) ?? 0);
		let usdt = new Decimal(0);
		let eur = new Decimal(0);
		unpriced = [];
		for (const [c, q] of held) {
			if (c === FIAT_EUR) eur = eur.add(q);
			else if (USD_STABLE.has(c)) usdt = usdt.add(q);
			else {
				const p = prices.closeFor(c, day);
				if (p) usdt = usdt.add(q.mul(p.close));
				else unpriced.push(c);
			}
		}
		const fromUsdt = fx.usdToEur(usdt, day);
		if (fromUsdt === null) continue; // vor dem ersten EZB-Kurs
		points.push({ day, valueEur: fromUsdt.add(eur).toNumber(), investedEur: invested.toNumber() });
	}
	return { points, unpriced };
}
