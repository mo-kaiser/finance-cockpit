import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '#lib/tax/types.ts';
import { buildMovements, shortAddr, type WalletRecord } from './transfers';

const e = (p: Partial<LedgerEntry>): LedgerEntry => ({
	tx_id: p.tx_id ?? Math.random().toString(36),
	ts: '2026-11-12T10:00:00+00:00',
	day: '2026-11-12',
	type: 'Deposit',
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

const dep = (id: string, raw: Record<string, unknown>): WalletRecord => ({
	endpoint: 'deposits',
	record_id: id,
	ts: new Date(Number(raw.cTime)).toISOString(),
	raw
});

describe('buildMovements', () => {
	it('reichert eine Einzahlung mit Netzwerk und Absender an', () => {
		const t = Date.parse('2026-11-12T09:58:00Z');
		const m = buildMovements(
			[e({ tx_id: 'b1', buy_amount: '0.5', buy_cur: 'ETH', comment: 'Deposit' })],
			[dep('o1', { orderId: 'o1', coin: 'ETH', size: '0.5', status: 'success', chain: 'ERC20', fromAddress: '0xabcdef0123456789abcd', tradeId: '0xhash', dest: 'on_chain', cTime: String(t), uTime: String(t) })]
		);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ bucket: 'external', direction: 'in', coin: 'ETH', from: 'Extern', to: 'Spot', chain: 'ERC20', txHash: '0xhash', status: 'success', source: 'ledger' });
		expect(m[0]!.amount.toString()).toBe('0.5');
	});

	it('zeigt eine ausstehende Einzahlung ohne Buchung', () => {
		const t = Date.parse('2026-11-17T09:00:00Z');
		const m = buildMovements([], [dep('o2', { coin: 'USDT', size: '100', status: 'pending', dest: 'internal_transfer', cTime: String(t) })]);
		expect(m[0]).toMatchObject({ status: 'pending', source: 'record', viaBitget: true, txHash: null });
	});

	it('ordnet eine Auszahlung (Ledger brutto, Datensatz netto + Gebühr) zu', () => {
		const t = Date.parse('2026-09-03T12:00:00Z');
		const m = buildMovements(
			[e({ ts: '2026-09-03T12:00:05+00:00', type: 'Withdrawal', comment: 'Withdrawal', sell_amount: '1', sell_cur: 'SOL2', fee_amount: '0.006', fee_cur: 'SOL2' })],
			[{ endpoint: 'withdrawals', record_id: 'w1', ts: '', raw: { coin: 'SOL', size: '0.994', fee: '0.006', toAddress: 'Abc', status: 'success', cTime: String(t) } }]
		);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ direction: 'out', coin: 'SOL', to: 'Extern', address: 'Abc' });
	});

	it('paart Umbuchungen und trennt Earn ab', () => {
		const m = buildMovements(
			[
				e({ tx_id: 's1', type: 'Withdrawal', sell_amount: '500', sell_cur: 'USDT', comment: 'Internal Transfer' }),
				e({ tx_id: 'f1', ts: '2026-11-12T10:00:01+00:00', exchange: 'Bitget Futures', buy_amount: '500', buy_cur: 'USDT', comment: 'Internal Transfer' }),
				e({ tx_id: 's2', ts: '2026-11-12T00:00:00+00:00', type: 'Withdrawal', sell_amount: '3', sell_cur: 'USDT', comment: 'financial_lock_out' }),
				e({ tx_id: 'e2', ts: '2026-11-12T00:00:00+00:00', exchange: 'Bitget Earn', buy_amount: '3', buy_cur: 'USDT', comment: 'financial_lock_out' }),
				// API: Earn-Anlage nur mit Spot-Seite
				e({ tx_id: 's3', ts: '2026-11-13T00:00:00+00:00', type: 'Withdrawal', sell_amount: '2', sell_cur: 'USDT', comment: 'Internal Transfer', trade_group: 'SINGLE_USER_OUT' })
			],
			[]
		);
		expect(m.map((x) => [x.bucket, x.from, x.to, x.amount.toString()])).toEqual([
			['earn', 'Spot', 'Earn', '2'],
			['internal', 'Spot', 'Futures', '500'],
			['earn', 'Spot', 'Earn', '3']
		]);
	});

	it('zeigt Euro-Käufe als Einzahlung vom Bankkonto', () => {
		const m = buildMovements([e({ type: 'Trade', buy_amount: '538', buy_cur: 'USDT', sell_amount: '500', sell_cur: 'EUR', comment: 'fiat_balance_success_user_in' })], []);
		expect(m[0]).toMatchObject({ bucket: 'external', direction: 'in', coin: 'USDT', from: 'Bank (EUR)', to: 'Spot' });
		expect(m[0]!.eur!.toString()).toBe('500');
	});

	it('kürzt Adressen', () => {
		expect(shortAddr('0x1234567890abcdef1234')).toBe('0x1234…1234');
		expect(shortAddr(null)).toBe('');
	});
});

describe('Überweisung zwischen Börsen', () => {
	it('zeigt KuCoin → Bitget als eine Zeile mit Netzwerk aus den Bitget-Einzahlungsdaten', async () => {
		const { linkTransfers } = await import('#lib/tax/links.ts');
		const t = Date.parse('2026-11-11T08:24:53Z');
		const ledger = linkTransfers([
			e({ tx_id: 'kw', ts: '2026-11-11T08:24:28+00:00', exchange: 'Kucoin Funding', type: 'Withdrawal', comment: 'Withdrawal', sell_amount: '0.35054294', sell_cur: 'ETH', fee_amount: '0.00024', fee_cur: 'ETH', tx_hash: '0xabc' }),
			e({ tx_id: 'bd', ts: '2026-11-11T08:24:53+00:00', type: 'Deposit', comment: 'Deposit', buy_amount: '0.35030294', buy_cur: 'ETH' })
		]);
		const m = buildMovements(ledger, [dep('o9', { coin: 'ETH', size: '0.35030294', status: 'success', chain: 'BEP20', fromAddress: '0x0310', tradeId: '0xabc', dest: 'on_chain', cTime: String(t), uTime: String(t) })]);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ bucket: 'external', direction: 'move', from: 'KuCoin', to: 'Spot', chain: 'BEP20', txHash: '0xabc', coin: 'ETH' });
		expect(m[0]!.fee!.toString()).toBe('0.00024');
	});
});
