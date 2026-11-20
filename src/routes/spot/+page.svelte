<script lang="ts">
	import Decimal from 'decimal.js';
	import LineChart from '#lib/components/LineChart.svelte';
	import { buildPortfolio } from '#lib/analysis/portfolio.ts';
	import { money, pct, qty, tone } from '#lib/format.ts';
	import { USD_STABLE } from '#lib/tax/assets.ts';
	import { computeTax, type Disposal } from '#lib/tax/engine.ts';
	import { FxTable } from '#lib/tax/fx.ts';
	import { PriceTable } from '#lib/tax/prices.ts';

	import BrokerSelect from '#lib/components/BrokerSelect.svelte';
	import RefreshButton from '#lib/components/RefreshButton.svelte';
	import HelpBox from '#lib/components/HelpBox.svelte';
	import Zone from '#lib/components/Zone.svelte';
	import { brokerHas, brokerState, holdingsFor, liveFor } from '#lib/broker.svelte.ts';

	let { data } = $props();

	const hasKucoin = $derived(!!data.kucoin || (data.ledger?.sources.kucoin ?? 0) > 0);
	const broker = $derived(hasKucoin ? brokerState.value : 'Bitget');
	const live = $derived(liveFor(broker, data.live, data.kucoin));

	const fx = $derived(new FxTable(data.ledger?.fx ?? []));
	const priceTable = $derived(new PriceTable(data.ledger?.prices ?? []));
	const tax = $derived(data.ledger && fx.size ? computeTax(data.ledger.ledger, fx, 'all', priceTable) : null);

	let year = $state<string>('alle');
	let withStable = $state(false);

	const venueDisposals = $derived((tax?.disposals ?? []).filter((d) => brokerHas(broker, d.venue)));
	const years = $derived([...new Set(venueDisposals.map((d) => d.day.slice(0, 4)))].sort().reverse());
	const disposals = $derived(
		venueDisposals.filter((d) => (withStable || !USD_STABLE.has(d.asset)) && (year === 'alle' || d.day.startsWith(year)))
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
		live && tax ? buildPortfolio(live, eurPerUsdt, holdingsFor(broker, tax), new Set(['spot', 'earn'] as const)) : null
	);
	const unrealized = $derived(new Map((portfolio?.rows ?? []).map((r) => [r.coin, r])));
	const unrealizedRows = $derived(
		(portfolio?.rows ?? []).filter((r) => (withStable || !USD_STABLE.has(r.coin)) && (r.valueUsdt?.gte(1) ?? false))
	);
	const unrealizedSum = $derived(unrealizedRows.reduce((s, r) => s.add(r.unrealizedEur ?? 0), ZERO));
	const holdValue = $derived(unrealizedRows.reduce((s, r) => s.add(r.valueEur ?? 0), ZERO));
	const holdCost = $derived(unrealizedRows.reduce((s, r) => s.add(r.costEur ?? 0), ZERO));
	const holdCovered = $derived(unrealizedRows.filter((r) => r.unrealizedEur).length);
	const yearLabel = $derived(year === 'alle' ? 'gesamt' : year);

	const STATUS: Record<string, string> = { ok: '', geschaetzt: 'geschätzt', kosten_unbekannt: 'Kosten fehlen', fehlbestand: 'Fehlbestand', unbewertet: 'ohne EUR-Wert' };
</script>

<div class="page-head">
	<h1>Spot</h1>
	<div class="toolbar">
		<BrokerSelect show={hasKucoin} />
		<label class="check"><input type="checkbox" bind:checked={withStable} /> Stablecoins (USDT, USDC)</label>
		<RefreshButton />
	</div>
</div>

