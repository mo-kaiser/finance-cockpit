import Decimal from 'decimal.js';
import type { Holding } from '$lib/tax/engine';

export type Account = 'spot' | 'earn' | 'futures';
type Section<T> = { ok: true; data: T } | { ok: false; error: string };

/** Antwort von /api/bitget/live */
export interface LiveData {
	at: string;
	spot: Section<{ coin: string; available: string; frozen: string; locked: string }[]>;
	earnFlex: Section<{ coin: string; qty: string; apy: string }[]>;
	earnFixed: Section<{ coin: string; qty: string; apy: string }[]>;
	/** Earn-Konto gesamt je Coin (optional, neuere Antworten) */
	earnAccount?: Section<{ coin: string; qty: string }[]>;
	/** On-Chain-Earn (Elite), Wert in USDT von Bitget */
	elite?: Section<{ coin: string; qty: string; valueUsdt: string; underlying: string; underlyingQty: string; apr: string }[]>;
	futures: Section<{ marginCoin: string; available: string; locked: string; accountEquity: string; usdtEquity: string; unrealizedPL: string }[]>;
	positions: Section<{ symbol: string; holdSide: string; total: string; openPriceAvg: string; markPrice: string; unrealizedPL: string; leverage: string; marginSize: string; liquidationPrice: string }[]>;
	accounts: Section<{ accountType: string; usdtBalance: string }[]>;
	tickers: Section<Record<string, string>>;
}

export interface PortfolioRow {
	coin: string;
	byAccount: Record<Account, Decimal>;
	qty: Decimal;
	price: Decimal | null; // USDT
	valueUsdt: Decimal | null;
	valueEur: Decimal | null;
	share: number | null;
	/** aus der Buchungshistorie (FIFO), über alle Bitget-Konten */
	computedQty: Decimal | null;
	costEur: Decimal | null; // anteiliger Einstand für die angezeigte Menge
	unrealizedEur: Decimal | null;
	costNote: string | null;
}

const D = (s: string | undefined | null) => {
	try {
		return new Decimal(s && s !== '' ? s : 0);
	} catch {
		return new Decimal(0);
	}
};

export function buildPortfolio(
	live: LiveData,
	eurPerUsdt: Decimal | null,
	costHoldings: Holding[],
	accounts: Set<Account>
): { rows: PortfolioRow[]; totalUsdt: Decimal; totalEur: Decimal | null; unpriced: string[] } {
	const map = new Map<string, Record<Account, Decimal>>();
	const put = (coin: string, acc: Account, q: Decimal) => {
		if (!coin || q.isZero()) return;
		const r = map.get(coin) ?? { spot: new Decimal(0), earn: new Decimal(0), futures: new Decimal(0) };
		r[acc] = r[acc].add(q);
		map.set(coin, r);
	};

	if (live.spot.ok) for (const a of live.spot.data) put(a.coin, 'spot', D(a.available).add(D(a.frozen)).add(D(a.locked)));

	// Earn: bevorzugt die Gesamtübersicht des Earn-Kontos; sonst Savings flexibel + fest
	const earnCoins = new Set<string>();
	if (live.earnAccount?.ok && live.earnAccount.data.length) {
		for (const e of live.earnAccount.data) {
			put(e.coin, 'earn', D(e.qty));
			earnCoins.add(e.coin);
		}
	} else {
		for (const s of [live.earnFlex, live.earnFixed]) if (s.ok) for (const e of s.data) {
			put(e.coin, 'earn', D(e.qty));
			earnCoins.add(e.coin);
		}
	}
	// On-Chain-Earn: nur ergänzen, was die Übersicht nicht schon enthält; Kurs aus Bitgets USDT-Wert
	const impliedPrice: Record<string, Decimal> = {};
	if (live.elite?.ok) {
		for (const e of live.elite.data) {
			if (earnCoins.has(e.coin)) continue;
			const q = D(e.qty);
			put(e.coin, 'earn', q);
			if (!q.isZero() && e.valueUsdt) impliedPrice[e.coin] = D(e.valueUsdt).div(q);
		}
	}
	if (live.futures.ok) for (const f of live.futures.data) put(f.marginCoin, 'futures', D(f.accountEquity));

	const prices = live.tickers.ok ? live.tickers.data : {};
	const cost = new Map(costHoldings.map((h) => [h.asset, h]));
	const unpriced: string[] = [];
	const all = accounts.size === 3;

	const rows: PortfolioRow[] = [];
	for (const [coin, byAccount] of map) {
		const qty = [...accounts].reduce((s, a) => s.add(byAccount[a]), new Decimal(0));
		if (qty.isZero()) continue;
		const p = prices[coin] ? D(prices[coin]) : (impliedPrice[coin] ?? null);
		if (!p) unpriced.push(coin);
		const valueUsdt = p ? qty.mul(p) : null;
		const valueEur = valueUsdt && eurPerUsdt ? valueUsdt.mul(eurPerUsdt) : null;

		// Einstand: nur wenn die Historie die Menge erklärt und alle Kosten bekannt sind
		const h = cost.get(coin);
		const liveTotal = byAccount.spot.add(byAccount.earn).add(byAccount.futures);
		let costEur: Decimal | null = null;
		let costNote: string | null = null;
		if (!h) costNote = 'keine Anschaffung in den Daten';
		else if (!h.qtyCostUnknown.isZero()) costNote = `${h.qtyCostUnknown.toSignificantDigits(6)} ohne bekannte Kosten`;
		else {
			const diff = h.qty.sub(liveTotal).abs();
			const tol = Decimal.max(liveTotal.mul('0.01'), new Decimal('0.000001'));
			if (diff.gt(tol)) costNote = `Historie ${h.qty.toSignificantDigits(8)} ≠ Bestand`;
			else costEur = h.costKnown.mul(qty).div(h.qty);
		}
		rows.push({
			coin,
			byAccount,
			qty,
			price: p,
			valueUsdt,
			valueEur,
			share: null,
			computedQty: all && h ? h.qty : (h?.qty ?? null),
			costEur,
			unrealizedEur: costEur && valueEur ? valueEur.sub(costEur) : null,
			costNote
		});
	}

	const totalUsdt = rows.reduce((s, r) => s.add(r.valueUsdt ?? 0), new Decimal(0));
	for (const r of rows) r.share = r.valueUsdt && !totalUsdt.isZero() ? r.valueUsdt.div(totalUsdt).toNumber() : null;
	rows.sort((a, b) => (b.valueUsdt ?? new Decimal(0)).cmp(a.valueUsdt ?? new Decimal(0)));

	return { rows, totalUsdt, totalEur: eurPerUsdt ? totalUsdt.mul(eurPerUsdt) : null, unpriced };
}
