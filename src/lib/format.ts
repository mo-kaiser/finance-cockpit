import type Decimal from 'decimal.js';

export type Cur = 'USDT' | 'EUR';

/** Geldbetrag zur Anzeige (Rechnen bleibt in Decimal). */
export function money(d: Decimal | null | undefined, cur: Cur = 'EUR', opts: { sign?: boolean; digits?: number; unit?: boolean } = {}) {
	if (d === null || d === undefined) return '–';
	const n = d.toNumber();
	const digits = opts.digits ?? 2;
	const s = n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
	const sign = opts.sign && n > 0 ? '+' : '';
	if (opts.unit === false) return `${sign}${s}`;
	return cur === 'EUR' ? `${sign}${s} €` : `${sign}${s} USDT`;
}

export function qty(d: Decimal | null | undefined, digits = 8) {
	if (d === null || d === undefined) return '–';
	return d.toNumber().toLocaleString('de-DE', { maximumFractionDigits: digits });
}

export function pct(x: number | null | undefined, digits = 1) {
	if (x === null || x === undefined || !Number.isFinite(x)) return '–';
	return `${(x * 100).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

export function ratio(x: number | null | undefined, digits = 2) {
	if (x === null || x === undefined || !Number.isFinite(x)) return '–';
	return x.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function tone(d: Decimal | number | null | undefined) {
	if (d === null || d === undefined) return '';
	const n = typeof d === 'number' ? d : d.toNumber();
	return n > 0 ? 'gain' : n < 0 ? 'loss' : '';
}

export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export function dayLabel(day: string) {
	const d = new Date(`${day}T12:00:00Z`);
	return d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
