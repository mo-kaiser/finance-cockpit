import Decimal from 'decimal.js';
import type { Holding } from '$lib/tax/engine';
import { USD_STABLE } from '$lib/tax/assets';
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

export function reconcile(live: LiveData, holdings: Holding[], minUsdt = 1): ReconcileRow[] {
	const all = new Set(['spot', 'earn', 'futures'] as const);
	const p = buildPortfolio(live, null, holdings, all);
	const onChain = new Set<string>();
	if (live.elite?.ok) for (const e of live.elite.data) onChain.add(e.underlying || e.coin).add(e.coin);

	const rows: ReconcileRow[] = [];
	const seen = new Set<string>();
	for (const r of p.rows) {
		seen.add(r.coin);
		if (USD_STABLE.has(r.coin)) continue; // USDT im Futures-Konto enthält unrealisierte Gewinne – kein sinnvoller Abgleich
		const booked = r.computedQty ?? new Decimal(0);
		const gap = r.qty.sub(booked);
		const gapUsdt = r.price ? gap.mul(r.price) : null;
		if (gapUsdt ? gapUsdt.abs().lt(minUsdt) : gap.isZero()) continue;
		rows.push({ coin: r.coin, live: r.qty, booked, gap, gapUsdt, onChain: onChain.has(r.coin) });
	}
	// Coins, die laut Buchungen da sein müssten, bei Bitget aber fehlen
	for (const h of holdings) {
		if (seen.has(h.asset) || USD_STABLE.has(h.asset) || h.qty.isZero()) continue;
		rows.push({ coin: h.asset, live: new Decimal(0), booked: h.qty, gap: h.qty.neg(), gapUsdt: null, onChain: false });
	}
	return rows.sort((a, b) => (b.gapUsdt?.abs() ?? new Decimal(0)).cmp(a.gapUsdt?.abs() ?? new Decimal(0)));
}
