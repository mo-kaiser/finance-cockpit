<script lang="ts">
	import { enhance } from '$app/forms';
	import { ago, assessSync, berlin } from '$lib/monitor/health';

	let { data, form } = $props();

	const sync = $derived(assessSync(data.syncRuns));

	/** Kurzfassung der Lauf-Notiz (JSON mit Ergebnis je Schnittstelle) */
	function runSummary(note: string | null): string {
		if (!note) return '';
		try {
			const o = JSON.parse(note) as Record<string, { received?: number; stored?: number; error?: string } | string>;
			return Object.entries(o)
				.map(([k, v]) => (typeof v === 'string' ? `${k}: ${v}` : v.error ? `${k}: ${v.error}` : `${k} ${v.stored ?? 0} neu`))
				.join(' · ');
		} catch {
			return note;
		}
	}
	// Datensicherung als Download: alle Tabellen seitenweise, eine gzip-komprimierte NDJSON-Datei
	let backupBusy = $state(false);
	let backupMsg = $state('');
	let backupErr = $state('');
	async function downloadBackup() {
		backupBusy = true;
		backupMsg = '';
		backupErr = '';
		try {
			const get = async (q: string) => {
				const res = await fetch(`/api/backup${q}`);
				const body = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
				return body;
			};
			const { tables } = (await get('')) as { tables: { name: string }[] };
			const lines: string[] = [JSON.stringify({ backup: 'finance-cockpit', version: 1, created_at: new Date().toISOString() })];
			const counts: string[] = [];
			for (const t of tables) {
				let offset: number | null = 0;
				let n = 0;
				let total: number | undefined;
				while (offset !== null) {
					backupMsg = `${t.name}: ${n.toLocaleString('de-DE')} Zeilen …`;
					const page = (await get(`?table=${t.name}&offset=${offset}`)) as { rows: unknown[]; next: number | null; total?: number };
					if (offset === 0) total = page.total;
					for (const row of page.rows) lines.push(JSON.stringify({ table: t.name, row }));
					n += page.rows.length;
					offset = page.next;
				}
				if (total !== undefined && total !== n) throw new Error(`${t.name}: ${n} von ${total} Zeilen gelesen – Sicherung unvollständig`);
				counts.push(`${t.name} ${n.toLocaleString('de-DE')}`);
			}
			const gz = new Blob([lines.join('\n') + '\n']).stream().pipeThrough(new CompressionStream('gzip'));
			const blob = await new Response(gz).blob();
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = `cockpit-backup-${new Date().toISOString().slice(0, 10)}.ndjson.gz`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
			backupMsg = `Fertig (${(blob.size / 1e6).toFixed(1)} MB): ${counts.join(' · ')}`;
		} catch (e) {
			backupErr = (e as Error).message;
			backupMsg = '';
		}
		backupBusy = false;
	}

	const STATUS: Record<string, string> = { done: 'erfolgreich', failed: 'fehlgeschlagen', running: 'läuft' };

	interface ProbeResult {
		key: string;
		label: string;
		windowDays: number;
		results: { from: string; to: string; count: number | null; error?: string }[];
		sample: unknown;
		ctMatches: { checked: number; matched: number; examples: string[] } | null;
	}

	let probes = $state<Record<string, ProbeResult | { error: string }>>({});
	let probing = $state<string | null>(null);

	async function probe(key: string) {
		probing = key;
		try {
			const res = await fetch('/api/bitget/probe', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key })
			});
			const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
			probes[key] = res.ok ? body : { error: body.message ?? `HTTP ${res.status}` };
		} catch (e) {
			probes[key] = { error: (e as Error).message };
		}
		probing = null;
	}

	async function probeAll() {
		for (const ep of data.endpoints) await probe(ep.key);
	}

	const reach = (p: ProbeResult) => {
		const withData = p.results.filter((r) => r.count);
		return withData.length ? withData[withData.length - 1]!.from : null;
	};

	// Nachladen: alle Fenster einer Schnittstelle seit einem Datum
	let syncFrom = $state('2026-01-01');
	let syncLog = $state<string[]>([]);
	let syncing = $state(false);

	interface InvGroup {
		endpoint: string;
		group: string | null;
		kind: string;
		n: number;
		afterCt: number;
		first: string;
		last: string;
		sample: unknown;
	}
	let inventory = $state<{ total: number; ctEnd: string | null; groups: InvGroup[] } | null>(null);
	let invError = $state('');
	let invBusy = $state(false);

	async function loadInventory() {
		invBusy = true;
		invError = '';
		const res = await fetch('/api/bitget/inventory');
		const body = await res.json().catch(() => ({}));
		if (res.ok) inventory = body;
		else invError = body.message ?? `HTTP ${res.status}`;
		invBusy = false;
	}

	/** Kompakte Textfassung zum Kopieren in den Chat (ohne Adressen). */
	const inventoryText = $derived.by(() => {
		if (!inventory) return '';
		const strip = (o: unknown) => {
			if (!o || typeof o !== 'object') return o;
			const c = { ...(o as Record<string, unknown>) };
			for (const k of ['toAddress', 'fromAddress', 'tradeId', 'tag']) if (k in c) c[k] = '…';
			return c;
		};
		return inventory.groups
			.map((g) => `${g.endpoint} | ${g.group ?? ''} | ${g.kind} | n=${g.n} | nach CT=${g.afterCt} | ${g.first.slice(0, 10)}–${g.last.slice(0, 10)}\n  ${JSON.stringify(strip(g.sample))}`)
			.join('\n');
	});

	let liveRaw = $state('');
	let liveBusy = $state(false);
	async function loadLiveRaw() {
		liveBusy = true;
		const res = await fetch('/api/bitget/live');
		const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
		// Kurse weglassen (sehr lang), Rest vollständig
		if (body.tickers?.ok) body.tickers = { ok: true, data: `${Object.keys(body.tickers.data).length} Kurse` };
		liveRaw = JSON.stringify(body, null, 2);
		liveBusy = false;
	}

	async function syncAll() {
		syncing = true;
		syncLog = [];
		const endMs = Date.now();
		for (const ep of data.endpoints) {
			// jede Schnittstelle nur so weit zurück, wie Bitget sie liefert
			const startMs = Math.max(new Date(`${syncFrom}T00:00:00Z`).getTime(), endMs - ep.maxDays * 86_400_000 + 60_000);
			let received = 0;
			let stored = 0;
			let err = '';
			const step = ep.windowDays * 86_400_000;
			for (let e = endMs; e > startMs; e -= step) {
				const s = Math.max(startMs, e - step);
				const res = await fetch('/api/bitget/sync', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ key: ep.key, start: s, end: e })
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) {
					err = `${new Date(s).toISOString().slice(0, 10)}: ${body.message ?? res.status}`;
					break;
				}
				received += body.received;
				stored += body.stored;
			}
			const from = new Date(startMs).toISOString().slice(0, 10);
			syncLog = [...syncLog, `${ep.label} (ab ${from}): ${received} abgerufen, ${stored} neu gespeichert${err ? ` – abgebrochen bei ${err}` : ''}`];
		}
		syncing = false;
	}
