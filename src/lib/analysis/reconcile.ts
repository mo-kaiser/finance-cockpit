import Decimal from 'decimal.js';
import type { Holding } from '#lib/tax/engine.ts';
import { asset, FIAT_EUR, USD_STABLE } from '#lib/tax/assets.ts';
import type { LedgerEntry } from '#lib/tax/types.ts';
import { buildPortfolio, type LiveData } from './portfolio';

/** Abgleich Live-Bestand bei Bitget gegen Bestand aus den Buchungen (FIFO-Historie). */
export interface ReconcileRow {
	coin: string;
	live: Decimal;
	booked: Decimal;
	/** live − booked: positiv = Bitget hat mehr, als die Buchungen erklären */
	gap: Decimal;
	gapUsdt: Decimal | null;
	/** Coin liegt im On-Chain-Staking: Lücke sind vermutlich noch nicht ausgezahlte Erträge */
	onChain: boolean;
}

/**
 * Coins, die derzeit im On-Chain-Staking liegen: Summe der Spot-Abgänge ins On-Chain-Earn
 * (CoinTracking financial_pos_out, API FINANCIAL_POS_…_OUT) abzüglich der Rückflüsse (…pos_pledge_user_in).
 * Dort wachsen die Erträge im Produkt an und werden erst beim Beenden gebucht.
 */
export function onChainStaked(ledger: LedgerEntry[], live?: LiveData): Set<string> {
	const net = new Map<string, Decimal>();
	for (const e of ledger) {
		if (e.exchange !== 'Bitget Spot') continue;
		const text = `${e.comment ?? ''} ${e.trade_group ?? ''}`;
		if (!/pos_/i.test(text)) continue;
		if (e.type === 'Withdrawal' && e.sell_cur && /_out\b/i.test(text)) {
			const c = asset(e.sell_cur);
			net.set(c, (net.get(c) ?? new Decimal(0)).add(e.sell_amount ?? 0));
		} else if (e.type === 'Deposit' && e.buy_cur && /_in\b/i.test(text)) {
			const c = asset(e.buy_cur);
			net.set(c, (net.get(c) ?? new Decimal(0)).sub(e.buy_amount ?? 0));
		}
	}
	const out = new Set([...net].filter(([, q]) => q.gt(0)).map(([c]) => c));
	if (live?.elite?.ok) for (const e of live.elite.data) out.add(e.underlying || e.coin).add(e.coin);
	return out;
}

export function reconcile(
	live: LiveData,
	holdings: Holding[],
	onChain: Set<string> = new Set(),
	minUsdt = 1,
	/** Kurs (USDT) für Coins ohne Live-Kurs, z. B. letzter Tageskurs */
	fallbackPrice: (coin: string) => Decimal | null = () => null
): ReconcileRow[] {
	const all = new Set(['spot', 'earn', 'futures'] as const);
	const p = buildPortfolio(live, null, holdings, all, onChain);

	const rows: ReconcileRow[] = [];
	const seen = new Set<string>();
	for (const r of p.rows) {
		seen.add(r.coin);
		// USDT im Futures-Konto enthält unrealisierte Gewinne; EUR ist Restguthaben aus Euro-Einzahlungen – beides kein Coin-Bestand
		if (USD_STABLE.has(r.coin) || r.coin === FIAT_EUR) continue;
		const booked = r.computedQty ?? new Decimal(0);
		const gap = r.qty.sub(booked);
		const gapUsdt = r.price ? gap.mul(r.price) : null;
		if (gapUsdt ? gapUsdt.abs().lt(minUsdt) : gap.isZero()) continue;
		rows.push({ coin: r.coin, live: r.qty, booked, gap, gapUsdt, onChain: onChain.has(r.coin) });
	}
	// Coins, die laut Buchungen da sein müssten, bei Bitget aber fehlen
	for (const h of holdings) {
		if (seen.has(h.asset) || USD_STABLE.has(h.asset) || h.asset === FIAT_EUR || h.qty.isZero()) continue;
		const p = fallbackPrice(h.asset);
		const gapUsdt = p ? h.qty.mul(p).neg() : null;
		if (gapUsdt && gapUsdt.abs().lt(minUsdt)) continue;
		rows.push({ coin: h.asset, live: new Decimal(0), booked: h.qty, gap: h.qty.neg(), gapUsdt, onChain: false });
	}
	return rows.sort((a, b) => (b.gapUsdt?.abs() ?? new Decimal(0)).cmp(a.gapUsdt?.abs() ?? new Decimal(0)));
}
