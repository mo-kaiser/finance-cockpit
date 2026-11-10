import Decimal from 'decimal.js';
import { classify } from '$lib/tax/classify';
import type { FxTable } from '$lib/tax/fx';
import type { LedgerEntry } from '$lib/tax/types';

export type Currency = 'USDT' | 'EUR';
export type EventKind = 'pnl' | 'fee' | 'funding' | 'other';

/** Eine Futures-Buchung (Ergebnis, Gebühr, Funding …) in USDT und EUR. */
export interface FuturesEvent {
	txId: string;
	ts: string;
	day: string; // Europe/Berlin
	hour: number; // Europe/Berlin
	weekday: number; // 0 = Montag
	kind: EventKind;
	dir: 'long' | 'short' | null;
	usdt: Decimal;
	eur: Decimal | null;
	comment: string;
}

const KIND: Record<string, EventKind> = { kap_pnl: 'pnl', kap_fee: 'fee', kap_funding: 'funding', kap_other: 'other' };

const berlin = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/Berlin',
	weekday: 'short',
	hour: '2-digit',
	hourCycle: 'h23'
});
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function hourAndWeekday(ts: string, day: string) {
	// CoinTracking-Zeiten ohne Zone sind bereits Europe/Berlin; Datenbank-Zeiten sind ISO mit Offset
	const hasZone = /[zZ]|[+-]\d{2}(:?\d{2})?$/.test(ts);
	if (!hasZone) {
		const hour = Number(ts.slice(11, 13));
		const d = new Date(`${day}T12:00:00Z`);
		return { hour, weekday: (d.getUTCDay() + 6) % 7 };
	}
	const parts = berlin.formatToParts(new Date(ts));
	const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
	const weekday = WD.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Mon');
	return { hour, weekday };
}

