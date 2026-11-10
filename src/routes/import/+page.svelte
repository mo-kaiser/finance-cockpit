<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import {
		parseCoinTrackingCsv,
		sha256Hex,
		summarize,
		type CtRow,
		type CtSummary
	} from '$lib/import/cointracking';

	let { data } = $props();

	const BATCH = 1000;

	let file = $state<File | null>(null);
	let rows = $state<CtRow[]>([]);
	let summary = $state<CtSummary | null>(null);
	let hash = $state('');
	let errors = $state<string[]>([]);
	let timezone = $state('Europe/Berlin');
	let progress = $state(0);
	let status = $state<'idle' | 'parsed' | 'running' | 'done' | 'failed'>('idle');
	let message = $state('');

	async function onFile(e: Event) {
		const f = (e.currentTarget as HTMLInputElement).files?.[0];
		status = 'idle';
		message = '';
		rows = [];
		summary = null;
		if (!f) return;
		file = f;
		const buf = await f.arrayBuffer();
		hash = await sha256Hex(buf);
		const parsed = parseCoinTrackingCsv(new TextDecoder('utf-8').decode(buf));
		errors = parsed.errors;
		rows = parsed.rows;
		summary = summarize(rows);
		status = errors.length ? 'idle' : 'parsed';
	}

	async function runImport() {
		if (!file || !rows.length) return;
		status = 'running';
		progress = 0;
		message = '';

		// Gleiche Datei schon einmal importiert? Dann fortsetzen oder abbrechen.
		const { data: existing, error: selErr } = await data.supabase
			.from('imports')
			.select('id, status')
			.eq('file_sha256', hash)
			.maybeSingle();
		if (selErr) return fail(selErr.message);
		if (existing?.status === 'done') {
			status = 'done';
			message = 'Diese Datei wurde bereits vollständig importiert.';
			return;
		}

		let importId = existing?.id as string | undefined;
		if (!importId) {
			const { data: created, error } = await data.supabase
				.from('imports')
				.insert({
					source: 'cointracking_csv',
					file_name: file.name,
					file_sha256: hash,
					source_timezone: timezone,
					row_count: rows.length
				})
				.select('id')
				.single();
			if (error) return fail(error.message);
			importId = created.id as string;
		}

		for (let i = 0; i < rows.length; i += BATCH) {
			const chunk = rows.slice(i, i + BATCH).map((r) => ({ ...r, import_id: importId }));
			// Bereits vorhandene Tx-IDs (aus älteren Exporten) werden übersprungen, nie überschrieben.
			const { error } = await data.supabase
				.from('ct_rows')
				.upsert(chunk, { onConflict: 'user_id,tx_id', ignoreDuplicates: true });
			if (error) {
				await data.supabase.from('imports').update({ status: 'failed', note: error.message }).eq('id', importId);
				return fail(`Batch ab Zeile ${i + 2}: ${error.message}`);
			}
			progress = Math.min(rows.length, i + BATCH) / rows.length;
		}

		await data.supabase
			.from('imports')
			.update({ status: 'done', finished_at: new Date().toISOString() })
			.eq('id', importId);
		status = 'done';
		message = `${rows.length.toLocaleString('de-DE')} Zeilen verarbeitet. Bereits vorhandene Tx-IDs wurden übersprungen.`;
		await invalidateAll();
	}

	function fail(msg: string) {
		status = 'failed';
		message = msg;
	}


	const fmtDate = (iso: string | null) =>
		iso ? new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : '–';

	// Börse × Jahr, Zeilen summiert über alle Typen
	const byVenueYear = $derived.by(() => {
		const years = [...new Set(data.overview.map((r) => r.year))].sort();
		const venues = new Map<string, Map<number, number>>();
		for (const r of data.overview) {
			const v = venues.get(r.exchange) ?? new Map<number, number>();
			v.set(r.year, (v.get(r.year) ?? 0) + r.n);
			venues.set(r.exchange, v);
		}
		return { years, rows: [...venues.entries()].sort(([a], [b]) => a.localeCompare(b)) };
	});

	const current = $derived(
		data.overview
			.filter((r) => r.venue === 'bitget' && r.year === 2026)
			.sort((a, b) => b.n - a.n)
	);
