<script lang="ts">
	import Decimal from 'decimal.js';
	import LineChart from '$lib/components/LineChart.svelte';
	import { buildPortfolio } from '$lib/analysis/portfolio';
	import { money, qty, tone } from '$lib/format';
	import { USD_STABLE } from '$lib/tax/assets';
	import { computeTax, type Disposal } from '$lib/tax/engine';
	import { FxTable } from '$lib/tax/fx';

	let { data } = $props();

	const fx = $derived(new FxTable(data.ledger?.fx ?? []));
	const tax = $derived(data.ledger && fx.size ? computeTax(data.ledger.ledger, fx, 'all') : null);

	let year = $state<string>('alle');
	let withStable = $state(false);

	const years = $derived(tax ? [...new Set(tax.disposals.map((d) => d.day.slice(0, 4)))].sort().reverse() : []);
	const disposals = $derived(
		(tax?.disposals ?? []).filter((d) => (withStable || !USD_STABLE.has(d.asset)) && (year === 'alle' || d.day.startsWith(year)))
	);

	const ZERO = new Decimal(0);
	const costOf = (d: Disposal) => d.portions.reduce<Decimal | null>((s, p) => (s === null || p.cost === null ? null : s.add(p.cost)), ZERO);
	/** Einstand der Teile, deren Kosten bekannt sind */
	const knownCost = (d: Disposal) => d.portions.reduce((s, p) => (p.cost ? s.add(p.cost) : s), ZERO);
	const resultOf = (d: Disposal) => d.gainTaxable.add(d.gainFree);
	const complete = (d: Disposal) => d.status === 'ok' || d.status === 'geschaetzt';

	interface Agg {
		key: string;
		n: number;
		qty: Decimal;
		proceeds: Decimal;
		cost: Decimal;
		result: Decimal;
		taxable: Decimal;
		open: number;
	}
	function aggregate(by: (d: Disposal) => string) {
		const m = new Map<string, Agg>();
		for (const d of disposals) {
			const k = by(d);
			const a = m.get(k) ?? { key: k, n: 0, qty: ZERO, proceeds: ZERO, cost: ZERO, result: ZERO, taxable: ZERO, open: 0 };
			a.n++;
			a.qty = a.qty.add(d.qty);
			a.proceeds = a.proceeds.add(d.proceeds ?? 0);
			a.cost = a.cost.add(knownCost(d));
			a.result = a.result.add(resultOf(d));
			a.taxable = a.taxable.add(d.gainTaxable);
			if (!complete(d)) a.open++;
			m.set(k, a);
		}
		return [...m.values()];
	}
	const coinsAll = $derived(aggregate((d) => d.asset).sort((a, b) => b.proceeds.cmp(a.proceeds)));
	// Tausche ganz ohne EUR-Wert (z. B. Kleinstbeträge gegen BGB) nicht als eigene Zeilen
	const byCoin = $derived(coinsAll.filter((a) => !a.proceeds.isZero() || !a.result.isZero()));
	const unvalued = $derived(coinsAll.filter((a) => a.proceeds.isZero() && a.result.isZero()));
	const byYear = $derived(aggregate((d) => d.day.slice(0, 4)).sort((a, b) => b.key.localeCompare(a.key)));
	const total = $derived(
		byCoin.reduce(
			(s, a) => ({ n: s.n + a.n, result: s.result.add(a.result), taxable: s.taxable.add(a.taxable), open: s.open + a.open }),
			{ n: 0, result: ZERO, taxable: ZERO, open: 0 }
		)
	);

	const cumulative = $derived.by(() => {
		const days = new Map<string, Decimal>();
		for (const d of disposals) days.set(d.day, (days.get(d.day) ?? ZERO).add(resultOf(d)));
		let run = ZERO;
		return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, v: (run = run.add(v)).toNumber() }));
	});

	// Unrealisiert: aktuelle Bestände (live) gegen Einstand aus FIFO
	const eurPerUsdt = $derived.by(() => {
		const r = fx.last ? fx.rateFor(fx.last) : null;
		return r ? new Decimal(1).div(r.rate) : null;
	});
	const portfolio = $derived(
		data.live && tax ? buildPortfolio(data.live, eurPerUsdt, tax.holdingsEnd, new Set(['spot', 'earn'] as const)) : null
	);
	const unrealized = $derived(new Map((portfolio?.rows ?? []).map((r) => [r.coin, r])));
	const unrealizedRows = $derived(
		(portfolio?.rows ?? []).filter((r) => (withStable || !USD_STABLE.has(r.coin)) && (r.valueUsdt?.gte(1) ?? false))
	);
	const unrealizedSum = $derived(unrealizedRows.reduce((s, r) => s.add(r.unrealizedEur ?? 0), ZERO));

	const STATUS: Record<string, string> = { ok: '', geschaetzt: 'geschätzt', kosten_unbekannt: 'Kosten fehlen', fehlbestand: 'Fehlbestand', unbewertet: 'ohne EUR-Wert' };