{#if data.ledgerError}<p class="error">{data.ledgerError}</p>{/if}
{#if broker !== 'Bitget' && data.kucoinError}<p class="error small">KuCoin nicht erreichbar: {data.kucoinError}</p>{/if}

{#if tax}
	<Zone title="Aktueller Stand" now at={live?.at ?? null}>
		{#if broker !== 'KuCoin' && data.liveError}<p class="error small">Bitget nicht erreichbar: {data.liveError}</p>{/if}
		<div class="grid-3-1">
			<section class="card">
				<div class="card-title">Bestände Spot + Earn · EUR</div>
				<div class="table-wrap scroll-now">
					<table>
						<thead><tr><th>Coin</th><th class="num">Menge</th><th class="num">Kurs (USDT)</th><th class="num">Wert</th><th class="num">Anteil</th><th class="num">Einstand</th><th class="num">Unrealisiert</th></tr></thead>
						<tbody>
							{#each unrealizedRows as r (r.coin)}
								<tr>
									<td><strong>{r.coin}</strong></td>
									<td class="num muted">{qty(r.qty, 6)}</td>
									<td class="num">{r.price ? qty(r.price, r.price.lt(1) ? 6 : 2) : '–'}</td>
									<td class="num">{money(r.valueEur)}</td>
									<td class="num muted">{r.valueEur && !holdValue.isZero() ? pct(r.valueEur.div(holdValue).toNumber()) : ''}</td>
									<td class="num" title={r.costNote ?? ''}>{r.costEur ? money(r.costEur) : '–'}</td>
									<td class="num {tone(r.unrealizedEur)}">{r.unrealizedEur ? money(r.unrealizedEur, 'EUR', { sign: true }) : ''}</td>
								</tr>
							{:else}
								<tr><td colspan="7" class="muted">{live ? 'Keine Bestände über 1 USDT.' : 'Lade Bestände …'}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
			<div class="kpis tiles-stack">
				<div class="kpi">
					<div class="label">Bestandswert</div>
					<div class="value">{portfolio ? money(holdValue, 'EUR') : '–'}</div>
					<div class="sub">Spot + Earn, ab 1 USDT je Coin</div>
				</div>
				<div class="kpi">
					<div class="label">Unrealisiert</div>
					<div class="value {tone(unrealizedSum)}">{portfolio ? money(unrealizedSum, 'EUR', { sign: true }) : '–'}</div>
					<div class="sub">{holdCovered} von {unrealizedRows.length} Coins mit bekanntem Einstand</div>
				</div>
				<div class="kpi">
					<div class="label">Einstand (bekannt)</div>
					<div class="value">{portfolio ? money(holdCost, 'EUR') : '–'}</div>
					<div class="sub">nach FIFO aus den Buchungen</div>
				</div>
				<div class="kpi">
					<div class="label">Coins</div>
					<div class="value">{unrealizedRows.length}</div>
					<div class="sub">größter Anteil: {unrealizedRows[0]?.coin ?? '–'}</div>
				</div>
			</div>
		</div>
	</Zone>

	<Zone title="Realisiert">
		{#snippet tools()}
			<div class="seg" role="group" aria-label="Jahr">
				<button aria-pressed={year === 'alle'} onclick={() => (year = 'alle')}>Gesamt</button>
				{#each years as y (y)}<button aria-pressed={year === y} onclick={() => (year = y)}>{y}</button>{/each}
			</div>
		{/snippet}
		<div class="kpis">
			<div class="kpi">
				<div class="label">Realisiert · {yearLabel}</div>
				<div class="value {tone(total.result)}">{money(total.result, 'EUR', { sign: true })}</div>
				<div class="sub">alle Verkäufe nach FIFO</div>
			</div>
			<div class="kpi">
				<div class="label">davon innerhalb Haltefrist</div>
				<div class="value {tone(total.taxable)}">{money(total.taxable, 'EUR', { sign: true })}</div>
				<div class="sub">steuerlich relevant (§ 23 EStG)</div>
			</div>
			<div class="kpi">
				<div class="label">Verkäufe · {yearLabel}</div>
				<div class="value">{total.n}</div>
				<div class="sub">{total.open ? `${total.open} unvollständig (Einstand fehlt)` : 'alle mit Einstand'}</div>
			</div>
			<div class="kpi">
				<div class="label">Nach Jahr · davon stpfl.</div>
				<div class="mini">
					{#each byYear.slice(0, 4) as a (a.key)}
						<button class="mini-row" class:on={year === a.key} onclick={() => (year = year === a.key ? 'alle' : a.key)}>
							<span>{a.key}</span><span class={tone(a.result)}>{money(a.result, 'EUR', { sign: true, digits: 0 })}</span><span class="muted">{money(a.taxable, 'EUR', { sign: true, digits: 0 })}</span>
						</button>
					{/each}
				</div>
			</div>
		</div>

		<div class="grid-half block">
			<section class="card">
				<div class="card-title">Kumuliert realisiert · EUR</div>
				{#if cumulative.length > 1}
					<LineChart labels={cumulative.map((c) => c.day)} values={cumulative.map((c) => c.v)} format={(v) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €`} height={340} />
				{:else}
					<p class="muted small">Zu wenige Verkäufe im Zeitraum für einen Verlauf.</p>
				{/if}
			</section>
			<section class="card">
				<div class="card-title">Nach Coin · EUR</div>
				<div class="table-wrap scroll-340">
					<table>
						<thead><tr><th>Coin</th><th class="num">Verkäufe</th><th class="num">Erlös</th><th class="num">Realisiert</th><th class="num">davon stpfl.</th></tr></thead>
						<tbody>
							{#each byCoin as a (a.key)}
								<tr>
									<td><strong>{a.key}</strong></td>
									<td class="num">{a.n}{a.open ? ` (${a.open} unvollst.)` : ''}</td>
									<td class="num">{money(a.proceeds)}</td>
									<td class="num {tone(a.result)}">{money(a.result, 'EUR', { sign: true })}</td>
									<td class="num {tone(a.taxable)}">{money(a.taxable, 'EUR', { sign: true })}</td>
								</tr>
							{:else}
								<tr><td colspan="5" class="muted">Keine Verkäufe im Zeitraum.</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if unvalued.length}
					<p class="small muted">Ohne EUR-Wert nicht aufgeführt: {unvalued.reduce((n, a) => n + a.n, 0)} Tausche von {unvalued.map((a) => a.key).join(', ')}.</p>
				{/if}
			</section>
		</div>

		<section class="card block">
			<div class="card-title">Letzte Verkäufe · EUR</div>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Datum</th>{#if broker === 'Alle'}<th>Börse</th>{/if}<th>Coin</th><th class="num">Menge</th><th>gegen</th><th class="num">Erlös</th><th class="num">Einstand</th><th class="num">Ergebnis</th><th>Haltefrist</th></tr></thead>
					<tbody>
						{#each [...disposals].reverse().slice(0, 50) as d (d.txId)}
							{@const c = costOf(d)}
							<tr>
								<td>{d.day}</td>
								{#if broker === 'Alle'}<td class="small">{d.venue === 'kucoin' ? 'KuCoin' : 'Bitget'}</td>{/if}
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
		</section>
	</Zone>

	<HelpBox>
		<ul>
			<li><strong>Aktueller Stand</strong>: Spot- und Earn-Bestände fragt das Cockpit bei jedem Seitenaufruf direkt bei der Börse ab; Einstand nach FIFO aus den Buchungen, Euro über den letzten EZB-Kurs.</li>
			<li><strong>Realisiert</strong>: Ergebnisse aller Spot-Verkäufe nach FIFO je Coin und Börse (bei Bitget über Spot, Earn und Futures gemeinsam), in EUR über den EZB-Tageskurs.</li>
			<li><strong>Innerhalb Haltefrist</strong>: Verkäufe von Coins, die höchstens ein Jahr gehalten wurden – nur dieser Teil ist nach § 23 EStG steuerpflichtig.</li>
			<li>Käufe mit USDT sind steuerlich Verkäufe von USDT; diese erscheinen nur mit „Stablecoins“.</li>
			<li>„geschätzt“: Einstand über den Tageswert, weil der echte Kaufpreis fehlt (z. B. Einzahlungen von außen). Nachtragen unter <a href="/korrekturen">Korrekturen</a>.</li>
		</ul>
	</HelpBox>
{:else if !data.ledgerError}
	<p class="muted">Lade …</p>
{/if}

<style>
	.scroll-now {
		max-height: 480px;
		overflow-y: auto;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
	}
	.check input {
		width: auto;
	}
	.scroll-340 {
		max-height: 340px;
		overflow-y: auto;
	}
	.mini {
		display: grid;
		gap: 2px;
		margin-top: 4px;
	}
	.mini-row {
		all: unset;
		cursor: pointer;
		display: grid;
		grid-template-columns: 3.5em 1fr 1fr;
		gap: 8px;
		padding: 2px 4px;
		border-radius: 6px;
		font-variant-numeric: tabular-nums;
	}
	.mini-row span + span {
		text-align: right;
	}
	.mini-row:hover,
	.mini-row.on {
		background: var(--accent-soft);
	}
</style>