</script>

<h1>Import</h1>

<div class="card">
	<h2 style="margin-top:0">CoinTracking „Trade Table“ (CSV)</h2>
	<p class="muted">
		Die Datei wird im Browser gelesen und zeilenweise unverändert gespeichert. Ein erneuter Import
		eines neueren Exports ergänzt nur neue Tx-IDs.
	</p>

	<label for="file">Datei</label>
	<input id="file" type="file" accept=".csv,text/csv" onchange={onFile} disabled={status === 'running'} />

	<label for="tz">Zeitzone der Datumsangaben in der Datei</label>
	<select id="tz" bind:value={timezone} disabled={status === 'running'}>
		<option value="Europe/Berlin">Europe/Berlin</option>
		<option value="UTC">UTC</option>
	</select>

	{#if errors.length}
		<h2>Fehler in der Datei</h2>
		<ul class="error">
			{#each errors as e, i (i)}<li>{e}</li>{/each}
		</ul>
	{/if}

	{#if summary}
		<h2>Vorschau</h2>
		<p>
			{summary.total.toLocaleString('de-DE')} Zeilen, {summary.first} bis {summary.last}
		</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Exchange</th><th class="num">Zeilen</th><th>Von</th><th>Bis</th></tr></thead>
				<tbody>
					{#each summary.byExchange as e (e.exchange)}
						<tr>
							<td>{e.exchange}</td>
							<td class="num">{e.n.toLocaleString('de-DE')}</td>
							<td>{e.first.slice(0, 10)}</td>
							<td>{e.last.slice(0, 10)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if status === 'parsed' || status === 'running' || status === 'failed'}
		<p>
			<button onclick={runImport} disabled={status === 'running'}>
				{status === 'failed' ? 'Erneut versuchen' : 'Importieren'}
			</button>
		</p>
	{/if}

	{#if status === 'running'}
		<progress value={progress}></progress>
		<p class="muted">{Math.round(progress * 100)} %</p>
	{/if}

	{#if message}
		<p class={status === 'failed' ? 'error' : ''}>{message}</p>
	{/if}
</div>

<h2>Importierte Daten</h2>

{#if data.loadError}
	<p class="error">{data.loadError}</p>
{/if}

{#if !data.overview.length}
	<div class="card">
		<p>Noch keine Daten. <a href="/import">CoinTracking-Export importieren</a></p>
	</div>
{:else}
	<div class="card">
		<h2 style="margin-top:0">Buchungen je Konto und Jahr</h2>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Konto</th>
						{#each byVenueYear.years as y (y)}<th class="num">{y}</th>{/each}
					</tr>
				</thead>
				<tbody>
					{#each byVenueYear.rows as [exchange, years] (exchange)}
						<tr>
							<td>{exchange}</td>
							{#each byVenueYear.years as y (y)}
								<td class="num">{years.get(y)?.toLocaleString('de-DE') ?? ''}</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<h2>Bitget 2026 nach Typ</h2>
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Konto</th><th>Typ</th><th class="num">Anzahl</th><th>Letzte Buchung</th></tr>
				</thead>
				<tbody>
					{#each current as r (r.exchange + r.type)}
						<tr>
							<td>{r.exchange}</td>
							<td>{r.type}</td>
							<td class="num">{r.n.toLocaleString('de-DE')}</td>
							<td>{fmtDate(r.last_ts)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/if}

{#if data.imports.length}
	<h2>Importe</h2>
	<div class="card table-wrap">
		<table>
			<thead>
				<tr><th>Datei</th><th>Status</th><th class="num">Zeilen</th><th>Zeitpunkt</th></tr>
			</thead>
			<tbody>
				{#each data.imports as i (i.id)}
					<tr>
						<td>{i.file_name ?? i.source}</td>
						<td>{i.status}</td>
						<td class="num">{i.row_count?.toLocaleString('de-DE') ?? ''}</td>
						<td>{fmtDate(i.created_at)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	select {
		padding: 9px 11px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg);
		color: var(--text);
		font: inherit;
	}
</style>
