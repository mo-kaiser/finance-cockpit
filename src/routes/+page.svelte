<script lang="ts">
	let { data } = $props();

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

<h1>Übersicht</h1>

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
