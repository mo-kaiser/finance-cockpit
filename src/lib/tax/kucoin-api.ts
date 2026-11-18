import Decimal from 'decimal.js';
import type { LedgerEntry } from './types';

/**
 * KuCoin-Kontobuchungen (api_records source 'kucoin', endpoint 'kucoin_ledgers') → Ledger-Buchungen
 * im CoinTracking-Format, damit Klassifizierung und Engine sie wie Bitget/CoinTracking behandeln.
 * Inventur 18.11.2026: KuCoin Earn Profits, Hold to Earn Earnings, KuCoin Earn Locked/Redemptions, Transfer,
 * Spot (in/out je tradeId), Convert Dust to KCS, Deduction Coupon Refund, Withdraw (Deposit nach Doku).
 */

export interface KucoinLedgerRaw {
	id: string;
	currency: string;
	amount: string;
	fee: string;
	balance?: string;
	accountType: string;
	bizType: string;
	direction: 'in' | 'out';
	createdAt: number;
	context?: string;
}

export interface KucoinRecordRow {
	record_id: string;
	ts: string;
	raw: KucoinLedgerRaw;
}

const D = (v: unknown) => {
	try {
		return new Decimal(typeof v === 'string' || typeof v === 'number' ? v || 0 : 0);
	} catch {
		return new Decimal(0);
	}
};

const berlinDay = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

/** Konto-Bezeichnung wie CoinTracking („Kucoin Funding“ = Main, „Kucoin Trading“ = Trade) */
const ACCOUNT: Record<string, string> = { MAIN: 'Kucoin Funding', TRADE: 'Kucoin Trading', TRADE_HF: 'Kucoin Trading' };
const account = (t: string) => ACCOUNT[t?.toUpperCase()] ?? `Kucoin ${t}`;

