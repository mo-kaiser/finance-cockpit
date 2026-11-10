<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

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

	async function syncAll() {
		syncing = true;
		syncLog = [];
		const startMs = new Date(`${syncFrom}T00:00:00Z`).getTime();
		const endMs = Date.now();
		for (const ep of data.endpoints) {
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
			syncLog = [...syncLog, `${ep.label}: ${received} abgerufen, ${stored} neu gespeichert${err ? ` – abgebrochen bei ${err}` : ''}`];
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

<style>
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
	.ok {
		color: var(--gain);
	}
	.small {
		font-size: 0.85rem;
		font-weight: 400;
	}
</style>
