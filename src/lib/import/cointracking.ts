import Papa from 'papaparse';

/** Exakte Kopfzeile des CoinTracking-Exports „Trade Table“ (Spalten werden positionsbasiert gelesen). */
export const CT_HEADER = [
	'Type',
	'Buy',
	'Cur.',
	'Sell',
	'Cur.',
	'Fee',
	'Cur.',
	'Exchange',
	'Group',
	'Comment',
	'Date',
	'LPN',
	'Tx-ID'
] as const;

/** Eine Zeile so, wie sie in ct_rows landet. Beträge bleiben Dezimalstrings (kein float). */
export interface CtRow {
	tx_id: string;
	type: string;
	buy_amount: string | null;
	buy_cur: string | null;
	sell_amount: string | null;
	sell_cur: string | null;
	fee_amount: string | null;
	fee_cur: string | null;
	exchange: string;
	trade_group: string | null;
	comment: string | null;
	date_raw: string;
	lpn: string | null;
}

export interface ParseResult {
	rows: CtRow[];
	errors: string[];
}

const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const orNull = (v: string | undefined) => {
	const t = (v ?? '').trim();
	return t === '' ? null : t;
};

export function parseCoinTrackingCsv(text: string): ParseResult {
	const errors: string[] = [];
	const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true });

	for (const e of parsed.errors.slice(0, 10)) errors.push(`CSV Zeile ${(e.row ?? 0) + 1}: ${e.message}`);

	const [header, ...data] = parsed.data;
	if (!header || header.length !== CT_HEADER.length || header.some((h, i) => h.trim() !== CT_HEADER[i])) {
		errors.push('Kopfzeile passt nicht zum CoinTracking-„Trade Table“-Export.');
		return { rows: [], errors };
	}

	const rows: CtRow[] = [];
	const seen = new Set<string>();

	data.forEach((c, idx) => {
		const line = idx + 2;
		if (c.length !== CT_HEADER.length) {
			errors.push(`Zeile ${line}: ${c.length} statt ${CT_HEADER.length} Spalten`);
			return;
		}
		const row: CtRow = {
			type: c[0]!.trim(),
			buy_amount: orNull(c[1]),
			buy_cur: orNull(c[2]),
			sell_amount: orNull(c[3]),
			sell_cur: orNull(c[4]),
			fee_amount: orNull(c[5]),
			fee_cur: orNull(c[6]),
			exchange: c[7]!.trim(),
			trade_group: orNull(c[8]),
			comment: orNull(c[9]),
			date_raw: c[10]!.trim(),
			lpn: orNull(c[11]),
			tx_id: c[12]!.trim()
		};

		for (const k of ['buy_amount', 'sell_amount', 'fee_amount'] as const) {
			const v = row[k];
			if (v !== null && !DECIMAL.test(v)) errors.push(`Zeile ${line}: ${k} „${v}“ ist keine Zahl`);
		}
		if (!DATE.test(row.date_raw)) errors.push(`Zeile ${line}: Datum „${row.date_raw}“ unbekanntes Format`);
		if (!row.tx_id) errors.push(`Zeile ${line}: Tx-ID fehlt`);
		else if (seen.has(row.tx_id)) errors.push(`Zeile ${line}: Tx-ID ${row.tx_id} doppelt`);
		if (!row.exchange) errors.push(`Zeile ${line}: Exchange fehlt`);

		seen.add(row.tx_id);
		rows.push(row);
	});

	return { rows, errors: errors.slice(0, 50) };
}

export interface CtSummary {
	total: number;
	first: string;
	last: string;
	byExchange: { exchange: string; n: number; first: string; last: string }[];
}

/** Kurzübersicht für die Vorschau vor dem Import (Datumsstrings sind ISO-artig, also lexikografisch sortierbar). */
export function summarize(rows: CtRow[]): CtSummary {
	const map = new Map<string, { n: number; first: string; last: string }>();
	let first = '9999';
	let last = '0000';
	for (const r of rows) {
		const d = r.date_raw;
		if (d < first) first = d;
		if (d > last) last = d;
		const e = map.get(r.exchange);
		if (!e) map.set(r.exchange, { n: 1, first: d, last: d });
		else {
			e.n++;
			if (d < e.first) e.first = d;
			if (d > e.last) e.last = d;
		}
	}
	return {
		total: rows.length,
		first,
		last,
		byExchange: [...map.entries()]
			.map(([exchange, v]) => ({ exchange, ...v }))
			.sort((a, b) => b.n - a.n)
	};
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
