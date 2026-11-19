import { describe, expect, it } from 'vitest';
import { adjustmentEntry, type OpeningBalance } from '#lib/data/ledger.ts';
import { computeTax } from './engine';
import { FxTable } from './fx';
import { PriceTable } from './prices';
import type { LedgerEntry } from './types';

const adj = (p: Partial<OpeningBalance>): OpeningBalance => ({
	id: Math.random().toString(36).slice(2),
	ts: '2023-01-01T12:00:00Z',
	venue: 'kucoin',
	kind: 'opening_balance',
	asset: 'FTM',
	amount: '398',
	cost_eur: '100',
	note: '',
	created_at: '',
	...p
});
const sale = (ts: string, coin: string, q: string): LedgerEntry => ({
	tx_id: `s${ts}`,
	ts,
	day: ts.slice(0, 10),
	type: 'Trade',
	buy_amount: '50',
	buy_cur: 'USDT',
	sell_amount: q,
	sell_cur: coin,
	fee_amount: null,
	fee_cur: null,
	exchange: 'Kucoin Trading',
	trade_group: null,
	comment: null,
	n: 1
});

describe('Nachträge: Ausbuchung und Token-Umstellung', () => {
	const fx = new FxTable([{ rate_date: '2020-01-01', rate: '1.25' }]);
	const prices = new PriceTable([]);

	it('Token-Umstellung FTM → S übernimmt Kaufdatum und Einstand', () => {
		const ledger = [
			adjustmentEntry(adj({})),
			adjustmentEntry(adj({ kind: 'token_swap', ts: '2025-01-13T12:00:00Z', to_asset: 'S', to_amount: '398', cost_eur: null })),
			sale('2026-03-01T10:00:00+00:00', 'S', '100')
		];
		const r = computeTax(ledger, fx, 'all', prices);
		expect(r.holdingsByVenue.kucoin.find((h) => h.asset === 'FTM')).toBeUndefined();
		expect(r.holdingsByVenue.kucoin.find((h) => h.asset === 'S')!.qty.toString()).toBe('298');
		const d = r.disposals.find((x) => x.asset === 'S')!;
		expect(d.portions[0]!.acquiredDay).toBe('2023-01-01');
		expect(d.portions[0]!.taxable).toBe(false);
		expect(d.portions[0]!.cost!.toFixed(4)).toBe((100 * 100 / 398).toFixed(4));
	});

	it('Ausbuchung entfernt den Bestand ohne Veräußerung und ohne Warnung', () => {
		const ledger = [
			adjustmentEntry(adj({ asset: 'DFI', amount: '510' })),
			adjustmentEntry(adj({ kind: 'write_off', asset: 'DFI', amount: '510', ts: '2025-06-01T12:00:00Z', cost_eur: null }))
		];
		const r = computeTax(ledger, fx, 'all', prices);
		expect(r.holdingsByVenue.kucoin.find((h) => h.asset === 'DFI')).toBeUndefined();
		expect(r.disposals).toEqual([]);
		expect(r.warnings.filter((w) => w.asset === 'DFI')).toEqual([]);
	});
});
