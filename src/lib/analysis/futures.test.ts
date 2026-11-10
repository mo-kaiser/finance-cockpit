import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCoinTrackingCsv } from '$lib/import/cointracking';
import { FxTable } from '$lib/tax/fx';
import type { LedgerEntry } from '$lib/tax/types';
import { ledgerFromCt } from '$lib/tax/ledger-from-ct';
import { futuresEvents, futuresStats, inRange } from './futures';

const fx = new FxTable([{ rate_date: '2023-01-01', rate: '1.25' }]);
let n = 0;
const fut = (day: string, time: string, type: string, comment: string, amount: string): LedgerEntry => {
	const neg = amount.startsWith('-');
	return {
		tx_id: `f${++n}`,
		ts: `${day} ${time}`,
		day,
		type,
		buy_amount: neg ? null : amount,
		buy_cur: neg ? null : 'USDT',
		sell_amount: neg ? amount.slice(1) : null,
		sell_cur: neg ? 'USDT' : null,
		fee_amount: null,
		fee_cur: null,
		exchange: 'Bitget Futures',
		trade_group: null,
		comment,
		n: 1
	};
};

describe('futuresStats', () => {
	const ledger = [
		fut('2026-01-05', '10:15:00', 'Derivatives / Futures Profit', 'Close Long', '100'),
		fut('2026-01-05', '10:15:00', 'Other Fee', 'Futures Fee', '-2'),
		fut('2026-01-06', '15:30:00', 'Derivatives / Futures Loss', 'Close Short', '-50'),
		fut('2026-01-07', '09:00:00', 'Derivatives / Futures Profit', 'Close Short', '30'),
		fut('2026-01-07', '09:00:00', 'Other Income', 'Contract Margin Settle Fee', '1'),
		fut('2026-01-08', '16:00:00', 'Derivatives / Futures Loss', 'Close Long', '-90'),
		{ ...fut('2026-01-08', '16:00:00', 'Deposit', 'Internal Transfer', '500') }
	];
	const ev = futuresEvents(ledger, fx);
	const s = futuresStats(ev, 'USDT');

	it('zählt Trades, Gewinne, Verluste und ignoriert Umbuchungen', () => {
		expect(ev.length).toBe(6);
		expect([s.total.trades, s.total.wins, s.total.losses]).toEqual([4, 2, 2]);
		expect(s.total.net.toString()).toBe('-11');
		expect(s.total.fees.toString()).toBe('-2');
		expect(s.total.funding.toString()).toBe('1');
	});

	it('Kennzahlen wie in PaperTrade', () => {
		expect(s.winPct).toBe(0.5);
		expect(s.avgWin!.toString()).toBe('65');
		expect(s.avgLoss!.toString()).toBe('-70');
		expect(s.profitFactor).toBeCloseTo(130 / 140);
		expect(s.payoff).toBeCloseTo(65 / 70);
		expect([s.streakWin, s.streakLoss]).toEqual([1, 1]);
		// Kurve: 98, 48, 79, -11 → größter Rückgang 98 → -11 = 109
		expect(s.maxDrawdown.toString()).toBe('109');
		expect(s.days).toEqual({ total: 4, win: 2, loss: 2 });
	});

	it('Long/Short, Wochentag und Uhrzeit', () => {
		expect(s.byDir.long.trades).toBe(2);
		expect(s.byDir.short.pnl.toString()).toBe('-20');
		expect(s.byWeekday[0]!.trades).toBe(1); // 05.01.2026 ist ein Montag
		expect(s.byHour[16]!.pnl.toString()).toBe('-90');
	});

	it('EUR über den Tageskurs', () => {
		expect(futuresStats(ev, 'EUR').total.net.toString()).toBe('-8.8');
	});
});

const path = process.env.CT_CSV;
describe.runIf(path && existsSync(path))('echter Export', () => {
	it('Futures 2026 entsprechen der Steuer-Auswertung (Saldo 639,65 USDT)', () => {
		const ledger = ledgerFromCt(parseCoinTrackingCsv(readFileSync(path!, 'utf8')).rows);
		const ev = futuresEvents(ledger, fx);
		const s26 = futuresStats(inRange(ev, '2026-01-01', '2026-12-31'), 'USDT');
		// Gegenrechnung Python: 831,78+0,72 − 156,72 − 6,32 (Gebühren) − 29,82 (Funding) + 0,03
		expect(s26.total.net.mul(1).toFixed(2)).toBe('639.65');
		const all = futuresStats(ev, 'USDT');
		console.log(JSON.stringify({
			trades: all.total.trades, net: all.total.net.toFixed(2), winPct: all.winPct, pf: all.profitFactor,
			fees: all.total.fees.toFixed(2), funding: all.total.funding.toFixed(2), maxDD: all.maxDrawdown.toFixed(2),
			months: [...all.byMonth.entries()].slice(-6).map(([m, b]) => [m, b.net.toFixed(2), b.trades])
		}));
	});
});
