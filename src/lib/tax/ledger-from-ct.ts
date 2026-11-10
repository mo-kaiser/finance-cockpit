import Decimal from 'decimal.js';
import type { CtRow } from '../import/cointracking';
import type { LedgerEntry } from './types';

/** Baut aus CSV-Zeilen dieselbe Struktur wie die View v_ledger (Zinsen pro Tag/Coin zusammengefasst). */
export function ledgerFromCt(rows: CtRow[]): LedgerEntry[] {
	const out: LedgerEntry[] = [];
	const agg = new Map<string, LedgerEntry>();
	for (const r of rows) {
		if (!r.exchange.startsWith('Bitget')) continue;
		const day = r.date_raw.slice(0, 10);
		if (r.exchange === 'Bitget Spot' && (r.type === 'Staking' || r.type === 'Reward / Bonus')) {
			const key = `${r.type}|${r.buy_cur}|${day}`;
			const a = agg.get(key);
			if (!a) {
				agg.set(key, {
					tx_id: `agg:${key}`, ts: r.date_raw, day, type: r.type, buy_amount: r.buy_amount, buy_cur: r.buy_cur,
					sell_amount: null, sell_cur: null, fee_amount: null, fee_cur: null, exchange: r.exchange,
					trade_group: null, comment: r.comment, n: 1
				});
			} else {
				a.buy_amount = new Decimal(a.buy_amount ?? 0).add(r.buy_amount ?? 0).toString();
				if (r.date_raw > a.ts) a.ts = r.date_raw;
				a.n++;
			}
			continue;
		}
		out.push({ ...r, ts: r.date_raw, day, n: 1 });
	}
	return [...out, ...agg.values()];
}
