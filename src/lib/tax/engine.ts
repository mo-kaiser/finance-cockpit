import Decimal from 'decimal.js';
import { asset, FIAT_EUR, USD_STABLE } from './assets';
import { classify, isKap } from './classify';
import type { FxTable } from './fx';
import type { Category, LedgerEntry } from './types';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const ENGINE_VERSION = 'engine-0.1';

const ZERO = new Decimal(0);

interface Lot {
	qty: Decimal;
	/** Anschaffungskosten in EUR für die aktuelle Restmenge, null = unbekannt. */
	cost: Decimal | null;
	day: string;
	txId: string;
	/** Kosten geschätzt (z. B. Stablecoin-Einzahlung zum Tageswert). */
	estimated: boolean;
	source: Category;
}

interface Pool {
	lots: Lot[];
	head: number;
}

export interface Portion {
	acquiredDay: string | null; // null = Fehlbestand (keine Anschaffung in den Daten)
	qty: Decimal;
	cost: Decimal | null;
	proceeds: Decimal | null;
	gain: Decimal | null;
	taxable: boolean | null; // null = unbekannt (Fehlbestand)
	estimated: boolean;
}

export type DisposalStatus = 'ok' | 'geschaetzt' | 'kosten_unbekannt' | 'fehlbestand' | 'unbewertet';

export interface Disposal {
	txId: string;
	day: string;
	asset: string;
	qty: Decimal;
	counter: string;
	proceeds: Decimal | null;
	portions: Portion[];
	status: DisposalStatus;
	/** Summe der bekannten Gewinne/Verluste innerhalb der Haltefrist (steuerpflichtig). */
	gainTaxable: Decimal;
	/** Summe der bekannten Gewinne/Verluste nach Ablauf der Haltefrist (steuerfrei). */
	gainFree: Decimal;
}

export interface KapRow {
	txId: string;
	day: string;
	category: Category;
	comment: string;
	currency: string;
	usd: Decimal;
	eur: Decimal | null;
	n: number;
}

export interface EarnRow {
	asset: string;
	qty: Decimal;
	eurKnown: Decimal;
	qtyUnvalued: Decimal;
	bookings: number;
}

export type WarningKind =
	| 'fx_missing'
	| 'trade_unvalued'
	| 'fee_other_currency'
	| 'external_in'
	| 'external_out'
	| 'other_out'
	| 'consume_shortfall'
	| 'kap_non_usd'
	| 'unknown_category';

export interface Warning {
	kind: WarningKind;
	day: string;
	txId: string;
	asset?: string;
	qty?: Decimal;
	note: string;
}

export interface Holding {
	asset: string;
	qty: Decimal;
	costKnown: Decimal;
	qtyCostUnknown: Decimal;
}

export interface TaxResult {
	year: number;
	engineVersion: string;
	kap: KapRow[];
	disposals: Disposal[];
	earn: EarnRow[];
	warnings: Warning[];
	holdingsStart: Holding[];
	categoryCounts: Partial<Record<Category, number>>;
	totals: {
		kapGains: Decimal; // positive Ergebnisse aus Termingeschäften (Gewinne)
		kapLosses: Decimal; // negative Ergebnisse aus Termingeschäften (als negative Zahl)
		kapFees: Decimal;
		kapFunding: Decimal;
		kapOther: Decimal;
		kapNet: Decimal;
		kapUnvaluedUsd: Decimal;
		soTaxableGain: Decimal; // Saldo innerhalb der Haltefrist (bekannte Werte)
		soFreeGain: Decimal;
		soOpenIssues: number; // Veräußerungen, deren Ergebnis nicht vollständig bekannt ist
		earnEurKnown: Decimal;
	};
}

const dec = (s: string | null | undefined) => (s ? new Decimal(s) : ZERO);

/** Letzter Tag der einjährigen Haltefrist (§ 23 Abs. 1 Nr. 2 EStG, Fristberechnung nach §§ 187, 188 BGB). */
export function holdingEnd(acquiredDay: string): string {
	const y = Number(acquiredDay.slice(0, 4)) + 1;
	const md = acquiredDay.slice(5);
	if (md === '02-29') return `${y}-02-28`;
	return `${y}-${md}`;
}

