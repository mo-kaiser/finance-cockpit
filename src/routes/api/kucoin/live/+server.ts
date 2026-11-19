import Decimal from 'decimal.js';
import { error, json } from '@sveltejs/kit';
import { kucoinConfigured, kucoinGet, kucoinPaged, type KucoinError } from '#lib/server/kucoin.ts';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 30 };

type Raw = Record<string, unknown>;
type Section<T> = { ok: true; data: T } | { ok: false; error: string };

async function safe<T>(fn: () => Promise<T>): Promise<Section<T>> {
	try {
		return { ok: true, data: await fn() };
	} catch (e) {
		const err = e as KucoinError;
		return { ok: false, error: `${err.message}${err.code ? ` (${err.code})` : ''}` };
	}
}
const str = (x: unknown) => (x === undefined || x === null ? '' : String(x));

let tickerCache: { at: number; prices: Record<string, string> } | null = null;
/** Öffentliche Marktkurse (Coin → USDT) */
async function prices() {
	if (tickerCache && Date.now() - tickerCache.at < 30_000) return tickerCache.prices;
	const res = await fetch('https://api.kucoin.com/api/v1/market/allTickers');
	const body = (await res.json().catch(() => null)) as { code?: string; data?: { ticker?: Raw[] } } | null;
	if (!res.ok || body?.code !== '200000') throw new Error(`KuCoin-Kurse: HTTP ${res.status}`);
	const out: Record<string, string> = { USDT: '1' };
	for (const t of body.data?.ticker ?? []) {
		const sym = str(t.symbol);
		if (sym.endsWith('-USDT') && t.last) out[sym.slice(0, -5)] = str(t.last);
	}
	tickerCache = { at: Date.now(), prices: out };
	return out;
}

/**
 * Live-Bestände bei KuCoin im selben Format wie /api/bitget/live (LiveData), damit das Dashboard
 * sie gleich behandelt: Main- und Trading-Konto → „Spot“, Earn-Bestände → „Earn“.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const claims = await locals.getClaims();
	if (claims?.aal !== 'aal2') error(401, 'Nicht angemeldet');
	if (!kucoinConfigured()) return json({ configured: false });

	const [spot, holds, tickers] = await Promise.all([
		safe(async () =>
			(await kucoinGet<Raw[]>('/api/v1/accounts'))
				.filter((a) => ['main', 'trade', 'trade_hf'].includes(str(a.type)) && Number(a.balance) > 0)
				.map((a) => ({ coin: str(a.currency), available: str(a.available), frozen: str(a.holds), locked: '0' }))
		),
		safe(async () => (await kucoinPaged<Raw>('/api/v1/earn/hold-assets', {}, 500, 5)).filter((h) => Number(h.holdAmount) > 0)),
		safe(prices)
	]);

	// Earn-Positionen: returnRate ist ein Anteil (0,0347 = 3,47 % p. a.); DEMAND = flexibel, sonst mit Laufzeit
	const item = (h: Raw) => ({
		coin: str(h.currency),
		qty: str(h.holdAmount),
		apy: h.returnRate ? String(Number(h.returnRate) * 100) : '',
		venue: 'kucoin' as const,
		raw: h
	});
	const sec = <T,>(f: (rows: Raw[]) => T) => (holds.ok ? { ok: true as const, data: f(holds.data) } : holds);
	const earnFlex = sec((rows) => rows.filter((h) => str(h.productType) === 'DEMAND').map(item));
	const earnFixed = sec((rows) => rows.filter((h) => str(h.productType) !== 'DEMAND').map(item));
	const earnAccount = sec((rows) => {
		const m = new Map<string, Decimal>();
		for (const h of rows) m.set(str(h.currency), (m.get(str(h.currency)) ?? new Decimal(0)).add(str(h.holdAmount) || 0));
		return [...m].map(([coin, q]) => ({ coin, qty: q.toString(), venue: 'kucoin' as const }));
	});

	return json({
		configured: true,
		at: new Date().toISOString(),
		spot,
		earnFlex,
		earnFixed,
		earnAccount,
		elite: { ok: true, data: [] },
		futures: { ok: true, data: [] },
		positions: { ok: true, data: [] },
		accounts: { ok: true, data: [] },
		tickers
	});
};
