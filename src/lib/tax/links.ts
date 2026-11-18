import Decimal from 'decimal.js';
import { asset } from './assets';
import { classify } from './classify';
import { venueOf, type LedgerEntry } from './types';

/**
 * Erkennt Umbuchungen zwischen eigenen Konten und Börsen und markiert beide Seiten (LedgerEntry.link):
 *   1. KuCoin intern: CoinTracking führt Funding ↔ Trading als Auszahlung + Einzahlung ohne Kommentar.
 *      Paar = gleicher Coin, gleiche Menge, anderes KuCoin-Konto, höchstens 2 Stunden auseinander.
 *   2. Börse ↔ Börse (z. B. ETH KuCoin → Bitget): Auszahlung und Einzahlung an verschiedenen Börsen,
 *      gleicher Coin, Einzahlung = Auszahlung (mit oder ohne Netzwerkgebühr), Einzahlung zwischen 2 Stunden
 *      vor und 3 Tagen nach der Auszahlung; bei bekanntem Tx-Hash beider Seiten muss er übereinstimmen.
 * Gibt eine neue Liste zurück; die Eingabe bleibt unverändert.
 */

const HOUR = 3_600_000;
const t = (e: LedgerEntry) => Date.parse(e.ts.includes('T') || e.ts.includes('+') ? e.ts : `${e.ts.replace(' ', 'T')}Z`);
const D = (v: string | null | undefined) => new Decimal(v || 0);
const close = (a: Decimal, b: Decimal) => a.sub(b).abs().lte(Decimal.max(a.abs(), b.abs()).mul('1e-9'));

export function linkTransfers(ledger: LedgerEntry[]): LedgerEntry[] {
	const links = new Map<string, LedgerEntry['link']>();

	// 1. KuCoin intern
	const kc = ledger.filter((e) => venueOf(e) === 'kucoin' && (e.type === 'Deposit' || e.type === 'Withdrawal') && e.comment !== 'Internal Transfer');
	const kcIn = kc.filter((e) => e.type === 'Deposit');
	for (const w of kc.filter((e) => e.type === 'Withdrawal')) {
		if (!w.sell_cur) continue;
		const coin = asset(w.sell_cur);
		const amount = D(w.sell_amount);
		let best: LedgerEntry | null = null;
		let bestDt = Infinity;
		for (const d of kcIn) {
			if (links.has(d.tx_id) || d.exchange === w.exchange || !d.buy_cur || asset(d.buy_cur) !== coin) continue;
			if (!close(D(d.buy_amount), amount)) continue;
			const dt = Math.abs(t(d) - t(w));
			if (dt <= 2 * HOUR && dt < bestDt) {
				best = d;
				bestDt = dt;
			}
		}
		if (best) {
			links.set(w.tx_id, { kind: 'internal', peer: best.tx_id });
			links.set(best.tx_id, { kind: 'internal', peer: w.tx_id });
		}
	}

	// 2. Börse ↔ Börse
	const isLinked = (e: LedgerEntry) => links.has(e.tx_id);
	const outs = ledger.filter((e) => !isLinked(e) && classify(e) === 'external_out' && e.sell_cur).sort((a, b) => t(a) - t(b));
	const ins = ledger.filter((e) => !isLinked(e) && classify(e) === 'external_in' && e.buy_cur);
	for (const w of outs) {
		const coin = asset(w.sell_cur!);
		const gross = D(w.sell_amount);
		const net = gross.sub(w.fee_cur && asset(w.fee_cur) === coin ? D(w.fee_amount) : 0);
		const from = venueOf(w);
		let best: LedgerEntry | null = null;
		let bestScore = Infinity;
		for (const d of ins) {
			if (links.has(d.tx_id) || venueOf(d) === from || asset(d.buy_cur!) !== coin) continue;
			const dt = t(d) - t(w);
			if (dt < -2 * HOUR || dt > 72 * HOUR) continue;
			const sameHash = !!w.tx_hash && !!d.tx_hash && w.tx_hash.toLowerCase() === d.tx_hash.toLowerCase();
			if (w.tx_hash && d.tx_hash && !sameHash) continue;
			const amt = D(d.buy_amount);
			if (!sameHash && !close(amt, net) && !close(amt, gross)) continue;
			const score = sameHash ? -1 : Math.abs(dt);
			if (score < bestScore) {
				best = d;
				bestScore = score;
			}
		}
		if (best) {
			const to = venueOf(best);
			links.set(w.tx_id, { kind: 'cross', peer: best.tx_id, role: 'out', from, to });
			links.set(best.tx_id, { kind: 'cross', peer: w.tx_id, role: 'in', from, to });
		}
	}

	if (!links.size) return ledger;
	return ledger.map((e) => (links.has(e.tx_id) ? { ...e, link: links.get(e.tx_id) } : e));
}
