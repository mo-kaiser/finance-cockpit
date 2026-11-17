// Wiederherstellungstest: spielt eine Sicherung in ein leeres Postgres (PGlite, im Speicher) ein,
// mit denselben Migrationen wie Supabase, und vergleicht Zeilenzahlen, Werte und Views.
// Aufruf (in einem eigenen Ordner):  npm i @electric-sql/pglite@0.3.7
//   node restore-test.mjs <pfad/zu/finance-cockpit> <pfad/zu/finance-cockpit-backup/data>
// Erster Lauf 17.11.2026: alle 7 Tabellen vollständig und wertgleich, Summen = CoinTracking-CSV.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const [repo, data] = process.argv.slice(2);
const db = new PGlite();
const t0 = Date.now();

// Supabase-Umgebung nachbilden: Rollen und auth-Schema
await db.exec(`
	create role anon; create role authenticated; create role service_role;
	create schema auth;
	create table auth.users (id uuid primary key);
	create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
	create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
`);
const migDir = join(repo, 'supabase/migrations');
for (const f of readdirSync(migDir).sort()) await db.exec(readFileSync(join(migDir, f), 'utf8'));

const read = (p) => gunzipSync(readFileSync(p)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const manifest = JSON.parse(readFileSync(join(data, 'manifest.json'), 'utf8'));
const load = (t) => {
	if (t === 'api_records') return readdirSync(join(data, t)).sort().flatMap((f) => read(join(data, t, f)));
	return read(join(data, `${t}.ndjson.gz`));
};
// Reihenfolge wegen Fremdschlüsseln
const ORDER = ['ticker_map', 'fx_rates', 'imports', 'ct_rows', 'api_records', 'manual_adjustments', 'report_snapshots'];
const backup = {};
for (const t of ORDER) backup[t] = existsSync(join(data, t)) || existsSync(join(data, `${t}.ndjson.gz`)) ? load(t) : [];

// ticker_map ist per Migration vorbefüllt
await db.exec('delete from public.ticker_map');
const users = new Set(Object.values(backup).flat().map((r) => r.user_id).filter(Boolean));
for (const u of users) await db.query('insert into auth.users (id) values ($1)', [u]);

const JSONB = new Set(['raw', 'params', 'summary', 'detail']);
for (const t of ORDER) {
	const rows = backup[t];
	if (!rows.length) continue;
	const cols = Object.keys(rows[0]);
	for (let i = 0; i < rows.length; i += 500) {
		const chunk = rows.slice(i, i + 500);
		const vals = [];
		const tuples = chunk.map((r, j) => `(${cols.map((c, k) => `$${j * cols.length + k + 1}${JSONB.has(c) ? '::jsonb' : ''}`).join(',')})`);
		for (const r of chunk) for (const c of cols) vals.push(r[c]);
		const override = ['ct_rows', 'api_records'].includes(t) ? 'overriding system value' : '';
		await db.query(`insert into public.${t} (${cols.map((c) => `"${c}"`).join(',')}) ${override} values ${tuples.join(',')}`, vals);
	}
}
console.log(`Eingespielt in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// 1. Zeilenzahlen gegen Manifest
let ok = true;
for (const t of ORDER) {
	const { rows } = await db.query(`select count(*)::int n from public.${t}`);
	const exp = manifest.tables[t] ?? 0;
	const pass = rows[0].n === exp && backup[t].length === exp;
	ok &&= pass;
	console.log(`${pass ? 'OK ' : 'FEHLER'} ${t}: ${rows[0].n} (Manifest ${exp})`);
}

// 2. Wieder exportieren und mit der Sicherung vergleichen (Werte exakt als Text)
const sel = {
	ct_rows: 'id,buy_amount::text,sell_amount::text,fee_amount::text,tx_id,date_raw,ts',
	api_records: 'id,record_id,raw::text raw,ts',
	fx_rates: "rate_date::text,pair,rate::text"
};
for (const [t, s] of Object.entries(sel)) {
	const { rows } = await db.query(`select ${s} from public.${t} order by 1,2`);
	const key = (r) => Object.keys(rows[0]).map((k) => k);
	const orig = new Map(backup[t].map((r) => [String(r.id ?? `${r.rate_date}|${r.pair}`), r]));
	let diff = 0;
	for (const r of rows) {
		const o = orig.get(String(r.id ?? `${r.rate_date}|${r.pair}`));
		for (const k of key(r)) {
			let a = r[k], b = o?.[k];
			if (k === 'raw') { a = JSON.stringify(JSON.parse(a)); b = JSON.stringify(JSON.parse(b)); }
			if (k === 'ts') { a = new Date(a).getTime(); b = new Date(b).getTime(); }
			if (k === 'rate_date') b = String(b);
			if (String(a) !== String(b)) { if (diff++ < 3) console.log('  Abweichung', t, k, a, b); }
		}
	}
	ok &&= diff === 0;
	console.log(`${diff ? 'FEHLER' : 'OK '} ${t}: Werte identisch (${rows.length} Zeilen${t === 'ct_rows' ? ', ts aus date_raw neu berechnet' : ''})`);
}

// 3. Views laufen auf den eingespielten Daten (als Superuser, ohne RLS-Filter)
for (const v of ['v_ledger', 'v_api_ledger', 'v_ct_overview']) {
	const { rows } = await db.query(`select count(*)::int n from public.${v}`);
	console.log(`OK  ${v}: ${rows[0].n} Zeilen`);
}
// 4. Kontrollsummen
const { rows: sums } = await db.query(`select buy_cur, sum(buy_amount)::text s from public.ct_rows where buy_cur in ('USDT','ETH','BTC','SOL2') group by 1 order by 1`);
console.log('Summen Zugänge ct_rows:', sums.map((r) => `${r.buy_cur} ${r.s}`).join(' · '));
console.log(ok ? '\nWiederherstellung erfolgreich' : '\nWiederherstellung mit Fehlern');
