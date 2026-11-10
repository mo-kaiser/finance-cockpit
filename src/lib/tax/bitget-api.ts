import Decimal from 'decimal.js';
import type { LedgerEntry } from './types';

/** Zeile der View v_api_ledger (Bitget-Kontobuchungen, ohne die bereits aus CoinTracking bekannten). */
export interface ApiLedgerRow {
	tx_id: string;
	endpoint: string;
	ts: string;
	day: string;
	business_type: string | null;
	group_type: string | null;
	coin: string | null;
	size: string | null;
	fees: string | null;
	biz_order_id: string | null;
	symbol: string | null;
	n: number;
}

const D = (s: string | null) => new Decimal(s && s !== '' ? s : 0);
const abs = (s: string | null) => D(s).abs().toString();

function base(r: ApiLedgerRow, exchange: string): LedgerEntry {
	return {
		tx_id: r.tx_id,
		ts: r.ts,
		day: r.day,
		type: '',
		buy_amount: null,
		buy_cur: null,
		sell_amount: null,
		sell_cur: null,
		fee_amount: null,
		fee_cur: null,
		exchange,
		trade_group: null,
		comment: `api:${r.business_type ?? ''}`,
		n: r.n
	};
}

/** Zu- oder Abgang als Ein-/Auszahlung (Umbuchung oder extern). */
function move(r: ApiLedgerRow, exchange: string, comment: string): LedgerEntry {
	const e = base(r, exchange);
	const size = D(r.size);
	const fee = D(r.fees).abs();
	e.comment = comment;
	if (size.gte(0)) {
		e.type = 'Deposit';
		e.buy_amount = size.toString();
		e.buy_cur = r.coin;
	} else {
		e.type = 'Withdrawal';
		e.sell_amount = size.abs().toString();
		e.sell_cur = r.coin;
	}
	if (fee.gt(0)) {
		e.fee_amount = fee.toString();
		e.fee_cur = r.coin;
	}
	return e;
}

function income(r: ApiLedgerRow, type: string): LedgerEntry {
	const e = base(r, 'Bitget Spot');
	e.type = type;
	e.buy_amount = r.size;
	e.buy_cur = r.coin;
	return e;
}

const INCOME_SPOT: Record<string, string> = {
	BATCH_INTEREST_USER_IN: 'Staking',
	LOCK_INTEREST_USER_IN: 'Staking',
	AIRDROP_REWARDS: 'Airdrop',
	CASH_COUPON_ACTIVITY_USER_IN: 'Other Income'
};

function mapSpot(rows: ApiLedgerRow[]): LedgerEntry[] {
	const out: LedgerEntry[] = [];
	const trades = new Map<string, ApiLedgerRow[]>();

	for (const r of rows) {
		const bt = (r.business_type ?? '').toUpperCase();
		const gt = (r.group_type ?? '').toLowerCase();

		if (INCOME_SPOT[bt]) out.push(income(r, INCOME_SPOT[bt]!));
		// Spot-Trades: groupType „transaction“ (BUY = eingehende, SELL = ausgehende Seite), laut Doku auch „trade“
		else if (gt === 'transaction' || gt === 'trade') {
			const k = r.biz_order_id ?? r.tx_id;
			trades.set(k, [...(trades.get(k) ?? []), r]);
		} else if (gt === 'deposit') out.push(move(r, 'Bitget Spot', 'Deposit'));
		else if (gt === 'withdraw') out.push(move(r, 'Bitget Spot', 'Withdrawal'));
		else if (gt === 'financial' && /INTEREST|REWARD|PROFIT/.test(bt) && D(r.size).gt(0)) out.push(income(r, 'Staking'));
		else if (gt === 'transfer' || gt === 'financial') out.push(move(r, 'Bitget Spot', 'Internal Transfer'));
		else {
			// Unbekannt: bewusst nicht zuordnen, erscheint als Warnung
			const e = base(r, 'Bitget Spot');
			e.type = `api:${bt || gt || 'unbekannt'}`;
			out.push(e);
		}
	}

	// Spot-Trades: zwei Buchungen (Zugang/Abgang) mit gleicher bizOrderId
	for (const [orderId, legs] of trades) {
		const pos = legs.filter((l) => D(l.size).gt(0));
		const neg = legs.filter((l) => D(l.size).lt(0));
		const coinsPos = new Set(pos.map((l) => l.coin));
		const coinsNeg = new Set(neg.map((l) => l.coin));
		if (coinsPos.size !== 1 || coinsNeg.size !== 1) {
			for (const l of legs) {
				const e = base(l, 'Bitget Spot');
				e.type = 'api:trade-ungepaart';
				out.push(e);
			}
			continue;
		}
		const sum = (ls: ApiLedgerRow[], f: (l: ApiLedgerRow) => string | null) => ls.reduce((s, l) => s.add(D(f(l))), new Decimal(0));
		const buy = sum(pos, (l) => l.size);
		const sell = sum(neg, (l) => l.size).abs();
		const feeBuy = sum(pos, (l) => l.fees).abs();
		const feeSell = sum(neg, (l) => l.fees).abs();
		const first = [...legs].sort((a, b) => (a.ts < b.ts ? -1 : 1))[0]!;
		const last = [...legs].sort((a, b) => (a.ts < b.ts ? 1 : -1))[0]!;
		const e = base({ ...first, ts: last.ts, tx_id: `trade:${orderId}` }, 'Bitget Spot');
		e.type = 'Trade';
		e.comment = 'api:trade';
		e.buy_amount = buy.toString();
		e.buy_cur = pos[0]!.coin;
		e.sell_amount = sell.toString();
		e.sell_cur = neg[0]!.coin;
		if (feeBuy.gt(0) && feeSell.gt(0)) {
			e.type = 'api:trade-gebuehr-beidseitig';
		} else if (feeBuy.gt(0)) {
			e.fee_amount = feeBuy.toString();
			e.fee_cur = e.buy_cur;
		} else if (feeSell.gt(0)) {
			e.fee_amount = feeSell.toString();
			e.fee_cur = e.sell_cur;
		}
		out.push(e);
	}
	return out;
}