</script>

<h1>System</h1>

<div class="card">
	<h2 style="margin-top:0">Umgebungsvariablen <span class="muted small">({data.vercelEnv})</span></h2>
	<p class="muted small">Angezeigt wird nur, ob ein Wert ankommt und wie lang er ist – nie der Wert selbst.</p>
	<div class="table-wrap">
		<table>
			<thead><tr><th>Variable</th><th>Status</th><th class="num">Länge</th><th>Hinweis</th></tr></thead>
			<tbody>
				{#each data.vars as v (v.name)}
					<tr>
						<td><code>{v.name}</code></td>
						<td class={v.present ? 'ok' : 'error'}>{v.present ? 'vorhanden' : 'fehlt'}</td>
						<td class="num">{v.present ? v.length : ''}</td>
						<td class="error">
							{v.whitespace ? 'Leerzeichen am Anfang/Ende ' : ''}{v.quoted ? 'in Anführungszeichen' : ''}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="muted small">
		Nach Änderungen in Vercel ist ein Redeploy nötig, bevor neue Werte hier ankommen.
	</p>
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Täglicher Abruf</h2>
	<p class="sync-{sync.level}">
		Zuletzt erfolgreich: <strong>{berlin(sync.lastSuccess)}</strong> ({ago(sync.lastSuccess)})
	</p>
	{#each sync.problems as p (p)}<p class="error small">{p}</p>{/each}
	{#if data.syncRunsError}<p class="error small">{data.syncRunsError}</p>{/if}
	<p class="muted small">
		Abruf täglich um 04:17 UTC (nur Production). Schlägt ein Lauf fehl, kommt sofort eine E-Mail; ein Wächter prüft
		zusätzlich jeden Nachmittag, ob seit über 2 Tagen kein Lauf erfolgreich war.
	</p>
	<form method="POST" action="?/testmail" use:enhance>
		<button type="submit">Test-E-Mail senden</button>
	</form>
	{#if form?.testmail}
		<p class={form.testmail.ok ? 'ok' : 'error'}>
			{form.testmail.ok ? 'Test-E-Mail wurde an Resend übergeben – bitte Postfach (auch Spam) prüfen.' : `E-Mail fehlgeschlagen: ${form.testmail.error}`}
		</p>
	{/if}
	{#if data.syncRuns.length}
		<details>
			<summary><span>Letzte {data.syncRuns.length} Läufe</span></summary>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Start</th><th>Status</th><th>Ergebnis</th></tr></thead>
					<tbody>
						{#each data.syncRuns as r (r.id)}
							<tr>
								<td class="small">{berlin(r.created_at)}</td>
								<td class={r.status === 'done' ? 'ok' : r.status === 'failed' ? 'error' : ''}>{STATUS[r.status] ?? r.status}</td>
								<td class="small">{runSummary(r.note)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Datensicherung</h2>
	<p class="muted small">
		Lädt alle Rohdaten (CoinTracking-Import, Bitget-API, Korrekturen, Snapshots, Kurse) als eine komprimierte Datei
		herunter. Beträge exakt als Text. Zusätzlich sichert eine GitHub-Action jede Woche in ein privates Repository.
	</p>
	<p><button onclick={downloadBackup} disabled={backupBusy}>{backupBusy ? 'Sichere …' : 'Sicherung herunterladen'}</button></p>
	{#if backupMsg}<p class="small">{backupMsg}</p>{/if}
	{#if backupErr}<p class="error">{backupErr}</p>{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Verbindungstests</h2>

	<form method="POST" action="?/bitget" use:enhance>
		<button type="submit">Bitget-Key testen</button>
	</form>
	{#if form?.bitget}
		{#if form.bitget.ok}
			<p class="ok">Verbindung zu Bitget erfolgreich.</p>
			<p>Rechte des Keys: <code>{form.bitget.authorities?.join(', ') || '–'}</code></p>
			{#if form.bitget.risky?.length}
				<p class="error">
					Achtung: Der Key hat mehr als Leserechte ({form.bitget.risky.join(', ')}). Bitte in Bitget auf „nur
					Lesen“ beschränken.
				</p>
			{/if}
		{:else}
			<p class="error">Bitget: {form.bitget.error}</p>
		{/if}
	{/if}

	<form method="POST" action="?/supabase" use:enhance style="margin-top:16px">
		<button type="submit">Supabase Secret Key testen</button>
	</form>
	{#if form?.supabase}
		{#if form.supabase.ok}
			<p class="ok">Secret Key funktioniert ({form.supabase.imports} Importe sichtbar).</p>
		{:else}
			<p class="error">Supabase: {form.supabase.error}</p>
		{/if}
	{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Bitget-Schnittstellen: Reichweite</h2>
	<p class="muted small">
		Fragt jede Schnittstelle Monat für Monat rückwärts ab und zeigt, bis wann Daten kommen. Es wird nichts gespeichert.
	</p>
	<p><button onclick={probeAll} disabled={probing !== null}>{probing ? 'Prüfe …' : 'Alle prüfen'}</button></p>

	{#each data.endpoints as ep (ep.key)}
		{@const p = probes[ep.key]}
		<details open={!!p}>
			<summary>
				<strong>{ep.label}</strong>
				<span class="muted small">
					{#if probing === ep.key}prüfe …
					{:else if p && 'error' in p}<span class="error">{p.error}</span>
					{:else if p}Daten ab {reach(p) ?? '– (keine)'}
					{/if}
				</span>
			</summary>
			{#if p && !('error' in p)}
				<div class="table-wrap">
					<table>
						<thead><tr><th>Zeitraum</th><th class="num">Treffer (1. Seite)</th><th>Fehler</th></tr></thead>
						<tbody>
							{#each p.results as r (r.from)}
								<tr>
									<td>{r.from} – {r.to}</td>
									<td class="num">{r.count ?? ''}</td>
									<td class="error small">{r.error ?? ''}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if p.ctMatches}
					<p class="small">
						Abgleich mit CoinTracking: {p.ctMatches.matched} von {p.ctMatches.checked} Bitget-IDs gefunden
						{#if p.ctMatches.examples.length}(z. B. <code>{p.ctMatches.examples.join(', ')}</code>){/if}
					</p>
				{/if}
				{#if p.sample}
					<p class="small muted">Beispielbuchung:</p>
					<pre>{JSON.stringify(p.sample, null, 2)}</pre>
				{/if}
			{/if}
		</details>
	{/each}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Bitget-Daten nachladen</h2>
	<p class="muted small">
		Lädt alle Schnittstellen ab dem Datum und speichert die Rohdaten unverändert. Bereits vorhandene Datensätze werden
		übersprungen. Der tägliche Abruf läuft später automatisch (nur auf Production).
	</p>
	<label for="from">Ab</label>
	<input id="from" type="date" bind:value={syncFrom} style="max-width:200px" disabled={syncing} />
	<p><button onclick={syncAll} disabled={syncing}>{syncing ? 'Lade …' : 'Nachladen'}</button></p>
	{#each syncLog as l, i (i)}<p class="small">{l}</p>{/each}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Bitget-Bestände (Rohdaten)</h2>
	<p class="muted small">Zeigt die Antwort der Live-Abfrage, die das Dashboard nutzt – zur Fehlersuche bei abweichenden Beständen.</p>
	<p><button onclick={loadLiveRaw} disabled={liveBusy}>{liveBusy ? 'Lade …' : 'Rohdaten anzeigen'}</button></p>
	{#if liveRaw}<textarea readonly rows="16" onfocus={(e) => e.currentTarget.select()}>{liveRaw}</textarea>{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Buchungsarten in den Bitget-Daten</h2>
	<p class="muted small">Gruppiert die gespeicherten Rohdaten nach Buchungsart, mit Anzahl und einem Beispiel.</p>
	<p><button onclick={loadInventory} disabled={invBusy}>{invBusy ? 'Lade …' : 'Inventur anzeigen'}</button></p>
	{#if invError}<p class="error">{invError}</p>{/if}
	{#if inventory}
		<p class="small">
			{inventory.total.toLocaleString('de-DE')} Datensätze · CoinTracking-Export endet {inventory.ctEnd?.slice(0, 16) ?? '–'}
		</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Schnittstelle</th><th>Gruppe</th><th>Art</th><th class="num">Anzahl</th><th class="num">nach CT-Export</th><th>Zeitraum</th></tr></thead>
				<tbody>
					{#each inventory.groups as g (g.endpoint + g.group + g.kind)}
						<tr>
							<td>{g.endpoint}</td>
							<td>{g.group ?? ''}</td>
							<td><code>{g.kind}</code></td>
							<td class="num">{g.n.toLocaleString('de-DE')}</td>
							<td class="num">{g.afterCt.toLocaleString('de-DE')}</td>
							<td class="small">{g.first.slice(0, 10)} – {g.last.slice(0, 10)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="small muted">Zum Kopieren in den Chat (Adressen ausgeblendet):</p>
		<textarea readonly rows="12" onfocus={(e) => e.currentTarget.select()}>{inventoryText}</textarea>
	{/if}
</div>

<style>
	textarea {
		width: 100%;
		font: 0.8rem/1.4 var(--mono);
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px;
	}
	pre {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px;
		font-size: 0.8rem;
		overflow-x: auto;
		max-height: 320px;
	}
	details {
		border-top: 1px solid var(--border);
		padding: 8px 0;
	}
	details summary {
		cursor: pointer;
		display: flex;
		gap: 12px;
		align-items: baseline;
		flex-wrap: wrap;
	}
	.ok,
	.sync-ok strong {
		color: var(--gain);
	}
	.sync-error strong {
		color: var(--loss);
	}
	.small {
		font-size: 0.85rem;
		font-weight: 400;
	}
</style>
