import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { classify } from './classify';
import { computeTax } from './engine';
import { FxTable } from './fx';
import { mapKucoinLedger, type KucoinLedgerRaw } from './kucoin-api';
import { linkTransfers } from './links';
import { PriceTable } from './prices';
import type { LedgerEntry } from './types';

let n = 0;
const raw = (p: Partial<KucoinLedgerRaw>): { record_id: string; ts: string; raw: KucoinLedgerRaw } => {
	const r: KucoinLedgerRaw = { id: `k${++n}`, currency: 'USDT', amount: '1', fee: '0', accountType: 'MAIN', bizType: 'Transfer', direction: 'in', createdAt: Date.parse('2026-01-18T10:00:00Z'), context: '', ...p };
	return { record_id: r.id, ts: new Date(r.createdAt).toISOString(), raw: r };
};
const e = (p: Partial<LedgerEntry> & { ts: string }): LedgerEntry => ({
	tx_id: `e${++n}`,
	day: p.ts.slice(0, 10),
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

describe('mapKucoinLedger', () => {
	it('bildet Trades, Erträge, Umbuchungen, Kleinstbetrag-Tausch und Auszahlungen ab', () => {
		const ctx = JSON.stringify({ symbol: 'DASH-USDT', orderId: 'o1', tradeId: 't1' });
		const m = mapKucoinLedger([
			raw({ bizType: 'Spot', direction: 'in', currency: 'USDT', amount: '125.7445296', fee: '0.1258704', accountType: 'TRADE', context: ctx }),
			raw({ bizType: 'Spot', direction: 'out', currency: 'DASH', amount: '1.44', fee: '0', accountType: 'TRADE', context: ctx }),
			raw({ bizType: 'KuCoin Earn Profits', currency: 'KCS', amount: '0.0001' }),
			raw({ bizType: 'Hold to Earn Earnings', currency: 'DOT', amount: '0.0006' }),
			raw({ bizType: 'KuCoin Earn Locked', direction: 'out', amount: '510.25' }),
			raw({ bizType: 'Convert Dust to KCS', direction: 'out', currency: 'BCH', amount: '0.00004', accountType: 'TRADE', context: '{"smallCurrencyExchangeId":"x"}' }),
			raw({ bizType: 'Convert Dust to KCS', direction: 'in', currency: 'KCS', amount: '0.0005', accountType: 'TRADE', context: '{"smallCurrencyExchangeId":"x"}' }),
			raw({ bizType: 'Withdraw', direction: 'out', currency: 'ETH', amount: '0.35054294', fee: '0.00024', context: '{"orderId":"w","txId":"0xabc"}' }),
			raw({ bizType: 'Mystery', direction: 'in' })
		]);
		const by = (t: string) => m.filter((x) => x.type === t);
		const trade = by('Trade')[0]!;
		expect([trade.buy_amount, trade.buy_cur, trade.sell_amount, trade.sell_cur, trade.fee_amount]).toEqual(['125.8704', 'USDT', '1.44', 'DASH', '0.1258704']);
		expect(by('Income').map((x) => classify(x))).toEqual(['earn_income', 'earn_income']);
		expect(classify(by('Withdrawal').find((x) => x.comment === 'Internal Transfer')!)).toBe('transfer');
		expect(by('Other Expense').length).toBe(1);
		expect(classify(by('Other Income (non taxable)')[0]!)).toBe('other_in');
		const w = m.find((x) => x.comment === 'Withdrawal')!;
		expect([classify(w), w.sell_amount, w.fee_amount, w.tx_hash, w.exchange]).toEqual(['external_out', '0.35054294', '0.00024', '0xabc', 'Kucoin Funding']);
		expect(classify(m.find((x) => x.type.startsWith('api:kucoin:Mystery'))!)).toBe('unknown');
	});
});

describe('linkTransfers und FIFO je Börse', () => {
	const fx = new FxTable([{ rate_date: '2020-01-01', rate: '1.25' }]);
	const prices = new PriceTable([{ coin: 'ETH', prices: { '2024-03-03': '3000', '2026-11-11': '2500', '2026-12-01': '2000' } }]);

	it('verknüpft KuCoin-intern und Börse ↔ Börse; Bestand wandert mit Kaufdatum', () => {
		const ledger = linkTransfers([
			// KuCoin: Kauf 2024 (Einstand 0,4 ETH für 800 USDT = 640 EUR), Umbuchung Trading → Funding
			e({ ts: '2024-03-03T10:00:00+00:00', exchange: 'Kucoin Trading', buy_amount: '0.4', buy_cur: 'ETH', sell_amount: '800', sell_cur: 'USDT' }),
			e({ ts: '2024-03-03T11:00:00+00:00', exchange: 'Kucoin Trading', type: 'Withdrawal', sell_amount: '0.4', sell_cur: 'ETH' }),
			e({ ts: '2024-03-03T11:00:05+00:00', exchange: 'Kucoin Funding', type: 'Deposit', buy_amount: '0.4', buy_cur: 'ETH' }),
			// Überweisung KuCoin → Bitget (Gebühr 0,0002), Einzahlung 30 s später
			e({ ts: '2026-11-11T08:24:28+00:00', exchange: 'Kucoin Funding', type: 'Withdrawal', comment: 'Withdrawal', sell_amount: '0.3502', sell_cur: 'ETH', fee_amount: '0.0002', fee_cur: 'ETH', tx_hash: '0xABC' }),
			e({ ts: '2026-11-11T08:24:58+00:00', exchange: 'Bitget Spot', type: 'Deposit', comment: 'Deposit', buy_amount: '0.35', buy_cur: 'ETH' }),
			// Verkauf bei Bitget am 01.12.2026 → Haltefrist ab 2024 → steuerfrei
			e({ ts: '2026-12-01T09:00:00+00:00', buy_amount: '700', buy_cur: 'USDT', sell_amount: '0.35', sell_cur: 'ETH' })
		]);
		expect(ledger.filter((x) => x.link?.kind === 'internal').length).toBe(2);
		expect(ledger.filter((x) => x.link?.kind === 'cross').length).toBe(2);
		const r = computeTax(ledger, fx, 'all', prices);
		const sale = r.disposals.find((d) => d.asset === 'ETH')!;
		expect(sale.venue).toBe('bitget');
		expect(sale.status).toBe('ok');
		expect(sale.portions.map((p) => p.acquiredDay)).toEqual(['2024-03-03']);
		expect(sale.portions[0]!.taxable).toBe(false);
		// Einstand anteilig: 0,35 von 0,3502 aus einem 0,4-Lot zu 640 EUR
		expect(sale.portions[0]!.cost!.toFixed(4)).toBe(new Decimal(640).mul(0.3502).div(0.4).mul(new Decimal(0.35).div(0.3502)).toFixed(4));
		expect(r.holdingsByVenue.kucoin.find((h) => h.asset === 'ETH')!.qty.toString()).toBe('0.0498');
		expect(r.warnings.filter((w) => w.kind === 'external_in' || w.kind === 'external_out')).toEqual([]);
	});

	it('Fehlbestand an der Quelle kommt mit Tageswert am Ziel an', () => {
		const ledger = linkTransfers([
			e({ ts: '2026-11-11T08:24:28+00:00', exchange: 'Kucoin Funding', type: 'Withdrawal', comment: 'Withdrawal', sell_amount: '0.1', sell_cur: 'ETH' }),
			e({ ts: '2026-11-11T08:25:00+00:00', exchange: 'Bitget Spot', type: 'Deposit', comment: 'Deposit', buy_amount: '0.1', buy_cur: 'ETH' })
		]);
		const r = computeTax(ledger, fx, 'all', prices);
		const h = r.holdingsByVenue.bitget.find((x) => x.asset === 'ETH')!;
		expect(h.costKnown.toString()).toBe('200'); // 0,1 × 2500 ÷ 1,25
		expect(h.qtyEstimated!.toString()).toBe('0.1');
		expect(r.warnings.find((w) => w.kind === 'external_in')!.note).toContain('KuCoin → Bitget');
	});

	it('verknüpft nicht bei abweichendem Tx-Hash oder zu großem Abstand', () => {
		const l = linkTransfers([
			e({ ts: '2026-11-11T08:00:00+00:00', exchange: 'Kucoin Funding', type: 'Withdrawal', comment: 'Withdrawal', sell_amount: '1', sell_cur: 'ETH', tx_hash: '0x1' }),
			e({ ts: '2026-11-11T08:10:00+00:00', exchange: 'Bitget Spot', type: 'Deposit', comment: 'Deposit', buy_amount: '1', buy_cur: 'ETH', tx_hash: '0x2' }),
			e({ ts: '2026-11-20T08:10:00+00:00', exchange: 'Bitget Spot', type: 'Deposit', comment: 'Deposit', buy_amount: '1', buy_cur: 'ETH' })
		]);
		expect(l.filter((x) => x.link).length).toBe(0);
	});
});
