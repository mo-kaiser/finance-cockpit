import Decimal from 'decimal.js';
import { asset } from '#lib/tax/assets.ts';
import { classify } from '#lib/tax/classify.ts';
import type { LedgerEntry } from '#lib/tax/types.ts';

/**
 * Geld- und Coin-Bewegungen für das Dashboard:
 *   * extern: Ein- und Auszahlungen (Wallets, andere Börsen) aus dem Ledger, angereichert um Netzwerk,
 *     Adresse, Tx-Hash und Status aus den Bitget-Ein-/Auszahlungsdaten (api_records deposits/withdrawals)
 *   * intern: Umbuchungen zwischen Bitget-Konten (Spot, Futures, Bots), beide Seiten zu einer Zeile gepaart
 *   * earn: Anlage in und Rückgabe aus Earn (sehr viele, tägliche Auto-Anlage) – eigener Filter
 * Nur Anzeige, keine steuerliche Wirkung.
 */

export interface WalletRecord {
	endpoint: string; // 'deposits' | 'withdrawals'
	record_id: string;
	ts: string;
	raw: Record<string, unknown>;
}

export type Bucket = 'external' | 'internal' | 'earn';
export type Status = 'success' | 'pending' | 'failed';

export interface Movement {
	key: string;
	ts: string;
	bucket: Bucket;
	direction: 'in' | 'out' | 'move';
	coin: string;
	amount: Decimal;
	fee: Decimal | null;
	from: string;
	to: string;
	status: Status | null;
	chain: string | null;
	address: string | null;
	txHash: string | null;
	/** Bitget-interne Überweisung (UID, E-Mail) statt Blockchain */
	viaBitget: boolean;
	/** Euro-Betrag bei Einzahlung/Auszahlung über das Bankkonto (Kauf/Verkauf gegen EUR) */
	eur: Decimal | null;
	/** Herkunft: Ledger (gebucht) oder nur Bitget-Ein-/Auszahlungsdaten (noch nicht gebucht, ausstehend) */
	source: 'ledger' | 'record';
}

const D = (v: unknown) => {
	try {
		return new Decimal(typeof v === 'string' || typeof v === 'number' ? v || 0 : 0);
	} catch {
		return new Decimal(0);
	}
};
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);

const ACCOUNT: Record<string, string> = {
	'bitget spot': 'Spot',
	'bitget futures': 'Futures',
	'bitget earn': 'Earn',
	'bitget strategy': 'Bots'
};
const account = (exchange: string) => ACCOUNT[exchange.toLowerCase()] ?? exchange.replace(/^Bitget /i, '');

const EARN_HINT = /financial|poolx|redemption|single_|lock_|savings|earn/i;

function status(raw: Record<string, unknown>): Status | null {
	const s = (str(raw.status) ?? '').toLowerCase();
	if (s === 'success') return 'success';
	if (s === 'fail' || s === 'failed' || s === 'reject' || s === 'cancel') return 'failed';
	return s ? 'pending' : null;
}

const recordTime = (r: WalletRecord) => Number(str(r.raw.uTime) ?? str(r.raw.cTime) ?? Date.parse(r.ts));

/** Wie weit Buchung und Ein-/Auszahlungsdatensatz zeitlich auseinander liegen dürfen. */
const MATCH_MS = 3 * 86_400_000;

function fromRecord(r: WalletRecord): Pick<Movement, 'status' | 'chain' | 'address' | 'txHash' | 'viaBitget'> {
	const isIn = r.endpoint === 'deposits';
	const via = (str(r.raw.dest) ?? '').toLowerCase().includes('internal');
	return {
		status: status(r.raw),
		chain: str(r.raw.chain),
		address: str(isIn ? r.raw.fromAddress : r.raw.toAddress),
		txHash: via ? null : str(r.raw.tradeId),
		viaBitget: via
	};
}

