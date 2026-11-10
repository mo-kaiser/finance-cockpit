import type Decimal from 'decimal.js';
import { CATEGORY_LABEL } from './types';
import type { TaxResult } from './engine';

/** Zahl im deutschen Excel-Format (Komma als Dezimaltrenner). */
const n = (d: Decimal | null, places = 2) => (d === null ? '' : d.toFixed(places).replace('.', ','));
const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function toCsv(header: string[], rows: string[][]) {
	return '﻿' + [header, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
}

export function kapCsv(r: TaxResult) {
	return toCsv(
		['Datum', 'Kategorie', 'Kommentar', 'Währung', 'Betrag', 'EUR', 'Anzahl Buchungen', 'Tx-ID'],
		r.kap.map((k) => [k.day, CATEGORY_LABEL[k.category], k.comment, k.currency, n(k.usd, 8), n(k.eur), String(k.n), k.txId])
	);
}

export function soCsv(r: TaxResult) {
	const rows: string[][] = [];
	for (const d of r.disposals) {
		for (const p of d.portions) {
			rows.push([
				d.day,
				d.asset,
				d.counter,
				n(p.qty, 8),
				p.acquiredDay ?? 'Fehlbestand',
				p.taxable === null ? 'unbekannt' : p.taxable ? 'ja' : 'nein',
				n(p.proceeds),
				n(p.cost),
				n(p.gain),
				d.status,
				d.txId
			]);
		}
	}
	return toCsv(
		['Veräußerung', 'Asset', 'Gegenwert in', 'Menge', 'Angeschafft', 'Innerhalb Haltefrist', 'Erlös EUR', 'Kosten EUR', 'Ergebnis EUR', 'Status', 'Tx-ID'],
		rows
	);
}

export function download(name: string, content: string) {
	const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}
