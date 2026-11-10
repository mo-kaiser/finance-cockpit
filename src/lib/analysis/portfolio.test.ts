import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildPortfolio, type LiveData } from './portfolio';

const live: LiveData = {
	at: '2026-11-10T16:00:00Z',
	spot: { ok: true, data: [{ coin: 'BTC', available: '0.0002', frozen: '0', locked: '0' }, { coin: 'USDT', available: '1400', frozen: '0', locked: '0' }] },
	earnFlex: { ok: true, data: [{ coin: 'BTC', qty: '0.0008', apy: '1' }] },
	earnFixed: { ok: false, error: 'kein Zugriff' },
	futures: { ok: true, data: [{ marginCoin: 'USDT', available: '2900', locked: '100', accountEquity: '3000', usdtEquity: '3000', unrealizedPL: '0' }] },
	positions: { ok: true, data: [] },
	accounts: { ok: true, data: [] },
	tickers: { ok: true, data: { BTC: '80000', USDT: '1' } }
};
const eur = new Decimal('0.8');
const all = new Set(['spot', 'earn', 'futures'] as const);

describe('buildPortfolio', () => {
	it('summiert Konten, bewertet und verteilt Anteile', () => {
		const p = buildPortfolio(live, eur, [], all);
		expect(p.totalUsdt.toString()).toBe('4480'); // 0,001 BTC × 80.000 + 4.400 USDT
		expect(p.totalEur!.toString()).toBe('3584');
		const btc = p.rows.find((r) => r.coin === 'BTC')!;
		expect(btc.qty.toString()).toBe('0.001');
		expect(btc.byAccount.earn.toString()).toBe('0.0008');
	});

	it('Earn-Gesamtübersicht ersetzt Savings, On-Chain-Earn wird ergänzt und über Bitgets USDT-Wert bewertet', () => {
		const p = buildPortfolio(
			{
				...live,
				earnAccount: { ok: true, data: [{ coin: 'BTC', qty: '0.0008' }, { coin: 'ETH', qty: '0.5' }] },
				elite: { ok: true, data: [{ coin: 'BGETH', qty: '2', valueUsdt: '6400', underlying: 'ETH', underlyingQty: '2', apr: '3' }] },
				tickers: { ok: true, data: { BTC: '80000', ETH: '3000', USDT: '1' } }
			},
			eur,
			[],
			all
		);
		const by = Object.fromEntries(p.rows.map((r) => [r.coin, r.valueUsdt?.toString()]));
		expect(by).toMatchObject({ BTC: '80', ETH: '1500', BGETH: '6400' });
	});

	it('Kontofilter', () => {
		const p = buildPortfolio(live, eur, [], new Set(['futures'] as const));
		expect(p.rows.map((r) => r.coin)).toEqual(['USDT']);
		expect(p.totalUsdt.toString()).toBe('3000');
	});

	it('Einstand nur, wenn die Historie den Bestand erklärt', () => {
		const ok = buildPortfolio(live, eur, [{ asset: 'BTC', qty: new Decimal('0.001'), costKnown: new Decimal(60), qtyCostUnknown: new Decimal(0) }], all);
		const btc = ok.rows.find((r) => r.coin === 'BTC')!;
		expect(btc.costEur!.toString()).toBe('60');
		expect(btc.unrealizedEur!.toString()).toBe('4'); // 64 € Wert − 60 € Einstand

		const off = buildPortfolio(live, eur, [{ asset: 'BTC', qty: new Decimal('0.002'), costKnown: new Decimal(60), qtyCostUnknown: new Decimal(0) }], all);
		expect(off.rows.find((r) => r.coin === 'BTC')!.costNote).toMatch(/Historie/);
	});
});
