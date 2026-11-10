import Decimal from 'decimal.js';

export interface FxRow {
	rate_date: string; // YYYY-MM-DD
	rate: string | number; // US-Dollar je 1 Euro (EZB-Referenzkurs)
}

/**
 * EZB-Referenzkurse EUR/USD. An Tagen ohne Kurs (Wochenende, Feiertag) gilt der letzte
 * vorherige Referenzkurs.
 */
export class FxTable {
	private days: string[];
	private rates: Decimal[];

	constructor(rows: FxRow[]) {
		const sorted = [...rows].sort((a, b) => a.rate_date.localeCompare(b.rate_date));
		this.days = sorted.map((r) => r.rate_date);
		this.rates = sorted.map((r) => new Decimal(String(r.rate)));
	}

	get size() {
		return this.days.length;
	}
	get first() {
		return this.days[0] ?? null;
	}
	get last() {
		return this.days[this.days.length - 1] ?? null;
	}

	/** Kurs (USD je EUR) für einen Tag oder null, wenn davor keiner vorliegt. */
	rateFor(day: string): { rate: Decimal; rateDay: string } | null {
		let lo = 0;
		let hi = this.days.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.days[mid]! <= day) {
				found = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		if (found < 0) return null;
		return { rate: this.rates[found]!, rateDay: this.days[found]! };
	}

	/** US-Dollar-Betrag in Euro, oder null ohne Kurs. */
	usdToEur(usd: Decimal, day: string): Decimal | null {
		const r = this.rateFor(day);
		return r ? usd.div(r.rate) : null;
	}
}

/** Liest die CSV-Antwort der EZB-Daten-API (format=csvdata) robust über die Spaltennamen. */
export function parseEcbCsv(text: string): FxRow[] {
	const lines = text.trim().split(/\r?\n/);
	const header = (lines.shift() ?? '').split(',');
	const iDate = header.indexOf('TIME_PERIOD');
	const iValue = header.indexOf('OBS_VALUE');
	if (iDate < 0 || iValue < 0) throw new Error('EZB-Antwort hat ein unbekanntes Format.');
	const rows: FxRow[] = [];
	for (const line of lines) {
		const c = line.split(',');
		const d = c[iDate];
		const v = c[iValue];
		if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && v && /^\d+(\.\d+)?$/.test(v)) {
			rows.push({ rate_date: d, rate: v });
		}
	}
	return rows;
}