</script>

<div class="page-head">
	<h1>Spot</h1>
	<div class="toolbar">
		<div class="seg" role="group" aria-label="Jahr">
			<button aria-pressed={year === 'alle'} onclick={() => (year = 'alle')}>Gesamt</button>
			{#each years as y (y)}<button aria-pressed={year === y} onclick={() => (year = y)}>{y}</button>{/each}
		</div>
		<label class="check"><input type="checkbox" bind:checked={withStable} /> Stablecoins (USDT, USDC)</label>
	</div>
</div>

{#if data.ledgerError}<p class="error">{data.ledgerError}</p>{/if}

{#if tax}
	<div class="kpis">
		<div class="kpi">
			<div class="label">Realisiert {year === 'alle' ? 'gesamt' : year}</div>
			<div class="value {tone(total.result)}">{money(total.result, 'EUR', { sign: true })}</div>
			<div class="sub">{total.n} Verkäufe{total.open ? ` · ${total.open} unvollständig` : ''}</div>
		</div>
		<div class="kpi">
			<div class="label">davon innerhalb Haltefrist</div>
			<div class="value {tone(total.taxable)}">{money(total.taxable, 'EUR', { sign: true })}</div>
			<div class="sub">steuerlich relevant (§ 23 EStG)</div>
		</div>
		<div class="kpi">
			<div class="label">Unrealisiert jetzt</div>
			<div class="value {tone(unrealizedSum)}">{portfolio ? money(unrealizedSum, 'EUR', { sign: true }) : '–'}</div>
			<div class="sub">Spot + Earn, Coins mit bekanntem Einstand</div>
		</div>
	</div>

	{#if cumulative.length > 1}
		<section class="card" style="margin-top:16px">
			<div class="card-title">Kumuliert realisiert (EUR)</div>
			<LineChart labels={cumulative.map((c) => c.day)} values={cumulative.map((c) => c.v)} format={(v) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €`} />
		</section>
	{/if}

	<section class="card" style="margin-top:16px">
		<div class="card-title">Nach Coin</div>
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Coin</th><th class="num">Verkäufe</th><th class="num">Menge</th><th class="num">Erlös</th><th class="num">Einstand</th><th class="num">Realisiert</th><th class="num">davon stpfl.</th><th class="num">Unrealisiert jetzt</th></tr>
				</thead>
				<tbody>
					{#each byCoin as a (a.key)}
						{@const u = unrealized.get(a.key)}
						<tr>
							<td><strong>{a.key}</strong></td>
							<td class="num">{a.n}{a.open ? ` (${a.open} unvollst.)` : ''}</td>
							<td class="num">{qty(a.qty, 6)}</td>
							<td class="num">{money(a.proceeds)}</td>
							<td class="num">{money(a.cost)}</td>
							<td class="num {tone(a.result)}">{money(a.result, 'EUR', { sign: true })}</td>
							<td class="num {tone(a.taxable)}">{money(a.taxable, 'EUR', { sign: true })}</td>
							<td class="num {tone(u?.unrealizedEur)}">{u?.unrealizedEur ? money(u.unrealizedEur, 'EUR', { sign: true }) : ''}</td>
						</tr>
					{:else}
						<tr><td colspan="8" class="muted">Keine Verkäufe im Zeitraum.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if unvalued.length}
			<p class="small muted">
				Ohne EUR-Wert und daher nicht aufgeführt: {unvalued.reduce((n, a) => n + a.n, 0)} Tausche von {unvalued.map((a) => a.key).join(', ')} (Coin gegen Coin, meist Kleinstbeträge gegen BGB).
			</p>
		{/if}
	</section>

	<div class="grid-2" style="margin-top:16px">
		<section class="card">
			<div class="card-title">Nach Jahr</div>
			<table>
				<thead><tr><th>Jahr</th><th class="num">Verkäufe</th><th class="num">Realisiert</th><th class="num">davon stpfl.</th></tr></thead>
				<tbody>
					{#each byYear as a (a.key)}
						<tr><td>{a.key}</td><td class="num">{a.n}</td><td class="num {tone(a.result)}">{money(a.result, 'EUR', { sign: true })}</td><td class="num {tone(a.taxable)}">{money(a.taxable, 'EUR', { sign: true })}</td></tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section class="card">
			<div class="card-title">Aktuelle Bestände (Spot + Earn)</div>
			{#if data.liveError}<p class="error small">{data.liveError}</p>{/if}
			<table>
				<thead><tr><th>Coin</th><th class="num">Wert</th><th class="num">Einstand</th><th class="num">Unrealisiert</th></tr></thead>
				<tbody>
					{#each unrealizedRows as r (r.coin)}
						<tr>
							<td>{r.coin}</td>
							<td class="num">{money(r.valueEur)}</td>
							<td class="num" title={r.costNote ?? ''}>{r.costEur ? money(r.costEur) : '–'}</td>
							<td class="num {tone(r.unrealizedEur)}">{r.unrealizedEur ? money(r.unrealizedEur, 'EUR', { sign: true }) : ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	</div>

	<section class="card" style="margin-top:16px">
		<div class="card-title">Letzte Verkäufe</div>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Datum</th><th>Coin</th><th class="num">Menge</th><th>gegen</th><th class="num">Erlös</th><th class="num">Einstand</th><th class="num">Ergebnis</th><th>Haltefrist</th></tr></thead>
				<tbody>
					{#each [...disposals].reverse().slice(0, 50) as d (d.txId)}
						{@const c = costOf(d)}
						<tr>
							<td>{d.day}</td>
							<td>{d.asset}</td>
							<td class="num">{qty(d.qty, 6)}</td>
							<td>{d.counter}</td>
							<td class="num">{money(d.proceeds)}</td>
							<td class="num">{money(c)}</td>
							<td class="num {tone(resultOf(d))}">{money(resultOf(d), 'EUR', { sign: true })}</td>
							<td class="small {d.gainTaxable.isZero() ? 'muted' : ''}">
								{d.portions.every((p) => p.taxable === false) ? 'abgelaufen' : d.portions.every((p) => p.taxable) ? 'innerhalb' : 'gemischt'}
								{#if STATUS[d.status]}<span class="error"> · {STATUS[d.status]}</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="small muted">Ergebnisse nach FIFO je Coin über alle Bitget-Konten, in EUR. Käufe mit USDT sind steuerlich Verkäufe von USDT; diese erscheinen nur mit „Stablecoins“.</p>
	</section>
{:else if !data.ledgerError}
	<p class="muted">Lade …</p>
{/if}

<style>
	.check {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
	}
	.check input {
		width: auto;
	}
</style>
