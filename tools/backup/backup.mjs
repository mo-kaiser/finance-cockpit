// Wöchentliche Datensicherung des Cockpits (läuft als GitHub-Action im privaten Backup-Repository).
// Holt alle Tabellen über /api/backup und schreibt je Tabelle eine gzip-komprimierte NDJSON-Datei nach ./data.
// Unveränderte Tabellen ergeben byte-gleiche Dateien → Git speichert sie nicht erneut.
//
// Umgebung: COCKPIT_URL (z. B. https://cockpit.moritz-kaiser.com), BACKUP_SECRET
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const base = (process.env.COCKPIT_URL || 'https://cockpit.moritz-kaiser.com').replace(/\/$/, '');
const secret = process.env.BACKUP_SECRET;
if (!secret) throw new Error('BACKUP_SECRET fehlt (Repository-Secret)');
const out = process.argv[2] || 'data';

async function get(query) {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(`${base}/api/backup${query}`, { headers: { authorization: `Bearer ${secret}` } });
			const text = await res.text();
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
			return JSON.parse(text);
		} catch (e) {
			if (attempt >= 3) throw new Error(`${query}: ${e.message}`);
			await new Promise((r) => setTimeout(r, 5000 * attempt));
		}
	}
}

function write(path, rows) {
	const file = join(out, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { level: 9 }));
}

const { tables } = await get('');
const manifest = { created_at: new Date().toISOString(), source: base, tables: {} };

for (const t of tables) {
	const rows = [];
	let offset = 0;
	let total;
	while (offset !== null) {
		const page = await get(`?table=${encodeURIComponent(t.name)}&offset=${offset}`);
		if (offset === 0) total = page.total;
		rows.push(...page.rows);
		offset = page.next;
	}
	if (total !== undefined && total !== rows.length) throw new Error(`${t.name}: ${rows.length} von ${total} Zeilen – Sicherung unvollständig`);

	if (t.splitByMonth) {
		const byMonth = new Map();
		for (const r of rows) {
			const m = String(r.ts).slice(0, 7);
			if (!byMonth.has(m)) byMonth.set(m, []);
			byMonth.get(m).push(r);
		}
		for (const [m, list] of byMonth) write(`${t.name}/${m}.ndjson.gz`, list);
	} else {
		write(`${t.name}.ndjson.gz`, rows);
	}
	manifest.tables[t.name] = rows.length;
	console.log(`${t.name}: ${rows.length} Zeilen`);
}

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
