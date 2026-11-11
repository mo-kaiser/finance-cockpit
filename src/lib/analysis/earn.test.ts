import { existsSync, readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { parseCoinTrackingCsv } from '$lib/import/cointracking';
import { ledgerFromCt } from '$lib/tax/ledger-from-ct';
import type { LedgerEntry } from '$lib/tax/types';
import { earnEvents, realizedApr, summarizeEarn } from './earn';

const e = (p: Partial<LedgerEntry> & { day: string; type: string; buy_amount: string; buy_cur: string }): LedgerEntry => ({
	tx_id: Math.random().toString(),
	ts: `${p.day} 01:00:00`,
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

describe('Earn-Auswertung', () => {
	const ledger = [
		e({ day: '2026-10-01', type: 'Staking', comment: 'batch_interest_user_in', buy_amount: '0.001', buy_cur: 'ETH', n: 24 }),
		e({ day: '2026-10-02', type: 'Staking', comment: 'batch_interest_user_in', buy_amount: '0.001', buy_cur: 'ETH', n: 24 }),
		e({ day: '2026-10-02', type: 'Reward / Bonus', comment: 'Interest', buy_amount: '1.5', buy_cur: 'USDT' }),
		e({ day: '2026-10-05', type: 'Airdrop', buy_amount: '2.354', buy_cur: 'USDT' }),
		e({ day: '2026-11-01', type: 'Other Income', comment: 'Crypto Voucher Distribution', buy_amount: '10', buy_cur: 'XYZ' }),
		e({ day: '2026-11-01', type: 'Deposit', comment: 'Internal Transfer', buy_amount: '100', buy_cur: 'USDT' }),
		e({ day: '2026-11-02', type: 'Staking', buy_amount: '1', buy_cur: 'SOL2' })
	];
	const ev = earnEvents(ledger);
	const s = summarizeEarn(ev, '2026-01-01', '2026-12-31', { ETH: new Decimal(3000), SOL: new Decimal(180) });

	it('nur Earn-Zuflüsse, Ticker vereinheitlicht', () => {
		expect(ev.length).toBe(6);
		expect(s.byCoin.map((c) => c.coin).sort()).toEqual(['ETH', 'SOL', 'USDT', 'XYZ']);
		expect(s.bookings).toBe(52);
	});

	it('Bewertung zum heutigen Kurs, Stablecoins 1:1, unbekannte Kurse ausgewiesen', () => {
		const eth = s.byCoin.find((c) => c.coin === 'ETH')!;
		expect(eth.valueUsdt!.toString()).toBe('6');
		expect(eth.days).toBe(2);
		expect(s.totalUsdt.toString()).toBe('189.854'); // 6 + 3,854 + 180
		expect(s.unpricedCoins).toEqual(['XYZ']);
		expect(s.byKind.airdrop.toString()).toBe('2.354');
		expect(s.byMonth.map((m) => [m.month, m.valueUsdt.toString(), m.unpriced])).toEqual([
			['2026-10', '9.854', 0],
			['2026-11', '180', 1]
		]);
	});

	it('tatsächliche Rendite p. a.', () => {
		// 0,002 ETH in 30 Tagen auf 2 ETH → 1,2167 % p. a.
		expect(realizedApr(new Decimal('0.002'), new Decimal(2), 30)).toBeCloseTo(0.012167, 5);
	});
});

const path = process.env.CT_CSV;
describe.runIf(path && existsSync(path))('echter Export', () => {
	it('Earn-Erträge je Coin', () => {
		const ev = earnEvents(ledgerFromCt(parseCoinTrackingCsv(readFileSync(path!, 'utf8')).rows));
		const s = summarizeEarn(ev, '2026-01-01', '2026-12-31', {});
		const eth = s.byCoin.find((c) => c.coin === 'ETH')!;
		console.log(JSON.stringify({ coins: s.byCoin.length, bookings: s.bookings, top: s.byCoin.slice(0, 6).map((c) => [c.coin, c.qty.toFixed(6), c.bookings, c.days]) }));
		expect(eth.qty.gt(0)).toBe(true);
		expect(s.bookings).toBeGreaterThan(40_000);
	});
});
