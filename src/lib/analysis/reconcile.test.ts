import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { onChainStaked, reconcile } from './reconcile';
import type { LedgerEntry } from '$lib/tax/types';
import type { LiveData } from './portfolio';

const ok = <T,>(data: T) => ({ ok: true as const, data });
const live: LiveData = {
	at: '',
	spot: ok([
		{ coin: 'BGB', available: '2.3', frozen: '0', locked: '0' },
		{ coin: 'USDT', available: '100', frozen: '0', locked: '0' }
	]),
	earnFlex: ok([]),
	earnFixed: ok([]),
	earnAccount: ok([
		{ coin: 'BGB', qty: '238.4' },
		{ coin: 'ETH', qty: '3.2883' }
	]),
	elite: ok([{ coin: 'ETH', qty: '2.5', valueUsdt: '4500', underlying: 'ETH', underlyingQty: '2.5', apr: '3' }]),
	futures: ok([]),
	positions: ok([]),
	accounts: ok([]),
	tickers: ok({ BGB: '1.6', ETH: '1800', USDT: '1' })
};
const h = (asset: string, q: string) => ({ asset, qty: new Decimal(q), costKnown: new Decimal(1), qtyCostUnknown: new Decimal(0) });

describe('reconcile', () => {
	it('zeigt Lücken, erkennt On-Chain-Staking und ignoriert Stablecoins', () => {
		const rows = reconcile(live, [h('BGB', '46.9'), h('ETH', '3.1784'), h('USDT', '5'), h('DOT', '2')], onChainStaked([], live));
		const by = Object.fromEntries(rows.map((r) => [r.coin, r]));
		expect(by.BGB!.gap.toString()).toBe('193.8');
		expect(by.BGB!.onChain).toBe(false);
		expect(by.ETH!.gap.toString()).toBe('0.1099');
		expect(by.ETH!.onChain).toBe(true);
		expect(by.USDT).toBeUndefined();
		expect(by.DOT!.gap.toString()).toBe('-2');
		expect(rows[0]!.coin).toBe('BGB'); // größte Lücke zuerst (310 USDT)
	});

	it('blendet Kleinstabweichungen aus', () => {
		expect(reconcile(live, [h('BGB', '240.4'), h('ETH', '3.2883')]).map((r) => r.coin)).toEqual([]);
	});
});

describe('onChainStaked', () => {
	const e = (p: Partial<LedgerEntry>): LedgerEntry => ({ tx_id: 'x', ts: '', day: '', type: 'Deposit', buy_amount: null, buy_cur: null, sell_amount: null, sell_cur: null, fee_amount: null, fee_cur: null, exchange: 'Bitget Spot', trade_group: null, comment: null, n: 1, ...p });
	it('erkennt laufendes On-Chain-Staking aus den Buchungen', () => {
		const s = onChainStaked([
			e({ type: 'Withdrawal', sell_amount: '2.4', sell_cur: 'ETH', comment: 'financial_pos_out' }),
			e({ type: 'Withdrawal', sell_amount: '0.7', sell_cur: 'ETH', comment: 'Internal Transfer', trade_group: 'FINANCIAL_POS_PLEDGE_USER_OUT' }),
			e({ type: 'Withdrawal', sell_amount: '30', sell_cur: 'SOL2', comment: 'financial_pos_out' }),
			e({ type: 'Deposit', buy_amount: '30', buy_cur: 'SOL2', comment: 'financial_pos_pledge_user_in' }),
			e({ type: 'Deposit', exchange: 'Bitget Earn', buy_amount: '9', buy_cur: 'BGB', comment: 'financial_pos_out' })
		]);
		expect([...s]).toEqual(['ETH']);
	});
});
