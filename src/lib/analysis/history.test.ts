import { describe, expect, it } from 'vitest';
import { FxTable } from '$lib/tax/fx';
import { PriceTable } from '$lib/tax/prices';
import type { LedgerEntry } from '$lib/tax/types';
import { valueHistory } from './history';

let n = 0;
const e = (p: Partial<LedgerEntry> & { day: string }): LedgerEntry => ({
	tx_id: `h${++n}`,
	ts: `${p.day}T10:00:${String(n).padStart(2, '0')}+00:00`,
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
const fx = new FxTable([{ rate_date: '2026-01-01', rate: '1.25' }]); // 1 EUR = 1,25 USD
const prices = new PriceTable([{ coin: 'ETH', prices: { '2026-01-02': '2000', '2026-01-03': '2500', '2026-01-04': '3000' } }]);

describe('valueHistory', () => {
	it('bewertet den Bestand je Tag und führt die Netto-Einzahlungen mit', () => {
		const ledger = [
			e({ day: '2026-01-02', type: 'Deposit', comment: 'Deposit', buy_amount: '1000', buy_cur: 'USDT' }),
			e({ day: '2026-01-02', buy_amount: '0.5', buy_cur: 'ETH', sell_amount: '1000', sell_cur: 'USDT' })
		];
		const h = valueHistory(ledger, fx, prices, '2026-01-04');
		expect(h.points.map((p) => [p.day, p.valueEur, p.investedEur])).toEqual([
			['2026-01-02', 800, 800], // 0,5 × 2000 = 1000 USD = 800 EUR
			['2026-01-03', 1000, 800],
			['2026-01-04', 1200, 800]
		]);
		expect(h.unpriced).toEqual([]);
	});

	it('zählt Euro-Käufe als Einzahlung und meldet Coins ohne Kurs', () => {
		const h = valueHistory(
			[
				e({ day: '2026-01-02', buy_amount: '540', buy_cur: 'USDT', sell_amount: '500', sell_cur: 'EUR' }),
				e({ day: '2026-01-03', type: 'Airdrop', buy_amount: '5', buy_cur: 'ZZZ' })
			],
			fx,
			prices,
			'2026-01-03'
		);
		expect(h.points[0]).toMatchObject({ valueEur: 432, investedEur: 500 });
		expect(h.unpriced).toEqual(['ZZZ']);
	});
});