export function computeTax(ledger: LedgerEntry[], fx: FxTable, year: number): TaxResult {
	const yStart = `${year}-01-01`;
	const yEnd = `${year}-12-31`;
	const inYear = (day: string) => day >= yStart && day <= yEnd;

	const pools = new Map<string, Pool>();
	const pool = (a: string) => {
		let p = pools.get(a);
		if (!p) pools.set(a, (p = { lots: [], head: 0 }));
		return p;
	};

	const kap: KapRow[] = [];
	const disposals: Disposal[] = [];
	const earn = new Map<string, EarnRow>();
	const warnings: Warning[] = [];
	const categoryCounts: Partial<Record<Category, number>> = {};
	let holdingsStart: Holding[] | null = null;

	const warn = (w: Warning) => {
		if (inYear(w.day)) warnings.push(w);
	};

	/** EUR-Wert eines Betrags, sofern die Währung EUR oder ein USD-Stablecoin ist. */
	const valueEur = (cur: string, qty: Decimal, day: string, e: LedgerEntry): Decimal | null => {
		if (cur === FIAT_EUR) return qty;
		if (USD_STABLE.has(cur)) {
			const v = fx.usdToEur(qty, day);
			if (!v) warn({ kind: 'fx_missing', day, txId: e.tx_id, note: `Kein EZB-Kurs für ${day}` });
			return v;
		}
		return null;
	};

	const acquire = (a: string, qty: Decimal, cost: Decimal | null, e: LedgerEntry, cat: Category, estimated = false) => {
		if (a === FIAT_EUR || qty.lte(0)) return;
		pool(a).lots.push({ qty, cost, day: e.day, txId: e.tx_id, estimated, source: cat });
	};

	/** Entnimmt Menge nach FIFO. Liefert die entnommenen Teilmengen und einen etwaigen Fehlbestand. */
	const take = (a: string, qty: Decimal) => {
		const p = pool(a);
		const parts: { lot: Lot; qty: Decimal; cost: Decimal | null }[] = [];
		let rest = qty;
		while (rest.gt(0) && p.head < p.lots.length) {
			const lot = p.lots[p.head]!;
			const q = Decimal.min(rest, lot.qty);
			const cost = lot.cost === null ? null : lot.cost.mul(q).div(lot.qty);
			parts.push({ lot, qty: q, cost });
			lot.qty = lot.qty.sub(q);
			if (lot.cost !== null && cost !== null) lot.cost = lot.cost.sub(cost);
			rest = rest.sub(q);
			if (lot.qty.lte(0)) p.head++;
		}
		return { parts, shortfall: rest };
	};

	/** Nicht steuerbarer Abgang (Gebühr in Fremdwährung, Futures-Verlust, Auszahlung …). */
	const consume = (a: string, qty: Decimal, e: LedgerEntry) => {
		if (a === FIAT_EUR || qty.lte(0)) return;
		const { shortfall } = take(a, qty);
		if (shortfall.gt(0)) {
			warn({
				kind: 'consume_shortfall',
				day: e.day,
				txId: e.tx_id,
				asset: a,
				qty: shortfall,
				note: 'Abgang ohne ausreichenden Bestand in den Daten'
			});
		}
	};

	/** Steuerbare Veräußerung nach § 23 EStG. */
	const dispose = (a: string, qty: Decimal, proceeds: Decimal | null, counter: string, e: LedgerEntry) => {
		if (a === FIAT_EUR || qty.lte(0)) return;
		const { parts, shortfall } = take(a, qty);
		const share = (q: Decimal) => (proceeds === null ? null : proceeds.mul(q).div(qty));
		const portions: Portion[] = parts.map(({ lot, qty: q, cost }) => {
			const pr = share(q);
			return {
				acquiredDay: lot.day,
				qty: q,
				cost,
				proceeds: pr,
				gain: pr !== null && cost !== null ? pr.sub(cost) : null,
				taxable: e.day <= holdingEnd(lot.day),
				estimated: lot.estimated
			};
		});
		if (shortfall.gt(0)) {
			portions.push({
				acquiredDay: null,
				qty: shortfall,
				cost: null,
				proceeds: share(shortfall),
				gain: null,
				taxable: null,
				estimated: false
			});
		}

		let status: DisposalStatus = 'ok';
		if (proceeds === null) status = 'unbewertet';
		else if (shortfall.gt(0)) status = 'fehlbestand';
		else if (portions.some((p) => p.taxable && p.cost === null)) status = 'kosten_unbekannt';
		else if (portions.some((p) => p.taxable && p.estimated)) status = 'geschaetzt';

		let gainTaxable = ZERO;
		let gainFree = ZERO;
		for (const p of portions) {
			if (p.gain === null) continue;
			if (p.taxable) gainTaxable = gainTaxable.add(p.gain);
			else gainFree = gainFree.add(p.gain);
		}

		if (inYear(e.day)) {
			disposals.push({ txId: e.tx_id, day: e.day, asset: a, qty, counter, proceeds, portions, status, gainTaxable, gainFree });
		}
	};

	const snapshotHoldings = (): Holding[] =>
		[...pools.entries()]
			.map(([a, p]) => {
				let qty = ZERO;
				let costKnown = ZERO;
				let qtyCostUnknown = ZERO;
				for (let i = p.head; i < p.lots.length; i++) {
					const l = p.lots[i]!;
					qty = qty.add(l.qty);
					if (l.cost === null) qtyCostUnknown = qtyCostUnknown.add(l.qty);
					else costKnown = costKnown.add(l.cost);
				}
				return { asset: a, qty, costKnown, qtyCostUnknown };
			})
			.filter((h) => h.qty.gt(0))
			.sort((a, b) => b.costKnown.cmp(a.costKnown));

	const sorted = [...ledger].sort((a, b) => (a.ts === b.ts ? a.tx_id.localeCompare(b.tx_id) : a.ts < b.ts ? -1 : 1));

	for (const e of sorted) {
		if (e.day > yEnd) break;
		if (!holdingsStart && e.day >= yStart) holdingsStart = snapshotHoldings();

		const cat = classify(e);
		if (inYear(e.day)) categoryCounts[cat] = (categoryCounts[cat] ?? 0) + e.n;

		const B = dec(e.buy_amount);
		const S = dec(e.sell_amount);
		const F = dec(e.fee_amount);
		const Bc = e.buy_cur ? asset(e.buy_cur) : null;
		const Sc = e.sell_cur ? asset(e.sell_cur) : null;
		const Fc = e.fee_cur && F.gt(0) ? asset(e.fee_cur) : null;

		if (isKap(cat)) {
			const cur = Bc ?? Sc ?? Fc ?? '';
			let usd = B.sub(S);
			if (Fc === cur) usd = usd.sub(F);
			if (!USD_STABLE.has(cur)) {
				warn({ kind: 'kap_non_usd', day: e.day, txId: e.tx_id, asset: cur, note: 'Futures-Buchung nicht in USDT/USDC' });
				continue;
			}
			const eur = valueEur(cur, usd.abs(), e.day, e);
			const signedEur = eur === null ? null : usd.isNeg() ? eur.neg() : eur;
			if (inYear(e.day)) {
				kap.push({ txId: e.tx_id, day: e.day, category: cat, comment: e.comment ?? '', currency: cur, usd, eur: signedEur, n: e.n });
			}
			// Bestandsführung des Stablecoins: Gewinne erhöhen, Verluste/Gebühren verringern den Bestand
			if (usd.gt(0)) acquire(cur, usd, signedEur, e, cat);
			else consume(cur, usd.abs(), e);
			continue;
		}

		switch (cat) {
			case 'transfer':
				break;

			case 'spot_trade': {
				if (!Bc || !Sc) {
					warn({ kind: 'trade_unvalued', day: e.day, txId: e.tx_id, note: 'Trade ohne zwei Seiten' });
					break;
				}
				const netBuy = Fc === Bc ? B.sub(F) : B;
				const dispQty = Fc === Sc ? S.add(F) : S;
				let value: Decimal | null = null;
				if (Sc === FIAT_EUR || Bc === FIAT_EUR) value = Sc === FIAT_EUR ? S : netBuy;
				else if (USD_STABLE.has(Sc)) value = valueEur(Sc, S, e.day, e);
				else if (USD_STABLE.has(Bc)) value = valueEur(Bc, netBuy, e.day, e);
				if (value === null) {
					warn({ kind: 'trade_unvalued', day: e.day, txId: e.tx_id, asset: `${Sc}→${Bc}`, note: 'Tausch ohne Euro- oder Stablecoin-Seite, EUR-Wert fehlt' });
				}
				dispose(Sc, dispQty, value, Bc, e);
				acquire(Bc, netBuy, value, e, cat);
				if (Fc && Fc !== Bc && Fc !== Sc) {
					consume(Fc, F, e);
					warn({ kind: 'fee_other_currency', day: e.day, txId: e.tx_id, asset: Fc, qty: F, note: 'Gebühr in dritter Währung, als Abgang ohne Erlös gebucht' });
				}
				break;
			}

			case 'earn_income':
			case 'other_in':
			case 'external_in': {
				if (!Bc) break;
				const qty = Fc === Bc ? B.sub(F) : B;
				const value = USD_STABLE.has(Bc) || Bc === FIAT_EUR ? valueEur(Bc, qty, e.day, e) : null;
				acquire(Bc, qty, value, e, cat, cat === 'external_in' && value !== null);
				if (cat === 'earn_income' && inYear(e.day)) {
					const r = earn.get(Bc) ?? { asset: Bc, qty: ZERO, eurKnown: ZERO, qtyUnvalued: ZERO, bookings: 0 };
					r.qty = r.qty.add(qty);
					if (value) r.eurKnown = r.eurKnown.add(value);
					else r.qtyUnvalued = r.qtyUnvalued.add(qty);
					r.bookings += e.n;
					earn.set(Bc, r);
				}
				if (cat === 'external_in') {
					warn({ kind: 'external_in', day: e.day, txId: e.tx_id, asset: Bc, qty, note: value ? 'Stablecoin-Einzahlung, Kosten zum Tageswert geschätzt' : 'Einzahlung von außen, Anschaffungsdaten fehlen' });
				}
				break;
			}

			case 'external_out':
			case 'other_out': {
				if (!Sc && !Fc) break;
				const a = Sc ?? Fc!;
				const qty = Sc && Fc === Sc ? S.add(F) : Sc ? S : F;
				consume(a, qty, e);
				warn({ kind: cat, day: e.day, txId: e.tx_id, asset: a, qty, note: cat === 'external_out' ? 'Auszahlung nach außen: als eigene Wallet behandelt (nicht steuerbar)' : 'Sonstiger Abgang ohne Erlös' });
				break;
			}

			case 'swap_nontaxable': {
				if (!Bc || !Sc || S.lte(0)) break;
				const { parts, shortfall } = take(Sc, S);
				const ratio = B.div(S);
				for (const p of parts) {
					pool(Bc).lots.push({ ...p.lot, qty: p.qty.mul(ratio), cost: p.cost });
				}
				if (shortfall.gt(0)) acquire(Bc, shortfall.mul(ratio), null, e, cat);
				break;
			}

			default:
				warn({ kind: 'unknown_category', day: e.day, txId: e.tx_id, note: `${e.exchange} / ${e.type} / ${e.comment ?? ''}` });
		}
	}

	holdingsStart ??= snapshotHoldings();

	const sum = (xs: (Decimal | null)[]) => xs.reduce<Decimal>((s, x) => (x ? s.add(x) : s), ZERO);
	const kapOf = (c: Category) => kap.filter((k) => k.category === c);
	const pnl = kapOf('kap_pnl');

	const totals = {
		kapGains: sum(pnl.filter((k) => k.usd.gt(0)).map((k) => k.eur)),
		kapLosses: sum(pnl.filter((k) => k.usd.lt(0)).map((k) => k.eur)),
		kapFees: sum(kapOf('kap_fee').map((k) => k.eur)),
		kapFunding: sum(kapOf('kap_funding').map((k) => k.eur)),
		kapOther: sum(kapOf('kap_other').map((k) => k.eur)),
		kapNet: sum(kap.map((k) => k.eur)),
		kapUnvaluedUsd: sum(kap.filter((k) => k.eur === null).map((k) => k.usd)),
		soTaxableGain: sum(disposals.map((d) => d.gainTaxable)),
		soFreeGain: sum(disposals.map((d) => d.gainFree)),
		soOpenIssues: disposals.filter((d) => d.status === 'unbewertet' || d.status === 'fehlbestand' || d.status === 'kosten_unbekannt').length,
		earnEurKnown: sum([...earn.values()].map((r) => r.eurKnown))
	};

	return {
		year,
		engineVersion: ENGINE_VERSION,
		kap,
		disposals,
		earn: [...earn.values()].sort((a, b) => b.eurKnown.cmp(a.eurKnown) || b.bookings - a.bookings),
		warnings,
		holdingsStart,
		categoryCounts,
		totals
	};
}
