import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeTax } from './engine';
import { FxTable } from './fx';
import { neededPriceCoins, PriceTable } from './prices';
import type { LedgerEntry } from './types';

let seq = 0;
const entry = (p: Partial<LedgerEntry> & { day: string }): LedgerEntry => ({
	tx_id: `p${++seq}`,
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

// 1 EUR = 1,25 USD
const fx = new FxTable([{ rate_date: '2023-01-01', rate: '1.25' }]);
const prices = new PriceTable([
	{ coin: 'ETH', prices: { '2026-03-01': '2000', '2026-03-02': '2500', '2026-06-01': '3000' } },
	{ coin: 'BGB', prices: { '2026-03-01': '5' } },
	{ coin: 'SOL', prices: { '2026-03-01': '100' } }
]);

describe('PriceTable', () => {
	it('nimmt den Schlusskurs des Tages, sonst den letzten davor (max. 3 Tage)', () => {
		expect(prices.closeFor('ETH', '2026-03-02')!.close.toString()).toBe('2500');
		expect(prices.closeFor('ETH', '2026-03-05')!.day).toBe('2026-03-02');
		expect(prices.closeFor('ETH', '2026-03-06')).toBeNull();
		expect(prices.closeFor('ETH', '2026-02-28')).toBeNull();
		expect(prices.closeFor('XYZ', '2026-03-02')).toBeNull();
		expect(prices.valueUsdt('USDT', new Decimal(7), '2020-01-01')!.toString()).toBe('7');
	});

	it('ermittelt benötigte Coins mit erstem Tag, ohne EUR und Stablecoins', () => {
		const m = neededPriceCoins([
			entry({ day: '2026-02-01', buy_amount: '1', buy_cur: 'SOL2', sell_amount: '100', sell_cur: 'USDT' }),
			entry({ day: '2026-01-01', buy_amount: '1', buy_cur: 'SOL2', sell_amount: '100', sell_cur: 'EUR' })
		]);
		expect([...m]).toEqual([['SOL', '2026-01-01']]);
	});
});

describe('computeTax mit Tageskursen', () => {
	it('bewertet Earn-Erträge in Coins am Zuflusstag und nutzt den Wert als Anschaffungskosten', () => {
		const ledger = [
			entry({ day: '2026-03-01', type: 'Staking', buy_amount: '0.01', buy_cur: 'ETH' }), // 20 USD = 16 EUR
			entry({ day: '2026-03-02', type: 'Staking', buy_amount: '0.01', buy_cur: 'ETH' }), // 25 USD = 20 EUR
			entry({ day: '2026-03-01', type: 'Airdrop', buy_amount: '10', buy_cur: 'ZZZ' }), // kein Kurs
			// Verkauf 0,02 ETH für 60 USDT (= 48 EUR) innerhalb der Haltefrist
			entry({ day: '2026-06-01', type: 'Trade', buy_amount: '60', buy_cur: 'USDT', sell_amount: '0.02', sell_cur: 'ETH' })
		];
		const r = computeTax(ledger, fx, 2026, prices);
		const eth = r.earn.find((x) => x.asset === 'ETH')!;
		expect(eth.eurKnown.toString()).toBe('36');
		expect(eth.eurPriced.toString()).toBe('36');
		expect(eth.qtyUnvalued.isZero()).toBe(true);
		expect(r.earn.find((x) => x.asset === 'ZZZ')!.qtyUnvalued.toString()).toBe('10');
		expect(r.warnings.filter((w) => w.kind === 'earn_unvalued').map((w) => w.asset)).toEqual(['ZZZ']);
		expect(r.totals.earnEurKnown.toString()).toBe('36');
		// Veräußerung: 48 − 36 = 12 EUR steuerpflichtig, Kosten bekannt
		expect(r.disposals[0]!.status).toBe('ok');
		expect(r.totals.soTaxableGain.toString()).toBe('12');
	});

	it('ohne Kurstabelle bleibt alles wie bisher (Coins unbewertet)', () => {
		const r = computeTax([entry({ day: '2026-03-01', type: 'Staking', buy_amount: '0.01', buy_cur: 'ETH' })], fx, 2026);
		expect(r.earn[0]!.eurKnown.isZero()).toBe(true);
		expect(r.earn[0]!.qtyUnvalued.toString()).toBe('0.01');
	});

	it('schätzt Tausch Coin gegen Coin über den Tageskurs der abgegebenen Seite', () => {
		const ledger = [
			entry({ day: '2026-02-01', type: 'Trade', buy_amount: '1', buy_cur: 'SOL', sell_amount: '100', sell_cur: 'USDT' }), // 80 EUR
			entry({ day: '2026-03-01', type: 'Trade', buy_amount: '20', buy_cur: 'BGB', sell_amount: '1', sell_cur: 'SOL' }) // 100 USD = 80 EUR
		];
		const r = computeTax(ledger, fx, 2026, prices);
		const d = r.disposals.find((x) => x.asset === 'SOL')!;
		expect(d.proceeds!.toString()).toBe('80');
		expect(r.warnings.some((w) => w.kind === 'trade_priced')).toBe(true);
		expect(r.warnings.some((w) => w.kind === 'trade_unvalued')).toBe(false);
		const bgb = r.holdingsEnd.find((h) => h.asset === 'BGB')!;
		expect(bgb.costKnown.toString()).toBe('80');
	});

	it('bewertet Umtausch von Kleinstbeträgen in BGB (sonstiger Zugang) geschätzt über den Kurs', () => {
		const r = computeTax(
			[entry({ day: '2026-03-01', type: 'Other Income (non taxable)', comment: 'Exchange income', buy_amount: '2', buy_cur: 'BGB' })],
			fx,
			2026,
			prices
		);
		expect(r.holdingsEnd[0]!.costKnown.toString()).toBe('8'); // 2 × 5 USD ÷ 1,25
		expect(r.holdingsEnd[0]!.qtyCostUnknown.isZero()).toBe(true);
	});

	it('setzt bei Einzahlungen von außen Einzahlungstag und Tageswert als geschätzten Einstand', () => {
		const ledger = [
			entry({ day: '2026-03-01', type: 'Deposit', comment: 'Deposit', buy_amount: '1', buy_cur: 'ETH' }), // 2000 USD = 1600 EUR
			// Verkauf nach drei Monaten → innerhalb der Haltefrist ab Einzahlungstag
			entry({ day: '2026-06-01', type: 'Trade', buy_amount: '2500', buy_cur: 'USDT', sell_amount: '1', sell_cur: 'ETH' }) // 2000 EUR
		];
		const r = computeTax(ledger, fx, 2026, prices);
		expect(r.disposals[0]!.status).toBe('geschaetzt');
		expect(r.totals.soTaxableGain.toString()).toBe('400');
		expect(r.warnings.find((w) => w.kind === 'external_in')!.note).toContain('Einzahlungstag');
	});

	it('ohne Tageskurs bleibt die Einzahlung ohne Kosten', () => {
		const r = computeTax([entry({ day: '2026-03-01', type: 'Deposit', comment: 'Deposit', buy_amount: '1', buy_cur: 'ZZZ' })], fx, 2026, prices);
		expect(r.holdingsEnd[0]!.unknownBySource!.external_in!.toString()).toBe('1');
	});
});

describe('Anfangsbestand', () => {
	it('nutzt angegebene Kosten, sonst den Tageswert (geschätzt)', () => {
		const ledger = [
			entry({ day: '2026-03-01', type: 'Opening Balance', buy_amount: '10', buy_cur: 'BGB', cost_eur: null }), // 10 × 5 USD ÷ 1,25 = 40
			entry({ day: '2026-03-01', type: 'Opening Balance', buy_amount: '1', buy_cur: 'SOL', cost_eur: '70' })
		];
		const r = computeTax(ledger, fx, 'all', prices);
		const bgb = r.holdingsEnd.find((x) => x.asset === 'BGB')!;
		expect(bgb.costKnown.toString()).toBe('40');
		expect(bgb.qtyEstimated!.toString()).toBe('10');
		const sol = r.holdingsEnd.find((x) => x.asset === 'SOL')!;
		expect(sol.costKnown.toString()).toBe('70');
		expect(sol.qtyEstimated!.isZero()).toBe(true);
		expect(r.warnings).toEqual([]);
	});
});