export function futuresEvents(ledger: LedgerEntry[], fx: FxTable): FuturesEvent[] {
	const out: FuturesEvent[] = [];
	for (const e of ledger) {
		const kind = KIND[classify(e)];
		if (!kind) continue;
		const usdt = new Decimal(e.buy_amount || 0).sub(e.sell_amount || 0);
		if (usdt.isZero()) continue;
		const c = (e.comment ?? '').toLowerCase();
		const dir = kind === 'pnl' ? (c.includes('long') ? 'long' : c.includes('short') ? 'short' : null) : null;
		const eurAbs = fx.usdToEur(usdt.abs(), e.day);
		out.push({
			txId: e.tx_id,
			ts: e.ts,
			day: e.day,
			...hourAndWeekday(e.ts, e.day),
			kind,
			dir,
			usdt,
			eur: eurAbs === null ? null : usdt.isNeg() ? eurAbs.neg() : eurAbs,
			comment: e.comment ?? ''
		});
	}
	return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

const ZERO = new Decimal(0);
const val = (e: FuturesEvent, cur: Currency) => (cur === 'USDT' ? e.usdt : (e.eur ?? ZERO));

export interface Bucket {
	net: Decimal;
	pnl: Decimal;
	fees: Decimal;
	funding: Decimal;
	other: Decimal;
	trades: number;
	wins: number;
	losses: number;
}

const emptyBucket = (): Bucket => ({ net: ZERO, pnl: ZERO, fees: ZERO, funding: ZERO, other: ZERO, trades: 0, wins: 0, losses: 0 });

function add(b: Bucket, e: FuturesEvent, cur: Currency) {
	const v = val(e, cur);
	b.net = b.net.add(v);
	if (e.kind === 'pnl') {
		b.pnl = b.pnl.add(v);
		b.trades++;
		if (e.usdt.gt(0)) b.wins++;
		else if (e.usdt.lt(0)) b.losses++;
	} else if (e.kind === 'fee') b.fees = b.fees.add(v);
	else if (e.kind === 'funding') b.funding = b.funding.add(v);
	else b.other = b.other.add(v);
}

export interface FuturesStats {
	total: Bucket;
	winPct: number | null;
	avgWin: Decimal | null;
	avgLoss: Decimal | null;
	grossWin: Decimal;
	grossLoss: Decimal;
	profitFactor: number | null;
	payoff: number | null;
	expectancy: Decimal | null; // netto je Trade (inkl. Gebühren und Funding)
	feeShare: number | null; // Gebühren im Verhältnis zum Brutto-Gewinn
	streakWin: number;
	streakLoss: number;
	maxDrawdown: Decimal; // auf Basis kumulierter Netto-Werte
	days: { total: number; win: number; loss: number };
	byDir: Record<'long' | 'short', { trades: number; wins: number; pnl: Decimal }>;
	byWeekday: Bucket[];
	byHour: Bucket[];
	byDay: Map<string, Bucket>;
	byMonth: Map<string, Bucket>;
	cumulative: { day: string; value: Decimal }[];
}

export function futuresStats(events: FuturesEvent[], cur: Currency): FuturesStats {
	const total = emptyBucket();
	const byWeekday = Array.from({ length: 7 }, emptyBucket);
	const byHour = Array.from({ length: 24 }, emptyBucket);
	const byDay = new Map<string, Bucket>();
	const byMonth = new Map<string, Bucket>();
	const byDir = { long: { trades: 0, wins: 0, pnl: ZERO }, short: { trades: 0, wins: 0, pnl: ZERO } };
	let grossWin = ZERO;
	let grossLoss = ZERO;
	let streakWin = 0;
	let streakLoss = 0;
	let curW = 0;
	let curL = 0;

	for (const e of events) {
		add(total, e, cur);
		const d = byDay.get(e.day) ?? emptyBucket();
		add(d, e, cur);
		byDay.set(e.day, d);
		const m = byMonth.get(e.day.slice(0, 7)) ?? emptyBucket();
		add(m, e, cur);
		byMonth.set(e.day.slice(0, 7), m);

		if (e.kind !== 'pnl') continue;
		add(byWeekday[e.weekday]!, e, cur);
		add(byHour[e.hour]!, e, cur);
		const v = val(e, cur);
		if (v.gt(0)) {
			grossWin = grossWin.add(v);
			curW++;
			curL = 0;
		} else if (v.lt(0)) {
			grossLoss = grossLoss.add(v);
			curL++;
			curW = 0;
		}
		streakWin = Math.max(streakWin, curW);
		streakLoss = Math.max(streakLoss, curL);
		if (e.dir) {
			byDir[e.dir].trades++;
			if (e.usdt.gt(0)) byDir[e.dir].wins++;
			byDir[e.dir].pnl = byDir[e.dir].pnl.add(v);
		}
	}

	// Kumulierte Netto-Kurve je Tag und maximaler Rückgang
	const cumulative: { day: string; value: Decimal }[] = [];
	let run = ZERO;
	let peak = ZERO;
	let maxDrawdown = ZERO;
	for (const day of [...byDay.keys()].sort()) {
		run = run.add(byDay.get(day)!.net);
		cumulative.push({ day, value: run });
		if (run.gt(peak)) peak = run;
		const dd = peak.sub(run);
		if (dd.gt(maxDrawdown)) maxDrawdown = dd;
	}

	// Handelstage: nur Tage mit geschlossenen Trades (reine Funding-Tage zählen nicht)
	const days = { total: 0, win: 0, loss: 0 };
	for (const b of byDay.values()) {
		if (!b.trades) continue;
		days.total++;
		if (b.net.gt(0)) days.win++;
		else if (b.net.lt(0)) days.loss++;
	}

	const decided = total.wins + total.losses;
	return {
		total,
		winPct: decided ? total.wins / decided : null,
		avgWin: total.wins ? grossWin.div(total.wins) : null,
		avgLoss: total.losses ? grossLoss.div(total.losses) : null,
		grossWin,
		grossLoss,
		profitFactor: grossLoss.isZero() ? null : grossWin.div(grossLoss.abs()).toNumber(),
		payoff: total.wins && total.losses ? grossWin.div(total.wins).div(grossLoss.abs().div(total.losses)).toNumber() : null,
		expectancy: total.trades ? total.net.div(total.trades) : null,
		feeShare: grossWin.isZero() ? null : total.fees.abs().div(grossWin).toNumber(),
		streakWin,
		streakLoss,
		maxDrawdown,
		days,
		byDir,
		byWeekday,
		byHour,
		byDay,
		byMonth,
		cumulative
	};
}

/** Ereignisse in einem Zeitraum (inklusive, YYYY-MM-DD). */
export const inRange = (events: FuturesEvent[], from: string, to: string) =>
	events.filter((e) => e.day >= from && e.day <= to);