function mapFutures(r: ApiLedgerRow): LedgerEntry[] {
	const bt = (r.business_type ?? '').toLowerCase();
	const size = D(r.size);
	const fee = D(r.fees);
	const out: LedgerEntry[] = [];

	if (bt.startsWith('trans_')) return [move(r, 'Bitget Futures', 'Internal Transfer')];

	const signed = (e: LedgerEntry, v: Decimal) => {
		if (v.gte(0)) {
			e.buy_amount = v.toString();
			e.buy_cur = r.coin;
		} else {
			e.sell_amount = v.abs().toString();
			e.sell_cur = r.coin;
		}
		return e;
	};

	if (bt.includes('settle_fee')) {
		// Funding
		const e = base(r, 'Bitget Futures');
		e.type = size.gte(0) ? 'Other Income' : 'Other Fee';
		e.comment = 'Contract Margin Settle Fee';
		out.push(signed(e, size));
	} else if (/^(close_|burst_|force_|liquidat|delivery_)/.test(bt) || bt.includes('close')) {
		if (!size.isZero()) {
			const e = base(r, 'Bitget Futures');
			e.type = size.gt(0) ? 'Derivatives / Futures Profit' : 'Derivatives / Futures Loss';
			out.push(signed(e, size));
		}
	} else if (bt.startsWith('open_')) {
		if (!size.isZero()) {
			const e = base(r, 'Bitget Futures');
			e.type = size.gt(0) ? 'Other Income' : 'Other Fee';
			out.push(signed(e, size));
		}
	} else if (!size.isZero()) {
		// sonstige Futures-Buchung: zählt als Termingeschäft „Sonstiges“
		const e = base(r, 'Bitget Futures');
		e.type = size.gt(0) ? 'Other Income' : 'Other Fee';
		out.push(signed(e, size));
	}

	// Handelsgebühr als eigene Buchung
	if (!fee.isZero()) {
		const e = base({ ...r, tx_id: `${r.tx_id}:fee` }, 'Bitget Futures');
		e.type = bt.startsWith('open_') ? 'Margin Fee' : 'Other Fee';
		e.comment = bt.startsWith('open_') ? 'Open Long' : 'Futures Fee';
		out.push(signed(e, fee));
	}
	return out;
}

/** Übersetzt Bitget-API-Buchungen in dieselbe Form wie CoinTracking-Zeilen (gleiche Klassifizierung). */
export function mapApiLedger(rows: ApiLedgerRow[]): LedgerEntry[] {
	const spot = rows.filter((r) => r.endpoint === 'spot_bills');
	const fut = rows.filter((r) => r.endpoint === 'futures_bills_usdt');
	return [...mapSpot(spot), ...fut.flatMap(mapFutures)];
}
