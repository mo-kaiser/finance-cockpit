<script lang="ts">
	import Decimal from 'decimal.js';
	import type { LiveData } from '#lib/analysis/portfolio.ts';
	import { money, qty, tone } from '#lib/format.ts';

	/**
	 * Offene Futures-Positionen live (Dashboard und Futures), gehört in den Bereich „Jetzt“.
	 * variant 'table': volle Tabelle (Futures). variant 'list': schmale Liste neben den Beständen (Dashboard).
	 * Ohne offene Positionen nur eine schmale Zeile – bleibt sichtbar, damit man es sofort sieht.
	 */
	let {
		live,
		error = null,
		variant = 'table',
		href = null
	}: { live: LiveData | null; error?: string | null; variant?: 'table' | 'list'; href?: string | null } = $props();

	const D = (s: string) => new Decimal(s || 0);
	const positions = $derived(live?.positions.ok ? live.positions.data : []);
	const sectionError = $derived(live && !live.positions.ok ? live.positions.error : null);
	const total = $derived(positions.reduce((s, p) => s.add(p.unrealizedPL || 0), new Decimal(0)));
	const margin = $derived(positions.reduce((s, p) => s.add(p.marginSize || 0), new Decimal(0)));
	const count = $derived(`${positions.length} ${positions.length === 1 ? 'Position' : 'Positionen'}`);
</script>

{#if error || sectionError}
	<div class="card slim"><span class="error small">Positionen nicht abrufbar: {error ?? sectionError}</span></div>
{:else if !live}
	<div class="card slim"><span class="muted small">Lade Positionen …</span></div>
{:else if !positions.length}
	<div class="card slim">
		<span><strong>Offene Futures-Positionen:</strong> <span class="muted">keine</span></span>
		{#if href}<a class="small" {href}>Zu Futures →</a>{/if}
	</div>
{:else if variant === 'list'}
	<div class="card">
		<div class="list-head">
			<div class="card-title">Offene Positionen</div>
			{#if href}<a class="small" {href}>Details →</a>{/if}
		</div>
		<ul class="plist">
			{#each positions as p (p.symbol + p.holdSide)}
				<li>
					<span><strong>{p.symbol.replace(/USDT$/, '')}</strong> <span class="small {p.holdSide === 'long' ? 'gain' : 'loss'}">{p.holdSide === 'long' ? 'Long' : 'Short'} {p.leverage}×</span></span>
					<span class="mono {tone(D(p.unrealizedPL))}">{money(D(p.unrealizedPL), 'USDT', { sign: true })}</span>
				</li>
			{/each}
		</ul>
		<div class="small muted">{count} · Margin {money(margin, 'USDT', { digits: 0 })}</div>
	</div>
{:else}
	<div class="card">
		<div class="list-head">
			<div class="card-title">Offene Futures-Positionen</div>
			<div class="small">{count} · Margin {money(margin, 'USDT', { digits: 2 })} · unrealisiert <strong class={tone(total)}>{money(total, 'USDT', { sign: true })}</strong></div>
		</div>
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
	</div>
{/if}

<style>
	.slim {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding-top: 10px;
		padding-bottom: 10px;
	}
	.list-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
	}
	.plist {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
	}
	.plist li {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}
</style>