function ctx(raw: KucoinLedgerRaw): Record<string, string> {
	try {
		return raw.context ? (JSON.parse(raw.context) as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** Erträge (§ 22 Nr. 3) */
const INCOME = /earn profits|earnings|interest|staking (profits|rewards)|reward|airdrop|bonus|cashback/i;
/** Bewegungen zwischen eigenen KuCoin-Konten bzw. in/aus Earn-Produkten (steuerlich ohne Wirkung) */
const INTERNAL = /^transfer$|sub transfer|earn (locked|subscri|redemption|redeem|unlock)|hold to earn (subscri|redemption)|staking (subscri|redemption)|savings (subscri|redemption)/i;

export function mapKucoinLedger(rows: KucoinRecordRow[]): LedgerEntry[] {
	const out: LedgerEntry[] = [];
	const trades = new Map<string, KucoinLedgerRaw[]>();
	const dust = new Map<string, KucoinLedgerRaw[]>();

	const base = (r: KucoinLedgerRaw, type: string, comment: string): LedgerEntry => ({
		tx_id: `kucoin:${r.id}`,
		ts: new Date(r.createdAt).toISOString().replace('Z', '+00:00'), // gleiches Format wie Postgres (Sortierung als Text)
		day: berlinDay(r.createdAt),
		type,
		buy_amount: null,
		buy_cur: null,
		sell_amount: null,
		sell_cur: null,
		fee_amount: null,
		fee_cur: null,
		exchange: account(r.accountType),
		trade_group: r.bizType,
		comment,
		n: 1
	});
	const inflow = (r: KucoinLedgerRaw, type: string, comment: string): LedgerEntry => ({
		...base(r, type, comment),
		// Zugang: amount ist netto; eine Gebühr ist bereits abgezogen
		buy_amount: D(r.amount).toString(),
		buy_cur: r.currency
	});
	const outflow = (r: KucoinLedgerRaw, type: string, comment: string): LedgerEntry => ({
		...base(r, type, comment),
		// Abgang: amount enthält die Gebühr bereits (Auszahlung 11/2026: 0,35054294 = 0,35030294 + 0,00024)
		sell_amount: D(r.amount).toString(),
		sell_cur: r.currency,
		fee_amount: D(r.fee).isZero() ? null : D(r.fee).toString(),
		fee_cur: D(r.fee).isZero() ? null : r.currency
	});

	for (const { raw: r } of rows) {
		if (!r || !r.bizType) continue;
		const biz = r.bizType.trim();
		const c = ctx(r);

		if (/^spot$|^trade_exchange$|exchange$/i.test(biz) && c.tradeId) {
			const k = `${c.orderId ?? ''}:${c.tradeId}`;
			trades.set(k, [...(trades.get(k) ?? []), r]);
		} else if (/convert dust|small assets|dust/i.test(biz)) {
			const k = c.smallCurrencyExchangeId ?? `${r.createdAt}`;
			dust.set(k, [...(dust.get(k) ?? []), r]);
		} else if (/^deposit$/i.test(biz)) {
			const e = inflow(r, 'Deposit', 'Deposit');
			e.tx_hash = c.txId ?? c.walletTxId ?? null;
			out.push(e);
		} else if (/^withdraw(al)?$/i.test(biz)) {
			const e = outflow(r, 'Withdrawal', 'Withdrawal');
			e.tx_hash = c.txId ?? c.walletTxId ?? null;
			out.push(e);
		} else if (INTERNAL.test(biz)) {
			out.push(r.direction === 'in' ? inflow(r, 'Deposit', 'Internal Transfer') : outflow(r, 'Withdrawal', 'Internal Transfer'));
		} else if (/coupon refund|fee refund|rebate/i.test(biz) && r.direction === 'in') {
			out.push(inflow(r, 'Other Income (non taxable)', biz));
		} else if (INCOME.test(biz) && r.direction === 'in') {
			out.push(inflow(r, 'Income', biz));
		} else {
			// Unbekannt: nicht still mitrechnen, sondern als Warnung zeigen
			out.push(r.direction === 'in' ? inflow(r, `api:kucoin:${biz}`, biz) : outflow(r, `api:kucoin:${biz}`, biz));
		}
	}

	// Spot-Trades: je tradeId ein Zugang und ein Abgang
	for (const legs of trades.values()) {
		const inn = legs.find((l) => l.direction === 'in');
		const outLeg = legs.find((l) => l.direction === 'out');
		if (!inn || !outLeg) {
			for (const l of legs) out.push(l.direction === 'in' ? inflow(l, 'api:kucoin:Spot (einseitig)', 'Spot') : outflow(l, 'api:kucoin:Spot (einseitig)', 'Spot'));
			continue;
		}
		const fee = D(inn.fee).add(D(outLeg.fee));
		const e: LedgerEntry = {
			...base(inn, 'Trade', 'Spot'),
			tx_id: `kucoin:${inn.id}`,
			// Zugang brutto (Engine zieht die Gebühr im gekauften Coin wieder ab)
			buy_amount: D(inn.amount).add(D(inn.fee)).toString(),
			buy_cur: inn.currency,
			sell_amount: D(outLeg.amount).toString(),
			sell_cur: outLeg.currency,
			fee_amount: fee.isZero() ? null : D(inn.fee).isZero() ? D(outLeg.fee).toString() : D(inn.fee).toString(),
			fee_cur: fee.isZero() ? null : D(inn.fee).isZero() ? outLeg.currency : inn.currency
		};
		// Gebühr im verkauften Coin: Abgang ist im amount bereits enthalten → nicht doppelt zählen
		if (D(inn.fee).isZero() && !D(outLeg.fee).isZero()) e.sell_amount = D(outLeg.amount).sub(D(outLeg.fee)).toString();
		out.push(e);
	}

	// Kleinstbeträge → KCS: Abgänge ohne Erlös, Zugang zum Tageswert (wie Bitget „Exchange income“)
	for (const legs of dust.values()) {
		for (const l of legs) {
			out.push(l.direction === 'in' ? inflow(l, 'Other Income (non taxable)', 'Convert Dust to KCS') : outflow(l, 'Other Expense', 'Convert Dust to KCS'));
		}
	}

	return out;
}
