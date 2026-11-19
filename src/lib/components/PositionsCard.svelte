<script lang="ts">
	import Decimal from 'decimal.js';
	import type { LiveData } from '#lib/analysis/portfolio.ts';
	import { money, qty, tone } from '#lib/format.ts';

	/**
	 * Offene Futures-Positionen live (Dashboard und Futures).
	 * Immer sichtbar – auch leer –, damit man sofort sieht, ob noch etwas offen ist.
	 */
	let {
		live,
		error = null,
		title = 'Aktuelle Positionen'
	}: { live: LiveData | null; error?: string | null; title?: string } = $props();

	const D = (s: string) => new Decimal(s || 0);
	const positions = $derived(live?.positions.ok ? live.positions.data : []);
	const sectionError = $derived(live && !live.positions.ok ? live.positions.error : null);
	const total = $derived(positions.reduce((s, p) => s.add(p.unrealizedPL || 0), new Decimal(0)));
	const margin = $derived(positions.reduce((s, p) => s.add(p.marginSize || 0), new Decimal(0)));
</script>

<section class="card block">
	<div class="head-row">
		<div class="card-title">{title}</div>
		{#if positions.length}
			<div class="small">
				Margin {money(margin, 'USDT', { digits: 2 })} · unrealisiert <strong class={tone(total)}>{money(total, 'USDT', { sign: true })}</strong>
			</div>
		{/if}
	</div>
	{#if error || sectionError}
		<p class="error small">Positionen nicht abrufbar: {error ?? sectionError}</p>
	{:else if !live}
		<p class="muted small">Lade Positionen …</p>
	{:else if !positions.length}
		<p class="muted small">Keine offenen Positionen.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Symbol</th>
						<th>Seite</th>
						<th class="num">Größe</th>
						<th class="num">Einstieg</th>
						<th class="num">Mark</th>
						<th class="num">Hebel</th>
						<th class="num">Margin</th>
						<th class="num">Liquidation</th>
						<th class="num">Unrealisiert</th>
					</tr>
				</thead>
				<tbody>
					{#each positions as p (p.symbol + p.holdSide)}
						<tr>
							<td><strong>{p.symbol}</strong></td>
							<td class={p.holdSide === 'long' ? 'gain' : 'loss'}>{p.holdSide === 'long' ? 'Long' : 'Short'}</td>
							<td class="num">{qty(D(p.total), 6)}</td>
							<td class="num">{qty(D(p.openPriceAvg), 6)}</td>
							<td class="num">{qty(D(p.markPrice), 6)}</td>
							<td class="num">{p.leverage}×</td>
							<td class="num">{qty(D(p.marginSize), 2)}</td>
							<td class="num muted">{p.liquidationPrice && !D(p.liquidationPrice).isZero() ? qty(D(p.liquidationPrice), 4) : '–'}</td>
							<td class="num {tone(D(p.unrealizedPL))}">{money(D(p.unrealizedPL), 'USDT', { sign: true })}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	{#if live}
		<p class="small muted">Live von Bitget, Stand {new Date(live.at).toLocaleTimeString('de-DE')}. Unrealisiert zum Mark-Preis.</p>
	{/if}
</section>
