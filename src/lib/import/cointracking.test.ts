import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCoinTrackingCsv, summarize } from './cointracking';

const HEADER = '"Type","Buy","Cur.","Sell","Cur.","Fee","Cur.","Exchange","Group","Comment","Date","LPN","Tx-ID"';

describe('parseCoinTrackingCsv', () => {
	it('liest eine Zeile exakt und ohne float-Rundung', () => {
		const csv = `${HEADER}\n"Trade","0.00119880","BTC","107.64000000","USDT","0.00000120","BTC","Bitget Spot","","Sell","2026-01-20 18:41:43","","1"`;
		const { rows, errors } = parseCoinTrackingCsv(csv);
		expect(errors).toEqual([]);
		expect(rows[0]).toMatchObject({
			type: 'Trade',
			buy_amount: '0.00119880',
			sell_amount: '107.64000000',
			fee_amount: '0.00000120',
			exchange: 'Bitget Spot',
			trade_group: null,
			date_raw: '2026-01-20 18:41:43',
			tx_id: '1'
		});
	});

	it('meldet falsche Kopfzeile', () => {
		expect(parseCoinTrackingCsv('a,b,c\n1,2,3').errors[0]).toMatch(/Kopfzeile/);
	});

	it('meldet doppelte Tx-IDs und kaputte Zahlen', () => {
		const r = `"Trade","1,5","BTC","","","","","Bitget Spot","","","2026-01-01 00:00:00","","x"`;
		const { errors } = parseCoinTrackingCsv(`${HEADER}\n${r}\n${r}`);
		expect(errors.some((e) => e.includes('keine Zahl'))).toBe(true);
		expect(errors.some((e) => e.includes('doppelt'))).toBe(true);
	});

	// Gegen den echten Export: CT_CSV=/pfad/zur/datei.csv npm test
	const path = process.env.CT_CSV;
	it.runIf(path && existsSync(path))('liest den echten Export fehlerfrei', () => {
		const { rows, errors } = parseCoinTrackingCsv(readFileSync(path!, 'utf8'));
		expect(errors).toEqual([]);
		const s = summarize(rows);
		console.log(s.total, s.first, s.last, s.byExchange);
		expect(rows.length).toBeGreaterThan(90_000);
	});
});
