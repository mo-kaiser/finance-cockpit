import { existsSync, readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { parseCoinTrackingCsv, type CtRow } from '../import/cointracking';
import { classify } from './classify';
import { computeTax, holdingEnd } from './engine';
import { FxTable, parseEcbCsv } from './fx';
import type { LedgerEntry } from './types';

let seq = 0;
const entry = (p: Partial<LedgerEntry> & { day: string }): LedgerEntry => ({
	tx_id: `t${++seq}`,
	ts: `${p.day} 12:00:${String(seq % 60).padStart(2, '0')}`,
	type: 'Trade',
	buy_amount: null,
	buy_cur: null,
	sell_amount: null,
	sell_cur: null,
	fee_amount: null,
	fee_cur: null,
	exchange: 'Bitget Spot',
	trade_group: null,
	comment: null,
	n: 1,
	...p
});

// 1 EUR = 1,25 USD → 100 USDT = 80 EUR
const fx = new FxTable([{ rate_date: '2023-01-01', rate: '1.25' }]);

describe('Haltefrist', () => {
	it('endet am gleichen Kalendertag des Folgejahres', () => {
		expect(holdingEnd('2025-04-22')).toBe('2026-04-22');
		expect(holdingEnd('2024-02-29')).toBe('2025-02-28');
	});
});

describe('computeTax', () => {
	it('FIFO mit Haltefrist und Gebühr in der gekauften Währung', () => {
		const ledger = [
			entry({ day: '2024-03-01', type: 'Deposit', comment: 'Deposit', buy_amount: '1000', buy_cur: 'USDT' }),
			// Kauf 0,0012 BTC brutto für 100 USDT, Gebühr 0,0000012 BTC
			entry({ day: '2024-12-10', buy_amount: '0.0012', buy_cur: 'BTC', sell_amount: '100', sell_cur: 'USDT', fee_amount: '0.0000012', fee_cur: 'BTC' }),
			entry({ day: '2026-01-05', buy_amount: '0.001', buy_cur: 'BTC', sell_amount: '125', sell_cur: 'USDT' }),
			// Verkauf aller BTC für 250 USDT, Gebühr 0,25 USDT
			entry({ day: '2026-01-08', buy_amount: '250', buy_cur: 'USDT', sell_amount: '0.0021988', sell_cur: 'BTC', fee_amount: '0.25', fee_cur: 'USDT' })
		];
		const r = computeTax(ledger, fx, 2026);
		const sale = r.disposals.find((d) => d.asset === 'BTC')!;
		expect(sale.status).toBe('ok');
		// Netto-Erlös 249,75 USDT = 199,80 EUR
		expect(sale.proceeds!.toFixed(2)).toBe('199.80');
		const [old, young] = sale.portions;
		expect(old!.acquiredDay).toBe('2024-12-10');
		expect(old!.taxable).toBe(false); // > 1 Jahr gehalten
		expect(young!.taxable).toBe(true);
		expect(young!.cost!.toFixed(2)).toBe('100.00'); // 125 USDT
		// Anteil 0,001/0,0021988 von 199,80 minus 100 Kosten
		expect(sale.gainTaxable.toFixed(2)).toBe(new Decimal('199.80').mul('0.001').div('0.0021988').sub(100).toFixed(2));
	});

	it('Veräußerung von USDT wird bewertet und Einzahlungen als geschätzt markiert', () => {
		const ledger = [
			entry({ day: '2026-02-01', type: 'Deposit', comment: 'Deposit', buy_amount: '100', buy_cur: 'USDT' }),
			entry({ day: '2026-02-02', buy_amount: '1', buy_cur: 'SOL2', sell_amount: '100', sell_cur: 'USDT' })
		];
		const r = computeTax(ledger, fx, 2026);
		const d = r.disposals.find((x) => x.asset === 'USDT')!;
		expect(d.status).toBe('geschaetzt');
		expect(d.gainTaxable.toFixed(2)).toBe('0.00');
		expect(r.warnings.some((w) => w.kind === 'external_in')).toBe(true);
	});

	it('Fehlbestand wird gemeldet statt still gerechnet', () => {
		const r = computeTax(
			[entry({ day: '2026-03-01', buy_amount: '50', buy_cur: 'USDT', sell_amount: '10', sell_cur: 'KAS' })],
			fx,
			2026
		);
		expect(r.disposals[0]!.status).toBe('fehlbestand');
		expect(r.totals.soOpenIssues).toBe(1);
	});

	it('Futures-Ergebnisse landen in KAP, getrennt nach Gewinn, Verlust, Gebühr, Funding', () => {
		const f = { exchange: 'Bitget Futures' };
		const ledger = [
			entry({ ...f, day: '2026-01-02', type: 'Derivatives / Futures Profit', comment: 'Close Long', buy_amount: '125', buy_cur: 'USDT' }),
			entry({ ...f, day: '2026-01-03', type: 'Derivatives / Futures Loss', comment: 'Close Short', sell_amount: '25', sell_cur: 'USDT' }),
			entry({ ...f, day: '2026-01-03', type: 'Margin Fee', comment: 'Open Long', sell_amount: '1.25', sell_cur: 'USDT' }),
			entry({ ...f, day: '2026-01-04', type: 'Other Income', trade_group: 'Funding rate', comment: 'Contract Margin Settle Fee', buy_amount: '2.5', buy_cur: 'USDT' })
		];
		const t = computeTax(ledger, fx, 2026).totals;
		expect(t.kapGains.toFixed(2)).toBe('100.00');
		expect(t.kapLosses.toFixed(2)).toBe('-20.00');
		expect(t.kapFees.toFixed(2)).toBe('-1.00');
		expect(t.kapFunding.toFixed(2)).toBe('2.00');
		expect(t.kapNet.toFixed(2)).toBe('81.00');
	});

	it('Token-Migration übernimmt Anschaffungsdatum und Kosten', () => {
		const ledger = [
			entry({ day: '2024-01-01', buy_amount: '10', buy_cur: 'MATIC', sell_amount: '100', sell_cur: 'USDT' }),
			entry({ day: '2025-06-01', type: 'Swap (non taxable)', buy_amount: '10', buy_cur: 'POL3', sell_amount: '10', sell_cur: 'MATIC' }),
			entry({ day: '2026-01-10', buy_amount: '50', buy_cur: 'USDT', sell_amount: '10', sell_cur: 'POL3' })
		];
		const d = computeTax(ledger, fx, 2026).disposals.find((x) => x.asset === 'POL')!;
		expect(d.portions[0]!.acquiredDay).toBe('2024-01-01');
		expect(d.portions[0]!.taxable).toBe(false);
	});
});

describe('parseEcbCsv', () => {
	it('liest Datum und Kurs über die Spaltennamen', () => {
		const csv = [
			'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS',
			'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-06,1.0712,A',
			'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-09,1.0731,A'
		].join('\n');
		const rows = parseEcbCsv(csv);
		expect(rows).toEqual([
			{ rate_date: '2026-11-06', rate: '1.0712' },
			{ rate_date: '2026-11-09', rate: '1.0731' }
		]);
		// Samstag nutzt den Freitagskurs
		expect(new FxTable(rows).rateFor('2026-11-07')!.rateDay).toBe('2026-11-06');
	});
});

/** Baut aus CSV-Zeilen dieselbe Struktur wie die View v_ledger (Zinsen pro Tag/Coin zusammengefasst). */
export function ledgerFromCt(rows: CtRow[]): LedgerEntry[] {
	const out: LedgerEntry[] = [];
	const agg = new Map<string, LedgerEntry>();
	for (const r of rows) {
		if (!r.exchange.startsWith('Bitget')) continue;
		const day = r.date_raw.slice(0, 10);
		if (r.exchange === 'Bitget Spot' && (r.type === 'Staking' || r.type === 'Reward / Bonus')) {
			const key = `${r.type}|${r.buy_cur}|${day}`;
			const a = agg.get(key);
			if (!a) {
				agg.set(key, {
					tx_id: `agg:${key}`, ts: r.date_raw, day, type: r.type, buy_amount: r.buy_amount, buy_cur: r.buy_cur,
					sell_amount: null, sell_cur: null, fee_amount: null, fee_cur: null, exchange: r.exchange,
					trade_group: null, comment: r.comment, n: 1
				});
			} else {
				a.buy_amount = new Decimal(a.buy_amount ?? 0).add(r.buy_amount ?? 0).toString();
				if (r.date_raw > a.ts) a.ts = r.date_raw;
				a.n++;
			}
			continue;
		}
		out.push({ ...r, ts: r.date_raw, day, n: 1 });
	}
	return [...out, ...agg.values()];
}

const path = process.env.CT_CSV;
describe.runIf(path && existsSync(path))('echter Export', () => {
	const { rows } = parseCoinTrackingCsv(readFileSync(path!, 'utf8'));
	const ledger = ledgerFromCt(rows);

	it('jede Bitget-Buchung hat eine bekannte Kategorie', () => {
		const unknown = ledger.filter((e) => classify(e) === 'unknown');
		expect(unknown.map((e) => `${e.exchange}/${e.type}/${e.comment}`)).toEqual([]);
	});

	it('rechnet 2026 durch (fester Kurs 1,25 für den Abgleich)', () => {
		const t0 = performance.now();
		const r = computeTax(ledger, fx, 2026);
		const ms = Math.round(performance.now() - t0);
		const f = (d: Decimal) => d.toFixed(2);
		const t = r.totals;
		console.log(JSON.stringify({
			ms,
			ledger: ledger.length,
			kap: { n: r.kap.length, gains: f(t.kapGains), losses: f(t.kapLosses), fees: f(t.kapFees), funding: f(t.kapFunding), other: f(t.kapOther), net: f(t.kapNet) },
			so: {
				n: r.disposals.length,
				taxable: f(t.soTaxableGain),
				free: f(t.soFreeGain),
				status: r.disposals.reduce<Record<string, number>>((m, d) => ((m[d.status] = (m[d.status] ?? 0) + 1), m), {}),
				byAsset: r.disposals.reduce<Record<string, string>>((m, d) => ((m[d.asset] = new Decimal(m[d.asset] ?? 0).add(d.gainTaxable).toFixed(4)), m), {})
			},
			btcSale: r.disposals.filter((d) => d.asset === 'BTC').map((d) => ({ day: d.day, qty: d.qty.toString(), proceeds: d.proceeds && f(d.proceeds), status: d.status, portions: d.portions.map((p) => [p.acquiredDay, p.qty.toString(), p.cost && f(p.cost), p.taxable]) })),
			earnTop: r.earn.slice(0, 5).map((e) => [e.asset, e.qty.toFixed(6), f(e.eurKnown), e.bookings]),
			warnings: r.warnings.reduce<Record<string, number>>((m, w) => ((m[w.kind] = (m[w.kind] ?? 0) + 1), m), {}),
			start: r.holdingsStart.slice(0, 8).map((h) => [h.asset, h.qty.toFixed(6), f(h.costKnown), h.qtyCostUnknown.toFixed(6)])
		}, null, 1));
		expect(r.kap.length).toBeGreaterThan(0);
		expect(ms).toBeLessThan(5000);
	});
});