export function buildMovements(ledger: LedgerEntry[], records: WalletRecord[]): Movement[] {
	const out: Movement[] = [];
	const used = new Set<string>();

	// --- extern (Ein-/Auszahlungen) -------------------------------------------------------
	for (const e of ledger) {
		const cat = classify(e);
		if (cat !== 'external_in' && cat !== 'external_out') continue;
		const isIn = cat === 'external_in';
		const coin = asset((isIn ? e.buy_cur : e.sell_cur) ?? '?');
		const amount = D(isIn ? e.buy_amount : e.sell_amount);
		const fee = e.fee_amount ? D(e.fee_amount) : null;
		const t = Date.parse(e.ts);

		// passenden Datensatz suchen: gleicher Coin, gleiche Menge (Auszahlung brutto oder netto), zeitlich am nächsten
		let best: WalletRecord | null = null;
		let bestDist = Infinity;
		for (const r of records) {
			if (used.has(r.record_id) || r.endpoint !== (isIn ? 'deposits' : 'withdrawals')) continue;
			if (asset(str(r.raw.coin) ?? '') !== coin) continue;
			const size = D(r.raw.size).abs();
			const rf = D(r.raw.fee).abs();
			const sameAmount = size.eq(amount) || size.add(rf).eq(amount) || (fee !== null && size.eq(amount.sub(fee)));
			if (!sameAmount) continue;
			const dist = Math.abs(recordTime(r) - t);
			if (dist <= MATCH_MS && dist < bestDist) {
				best = r;
				bestDist = dist;
			}
		}
		if (best) used.add(best.record_id);

		out.push({
			key: `l:${e.tx_id}`,
			ts: e.ts,
			bucket: 'external',
			direction: isIn ? 'in' : 'out',
			coin,
			amount,
			fee: fee && !fee.isZero() ? fee : best && !D(best.raw.fee).isZero() ? D(best.raw.fee).abs() : null,
			from: isIn ? 'Extern' : account(e.exchange),
			to: isIn ? account(e.exchange) : 'Extern',
			...(best
				? fromRecord(best)
				: { status: 'success' as const, chain: null, address: null, txHash: null, viaBitget: false }),
			eur: null,
			source: 'ledger'
		});
	}

	// Euro über das Bankkonto: Bitget bucht eine SEPA-Einzahlung direkt als Kauf (EUR → USDT/USDC),
	// eine eigene EUR-Einzahlung gibt es in den Daten nicht. Verkauf gegen EUR entsprechend als Auszahlung.
	for (const e of ledger) {
		const sellEur = e.type === 'Trade' && e.sell_cur === 'EUR';
		const buyEur = e.type === 'Trade' && e.buy_cur === 'EUR';
		const apiFiat = e.type.startsWith('api:') && /FIAT/i.test(e.type);
		if (!sellEur && !buyEur && !apiFiat) continue;
		const isIn = sellEur || apiFiat;
		out.push({
			key: `f:${e.tx_id}`,
			ts: e.ts,
			bucket: 'external',
			direction: isIn ? 'in' : 'out',
			coin: asset((isIn ? e.buy_cur : e.sell_cur) ?? '?'),
			amount: D(isIn ? e.buy_amount : e.sell_amount),
			fee: e.fee_amount && !D(e.fee_amount).isZero() ? D(e.fee_amount) : null,
			from: isIn ? 'Bank (EUR)' : account(e.exchange),
			to: isIn ? account(e.exchange) : 'Bank (EUR)',
			status: 'success',
			chain: null,
			address: null,
			txHash: null,
			viaBitget: false,
			eur: sellEur ? D(e.sell_amount) : buyEur ? D(e.buy_amount) : null,
			source: 'ledger'
		});
	}

	// Ein-/Auszahlungen, die (noch) keine Buchung haben: ausstehend, fehlgeschlagen oder noch nicht abgerufen
	for (const r of records) {
		if (used.has(r.record_id)) continue;
		const isIn = r.endpoint === 'deposits';
		const fee = D(r.raw.fee).abs();
		out.push({
			key: `r:${r.endpoint}:${r.record_id}`,
			ts: new Date(recordTime(r)).toISOString(),
			bucket: 'external',
			direction: isIn ? 'in' : 'out',
			coin: asset(str(r.raw.coin) ?? '?'),
			amount: D(r.raw.size).abs(),
			fee: fee.isZero() ? null : fee,
			from: isIn ? 'Extern' : 'Spot',
			to: isIn ? 'Spot' : 'Extern',
			...fromRecord(r),
			eur: null,
			source: 'record'
		});
	}

	// --- Umbuchungen zwischen Bitget-Konten -----------------------------------------------
	interface Leg {
		e: LedgerEntry;
		acc: string;
		coin: string;
		amount: Decimal;
		sign: 1 | -1;
		earn: boolean;
	}
	const legs: Leg[] = [];
	for (const e of ledger) {
		if (classify(e) !== 'transfer') continue;
		const isIn = e.type === 'Deposit';
		const acc = account(e.exchange);
		legs.push({
			e,
			acc,
			coin: asset((isIn ? e.buy_cur : e.sell_cur) ?? '?'),
			amount: D(isIn ? e.buy_amount : e.sell_amount).abs(),
			sign: isIn ? 1 : -1,
			earn: acc === 'Earn' || EARN_HINT.test(`${e.comment ?? ''} ${e.trade_group ?? ''}`)
		});
	}

	// Paaren: gleiche Sekunde (± 2 s), gleicher Coin, gleiche Menge, entgegengesetzte Richtung, anderes Konto
	const second = (ts: string) => Math.round(Date.parse(ts) / 1000);
	const bySig = new Map<string, Leg[]>();
	for (const l of legs) {
		const k = `${l.coin}|${l.amount.toString()}`;
		bySig.set(k, [...(bySig.get(k) ?? []), l]);
	}
	const paired = new Set<Leg>();
	for (const group of bySig.values()) {
		if (group.length < 2) continue;
		group.sort((a, b) => Date.parse(a.e.ts) - Date.parse(b.e.ts));
		for (const out_ of group) {
			if (out_.sign !== -1 || paired.has(out_)) continue;
			const t = second(out_.e.ts);
			const inn = group.find((l) => l.sign === 1 && !paired.has(l) && l.acc !== out_.acc && Math.abs(second(l.e.ts) - t) <= 2);
			if (!inn) continue;
			paired.add(out_);
			paired.add(inn);
			out.push(internal(out_, inn));
		}
	}
	for (const l of legs) if (!paired.has(l)) out.push(internal(l.sign === -1 ? l : null, l.sign === 1 ? l : null));

	function internal(o: Leg | null, i: Leg | null): Movement {
		const l = (o ?? i)!;
		// Ohne Gegenbuchung ist das andere Konto unbekannt; Earn-Bewegungen der API haben nur die Spot-Seite
		const other = l.earn ? 'Earn' : '?';
		return {
			key: `t:${o?.e.tx_id ?? ''}:${i?.e.tx_id ?? ''}`,
			ts: (i ?? o)!.e.ts,
			bucket: o?.earn || i?.earn ? 'earn' : 'internal',
			direction: 'move',
			coin: l.coin,
			amount: l.amount,
			fee: null,
			from: o ? o.acc : other,
			to: i ? i.acc : other,
			status: 'success',
			chain: null,
			address: null,
			txHash: null,
			viaBitget: false,
			eur: null,
			source: 'ledger'
		};
	}

	// Zeitstempel kommen in unterschiedlichen Formaten (Postgres/ISO) → numerisch sortieren
	return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || a.key.localeCompare(b.key));
}

/** Adresse gekürzt: 0x1234…abcd */
export const shortAddr = (a: string | null) => (!a ? '' : a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
