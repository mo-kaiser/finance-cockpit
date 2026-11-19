import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { earnPositions } from './earn-positions';
import { mergeLive, type LiveData } from './portfolio';

const empty = { ok: true as const, data: [] };
const base = (p: Partial<LiveData>): LiveData => ({
	at: '',
	spot: empty,
	earnFlex: empty,
	earnFixed: empty,
	futures: empty,
	positions: empty,
	accounts: empty,
	tickers: { ok: true, data: { USDT: '1', SOL: '150', KCS: '10', ETH: '3000' } },
	...p
});

describe('earnPositions', () => {
	const now = Date.parse('2026-11-19T10:00:00Z');
	const bitget = base({
		earnFlex: { ok: true, data: [{ coin: 'USDT', qty: '500', apy: '5.5', raw: { holdDays: 10, totalProfit: '0.7' } }] },
		earnFixed: { ok: true, data: [{ coin: 'SOL', qty: '3.418', apy: '7', raw: { holdDays: 20, period: 30 } }] },
		earnAccount: { ok: true, data: [{ coin: 'USDT', qty: '500' }, { coin: 'SOL', qty: '3.418' }, { coin: 'BGB', qty: '2' }] }
	});
	const kucoin = base({
		earnFlex: { ok: true, data: [{ coin: 'KCS', qty: '1', apy: '3.47', venue: 'kucoin', raw: { productCategory: 'KCS_STAKING', productType: 'DEMAND', lockStartTime: Date.parse('2024-11-30T12:00:00Z') } }] },
		earnAccount: { ok: true, data: [{ coin: 'KCS', qty: '1', venue: 'kucoin' }] }
	});

	it('führt On-Chain Earn aus dem Earn-Konto und den Buchungen zu einer Zeile zusammen', () => {
		const live = base({ earnAccount: { ok: true, data: [{ coin: 'ETH', qty: '3.28687537' }] } });
		const p = earnPositions(live, new Map([['ETH', new Decimal('3.177485')]]), now);
		expect(p).toHaveLength(1);
		expect(p[0]).toMatchObject({ coin: 'ETH', product: 'On-Chain Earn' });
		expect(p[0]!.qty.toString()).toBe('3.28687537');
		expect(p[0]!.note).toContain('+0.10939037');
	});

	it('baut Positionen beider Börsen mit Laufzeit, Ertrag und On-Chain aus Buchungen', () => {
		const p = earnPositions(mergeLive(bitget, kucoin), new Map([['ETH', new Decimal('0.1')]]), now);
		const by = (c: string) => p.find((x) => x.coin === c)!;
		expect(by('USDT')).toMatchObject({ venue: 'bitget', product: 'Flexibel', apy: 5.5, start: '2026-11-09' });
		expect(by('USDT').profit!.toString()).toBe('0.7');
		expect(by('SOL')).toMatchObject({ product: 'Fest 30 Tage', end: '2026-11-29' });
		expect(by('KCS')).toMatchObject({ venue: 'kucoin', product: 'KCS-Staking', start: '2024-11-30' });
		expect(by('ETH')).toMatchObject({ product: 'On-Chain-Staking' });
		expect(by('ETH').valueUsdt!.toString()).toBe('300');
		// BGB ohne Kurs: Rest des Earn-Kontos als sonstiges Produkt
		expect(by('BGB')).toMatchObject({ product: 'Sonstiges Earn-Produkt' });
		expect(p[0]!.coin).toBe('SOL'); // nach Wert sortiert (512,70 > 500)
	});
});
