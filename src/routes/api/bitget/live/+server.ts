import { error, json } from '@sveltejs/kit';
import { bitgetGet, bitgetPublic, BitgetError } from '$lib/server/bitget';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 30 };

type Raw = Record<string, unknown>;
type Section<T> = { ok: true; data: T } | { ok: false; error: string };

async function safe<T>(fn: () => Promise<T>): Promise<Section<T>> {
	try {
		return { ok: true, data: await fn() };
	} catch (e) {
		const err = e as BitgetError;
		return { ok: false, error: `${err.message}${err.code ? ` (${err.code})` : ''}` };
	}
}

const arr = (x: unknown): Raw[] => (Array.isArray(x) ? (x as Raw[]) : []);
const str = (x: unknown) => (x === undefined || x === null ? '' : String(x));

// Marktkurse kurz zwischenspeichern (öffentlich, für alle gleich)
let tickerCache: { at: number; prices: Record<string, string> } | null = null;
async function prices() {
	if (tickerCache && Date.now() - tickerCache.at < 30_000) return tickerCache.prices;
	const data = arr(await bitgetPublic('/api/v2/spot/market/tickers'));
	const out: Record<string, string> = { USDT: '1' };
	for (const t of data) {
		const sym = str(t.symbol);
		if (sym.endsWith('USDT') && t.lastPr) out[sym.slice(0, -4)] = str(t.lastPr);
	}
	tickerCache = { at: Date.now(), prices: out };
	return out;
}

/** Earn-Bestände (flexibel und fest); Bitget liefert { resultList, endId }. */
async function earn(periodType: 'flexible' | 'fixed') {
	const d = ((await bitgetGet<Raw>('/api/v2/earn/savings/assets', { periodType, pageSize: 100 })) ?? {}) as Raw;
	const list = Array.isArray(d) ? (d as Raw[]) : arr(d.resultList);
	return list.map((r) => ({
		coin: str(r.productCoin ?? r.coin ?? r.interestCoin),
		qty: str(r.holdAmount ?? r.amount ?? r.totalAmount),
		apy: str((Array.isArray(r.apy) ? (r.apy as Raw[])[0]?.currentApy : r.apy) ?? ''),
		raw: r
	}));
}

/** Earn-Konto gesamt je Coin (alle Earn-Produkte laut Bitget-Doku „earn account assets overview“). */
async function earnAccount() {
	return arr(await bitgetGet('/api/v2/earn/account/assets')).map((a) => ({ coin: str(a.coin), qty: str(a.amount) }));
}

/** On-Chain-Earn („Elite“, z. B. BGETH/BGSOL/BGBTC/BGUSD) mit Wert in USDT. */
async function elite() {
	const d = ((await bitgetGet<Raw>('/api/v2/earn/elite/assets')) ?? {}) as Raw;
	const list = Array.isArray(d) ? (d as Raw[]) : arr(d.resultList);
	return list.map((r) => ({
		coin: str(r.productCoin),
		qty: str(r.holdingAmount),
		valueUsdt: str(r.usdtHoldingAmount),
		underlying: str(r.subscriptionCoin),
		underlyingQty: str(r.exchangeAmount),
		apr: str(r.apr)
	}));
}

/** Live-Bestände und Kurse von Bitget (nur lesend). */
export const GET: RequestHandler = async ({ locals }) => {
	const claims = await locals.getClaims();
	if (claims?.aal !== 'aal2') error(401, 'Nicht angemeldet');

	const [spot, earnFlex, earnFixed, earnAcc, earnElite, futures, positions, accounts, tickers] = await Promise.all([
		safe(async () =>
			arr(await bitgetGet('/api/v2/spot/account/assets')).map((a) => ({
				coin: str(a.coin),
				available: str(a.available),
				frozen: str(a.frozen),
				locked: str(a.locked)
			}))
		),
		safe(() => earn('flexible')),
		safe(() => earn('fixed')),
		safe(earnAccount),
		safe(elite),
		safe(async () =>
			arr(await bitgetGet('/api/v2/mix/account/accounts', { productType: 'USDT-FUTURES' })).map((a) => ({
				marginCoin: str(a.marginCoin),
				available: str(a.available),
				locked: str(a.locked),
				accountEquity: str(a.accountEquity),
				usdtEquity: str(a.usdtEquity),
				unrealizedPL: str(a.unrealizedPL ?? a.crossedUnrealizedPL)
			}))
		),
		safe(async () =>
			arr(await bitgetGet('/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES', marginCoin: 'USDT' })).map((p) => ({
				symbol: str(p.symbol),
				holdSide: str(p.holdSide),
				total: str(p.total),
				openPriceAvg: str(p.openPriceAvg),
				markPrice: str(p.markPrice),
				unrealizedPL: str(p.unrealizedPL),
				leverage: str(p.leverage),
				marginSize: str(p.marginSize),
				liquidationPrice: str(p.liquidationPrice)
			}))
		),
		safe(async () =>
			arr(await bitgetGet('/api/v2/account/all-account-balance')).map((a) => ({
				accountType: str(a.accountType),
				usdtBalance: str(a.usdtBalance)
			}))
		),
		safe(prices)
	]);

	return json({ at: new Date().toISOString(), spot, earnFlex, earnFixed, earnAccount: earnAcc, elite: earnElite, futures, positions, accounts, tickers });
};
