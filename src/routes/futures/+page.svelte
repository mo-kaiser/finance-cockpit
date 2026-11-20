<script lang="ts">
	import Decimal from 'decimal.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import LineChart from '#lib/components/LineChart.svelte';
	import { futuresEvents, futuresStats, inRange, type Bucket, type Currency } from '#lib/analysis/futures.ts';
	import { MONTHS, WEEKDAYS, money, pct, ratio, tone } from '#lib/format.ts';
	import { FxTable } from '#lib/tax/fx.ts';

	import BrokerSelect from '#lib/components/BrokerSelect.svelte';
	import RefreshButton from '#lib/components/RefreshButton.svelte';
	import PositionsCard from '#lib/components/PositionsCard.svelte';
	import Zone from '#lib/components/Zone.svelte';
	import type { LiveData } from '#lib/analysis/portfolio.ts';
	import { brokerState, ledgerFor } from '#lib/broker.svelte.ts';
	import { venueOf } from '#lib/tax/types.ts';

	let { data } = $props();

	// Börsen-Auswahl: Futures gibt es derzeit nur bei Bitget
	const hasKucoin = $derived(data.ledger.some((e) => venueOf(e) === 'kucoin'));
	const broker = $derived(hasKucoin ? brokerState.value : 'Bitget');

	const fx = $derived(new FxTable(data.fx));
	const events = $derived(futuresEvents(ledgerFor(broker, data.ledger), fx));
	const lastDay = $derived(events.length ? events[events.length - 1]!.day : new Date().toISOString().slice(0, 10));

	// Zustand in der URL, damit Zurück/Lesezeichen funktionieren
	const view = $derived(page.url.searchParams.get('view') === 'statistik' ? 'statistik' : 'kalender');
	const cur = $derived<Currency>(page.url.searchParams.get('cur') === 'EUR' ? 'EUR' : 'USDT');
	const month = $derived(page.url.searchParams.get('m') ?? lastDay.slice(0, 7));
	const period = $derived((page.url.searchParams.get('p') as 'monat' | 'jahr' | 'gesamt' | null) ?? 'jahr');

	function setParam(k: string, v: string) {
		const u = new URL(page.url.href); // page.url ist schreibgeschützt
		u.searchParams.set(k, v);
		goto(u, { replace: true, reset: false });
	}

	function shiftMonth(delta: number) {
		const [y, m] = month.split('-').map(Number) as [number, number];
		const d = new Date(Date.UTC(y, m - 1 + delta, 1));
		setParam('m', d.toISOString().slice(0, 7));
	}

	const fmt = (d: Decimal | null, sign = false) => money(d, cur, { sign, unit: false });
	const fmtU = (d: Decimal | null, sign = false) => money(d, cur, { sign });
	const unit = $derived(cur === 'EUR' ? '€' : 'USDT');
	const fmtN = (v: number) => (cur === 'EUR' ? `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : v.toLocaleString('de-DE', { maximumFractionDigits: 0 }));

	// ---------- Kalender ----------
	const monthStart = $derived(`${month}-01`);
	const monthEnd = $derived.by(() => {
		const [y, m] = month.split('-').map(Number) as [number, number];
		return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
	});
	const monthStats = $derived(futuresStats(inRange(events, monthStart, monthEnd), cur));

	const weeks = $derived.by(() => {
		const [y, m] = month.split('-').map(Number) as [number, number];
		const first = new Date(Date.UTC(y, m - 1, 1));
		const lead = (first.getUTCDay() + 6) % 7;
		const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
		const cells: (string | null)[] = [...Array(lead).fill(null)];
		for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
		while (cells.length % 7) cells.push(null);
		const rows: { days: (string | null)[]; sum: Bucket | null }[] = [];
		for (let i = 0; i < cells.length; i += 7) {
			const ds = cells.slice(i, i + 7);
			let sum: Bucket | null = null;
			for (const d of ds) {
				const b = d ? monthStats.byDay.get(d) : undefined;
				if (!b) continue;
				sum ??= { net: new Decimal(0), pnl: new Decimal(0), fees: new Decimal(0), funding: new Decimal(0), other: new Decimal(0), trades: 0, wins: 0, losses: 0 };
				sum = { ...sum, net: sum.net.add(b.net), trades: sum.trades + b.trades };
			}
			rows.push({ days: ds, sum });
		}
		return rows;
	});
	const today = new Date().toISOString().slice(0, 10);

	// ---------- Statistik ----------
	const years = $derived([...new Set(events.map((e) => e.day.slice(0, 4)))].sort().reverse());
	const year = $derived(page.url.searchParams.get('y') ?? years[0] ?? String(new Date().getFullYear()));
	const range = $derived(
		period === 'gesamt' ? ['0000-01-01', '9999-12-31'] : period === 'jahr' ? [`${year}-01-01`, `${year}-12-31`] : [monthStart, monthEnd]
	);
	const stats = $derived(futuresStats(inRange(events, range[0]!, range[1]!), cur));
	const rangeLabel = $derived(period === 'gesamt' ? 'Gesamt' : period === 'jahr' ? year : `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`);
	const maxAbs = (bs: Bucket[]) => Math.max(1, ...bs.map((b) => Math.abs(b.pnl.toNumber())));
	const mw = $derived(maxAbs(stats.byWeekday));
	const mh = $derived(maxAbs(stats.byHour));

	// ---------- Kalender: Monate des angezeigten Jahres ----------
	const calYear = $derived(month.slice(0, 4));
	const calYearStats = $derived(futuresStats(inRange(events, `${calYear}-01-01`, `${calYear}-12-31`), cur));

	// ---------- Aktueller Stand (Bitget), unabhängig vom Zeitraum ----------
	let live = $state<LiveData | null>(null);
	let liveError = $state<string | null>(null);
	$effect(() => {
		const p = data.live;
		let alive = true;
		p.then((r) => {
			if (!alive) return;
			live = r.data;
			liveError = r.error;
		});
		return () => {
			alive = false;
		};
	});
	const futAcc = $derived(live?.futures.ok ? live.futures.data : []);
	const futEquity = $derived(futAcc.reduce((s, a) => s.add(a.usdtEquity || a.accountEquity || 0), new Decimal(0)));
	const futAvailable = $derived(futAcc.reduce((s, a) => s.add(a.available || 0), new Decimal(0)));
	const futUnrealized = $derived(futAcc.reduce((s, a) => s.add(a.unrealizedPL || 0), new Decimal(0)));
</script>

<div class="page-head">
	<h1>Futures</h1>
	<div class="toolbar">
		<BrokerSelect show={hasKucoin} />
		<div class="seg" role="group" aria-label="Währung">
			<button aria-pressed={cur === 'EUR'} onclick={() => setParam('cur', 'EUR')}>EUR</button>
			<button aria-pressed={cur === 'USDT'} onclick={() => setParam('cur', 'USDT')}>USDT</button>
		</div>
		<RefreshButton />
	</div>
</div>

{#if data.loadError}<p class="error">{data.loadError}</p>{/if}
{#if broker === 'KuCoin' && !events.length}<p class="muted">Bei KuCoin gibt es keine Futures-Buchungen. Futures handelst du bisher nur bei Bitget.</p>{/if}

{#snippet longShort()}
<section class="card">
	<div class="card-title">Long vs. Short · {unit}</div>
	<table>
		<thead><tr><th>Richtung</th><th class="num">Trades</th><th class="num">Anteil</th><th class="num">Treffer</th><th class="num">Ergebnis brutto</th></tr></thead>
		<tbody>
			{#each ['long', 'short'] as const as d (d)}
				{@const x = stats.byDir[d]}
				<tr>
					<td>{d === 'long' ? 'Long' : 'Short'}</td>
					<td class="num">{x.trades}</td>
					<td class="num">{pct(stats.total.trades ? x.trades / stats.total.trades : null, 0)}</td>
					<td class="num">{pct(x.trades ? x.wins / x.trades : null, 0)}</td>
					<td class="num {tone(x.pnl)}">{fmt(x.pnl, true)}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</section>
{/snippet}

{#snippet monthTable(st: typeof stats, title: string, current: string | null)}
	<section class="card">
		<div class="card-title">{title} · {unit}</div>
		<div class="table-wrap month-scroll">
			<table>
				<thead><tr><th>Monat</th><th class="num">Trades</th><th class="num">Brutto</th><th class="num">Gebühren</th><th class="num">Funding</th><th class="num">Netto</th></tr></thead>
				<tbody>
					{#each [...st.byMonth.entries()].reverse() as [m, b] (m)}
						<tr class:current={m === current}>
							<td><a href={`/futures?view=kalender&m=${m}&cur=${cur}`}>{MONTHS[Number(m.slice(5)) - 1]} {m.slice(0, 4)}</a></td>
							<td class="num">{b.trades}</td>
							<td class="num {tone(b.pnl)}">{fmt(b.pnl)}</td>
							<td class="num">{fmt(b.fees)}</td>
							<td class="num">{fmt(b.funding)}</td>
							<td class="num {tone(b.net)}">{fmt(b.net, true)}</td>
						</tr>
					{:else}
						<tr><td colspan="6" class="muted">Keine Futures-Buchungen.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/snippet}

<Zone title="Aktueller Stand" now at={live?.at ?? null}>
	<PositionsCard {live} error={liveError} />
</Zone>

<Zone title="Auswertung">
	{#snippet tools()}
		<div class="seg" role="group" aria-label="Ansicht">
			<button aria-pressed={view === 'kalender'} onclick={() => setParam('view', 'kalender')}>Kalender</button>
			<button aria-pressed={view === 'statistik'} onclick={() => setParam('view', 'statistik')}>Statistik</button>
		</div>
		{#if view === 'statistik'}
			<div class="seg" role="group" aria-label="Zeitraum">
				<button aria-pressed={period === 'monat'} onclick={() => setParam('p', 'monat')}>Monat</button>
				<button aria-pressed={period === 'jahr'} onclick={() => setParam('p', 'jahr')}>Jahr</button>
				<button aria-pressed={period === 'gesamt'} onclick={() => setParam('p', 'gesamt')}>Gesamt</button>
			</div>
			{#if period === 'jahr'}
				<select value={year} onchange={(e) => setParam('y', e.currentTarget.value)} aria-label="Jahr">
					{#each years as y (y)}<option value={y}>{y}</option>{/each}
				</select>
			{:else if period === 'monat'}
				<button class="ghost" onclick={() => shiftMonth(-1)} aria-label="Vormonat">‹</button>
				<span>{rangeLabel}</span>
				<button class="ghost" onclick={() => shiftMonth(1)} aria-label="Folgemonat">›</button>
			{/if}
		{/if}
	{/snippet}
{#if view === 'kalender'}
	<div class="cal-layout">
		<section class="card">
			<div class="cal-head">
				<button class="ghost" onclick={() => shiftMonth(-1)} aria-label="Vormonat">‹</button>
				<div class="cal-title">{MONTHS[Number(month.slice(5)) - 1]} {month.slice(0, 4)}</div>
				<button class="ghost" onclick={() => shiftMonth(1)} aria-label="Folgemonat">›</button>
				<span class="muted small cal-unit">Beträge in {unit}</span>
				<button class="ghost small" onclick={() => setParam('m', lastDay.slice(0, 7))}>Letzter Handelsmonat</button>
			</div>
			<div class="cal" style="grid-template-rows: auto repeat({weeks.length}, minmax(78px, 1fr))">
				{#each [...WEEKDAYS, 'Woche'] as w (w)}<div class="wd">{w}</div>{/each}
				{#each weeks as row, ri (ri)}
					{#each row.days as d, di (di)}
						{#if d}
							{@const b = monthStats.byDay.get(d)}
							{#if b}
								<a class="cell has {tone(b.net)}" class:today={d === today} href={`/futures/tag/${d}?cur=${cur}`}>
									<span class="dnum">{Number(d.slice(8))}</span>
									<span class="dval mono">{fmt(b.net, true)}</span>
									<span class="dsub">{b.trades ? `${b.trades} ${b.trades === 1 ? 'Trade' : 'Trades'}` : 'Funding/Gebühr'}</span>
								</a>
							{:else}
								<div class="cell" class:today={d === today}><span class="dnum">{Number(d.slice(8))}</span></div>
							{/if}
						{:else}
							<div class="cell blank"></div>
						{/if}
					{/each}
					<div class="cell week {row.sum ? tone(row.sum.net) : ''}">
						{#if row.sum}
							<span class="dval mono">{fmt(row.sum.net, true)}</span>
							<span class="dsub">{row.sum.trades ? `${row.sum.trades} ${row.sum.trades === 1 ? 'Trade' : 'Trades'}` : 'Funding/Gebühr'}</span>
						{/if}
					</div>
				{/each}
			</div>
		</section>

		<aside class="kpis side-kpis">
			<div class="kpi">
				<div class="label">Monat netto</div>
				<div class="value {tone(monthStats.total.net)}">{fmtU(monthStats.total.net, true)}</div>
				<div class="sub">Trades brutto {fmtU(monthStats.total.pnl, true)}</div>
			</div>
			<div class="kpi">
				<div class="label">Gebühren · Funding</div>
				<div class="value">{fmtU(monthStats.total.fees)}</div>
				<div class="sub">Funding {fmtU(monthStats.total.funding, true)}</div>
			</div>
			<div class="kpi">
				<div class="label">Trades · Trefferquote</div>
				<div class="value">{monthStats.total.trades} · {pct(monthStats.winPct, 0)}</div>
				<div class="sub">{monthStats.total.wins} Gewinner / {monthStats.total.losses} Verlierer</div>
			</div>
			<div class="kpi">
				<div class="label">Handelstage</div>
				<div class="value">{monthStats.days.win} / {monthStats.days.loss}</div>
				<div class="sub">mit Trades: Plus / Minus · Quote {pct(monthStats.days.total ? monthStats.days.win / monthStats.days.total : null, 0)}</div>
			</div>
			<div class="kpi">
				<div class="label">Ø je Trade netto</div>
				<div class="value {tone(monthStats.expectancy)}">{fmtU(monthStats.expectancy, true)}</div>
				<div class="sub">inkl. Gebühren und Funding</div>
			</div>
			<div class="kpi">
				<div class="label">Long / Short</div>
				<div class="value">{monthStats.byDir.long.trades} / {monthStats.byDir.short.trades}</div>
				<div class="sub">{fmt(monthStats.byDir.long.pnl, true)} / {fmtU(monthStats.byDir.short.pnl, true)}</div>
			</div>
			<div class="kpi">
				<div class="label">Profit-Faktor · Payoff</div>
				<div class="value">{ratio(monthStats.profitFactor)} · {ratio(monthStats.payoff)}</div>
				<div class="sub">Gewinne ÷ Verluste · Ø Gewinn ÷ Ø Verlust</div>
			</div>
			<div class="kpi kpi-now">
				<div class="label">Futures-Konto · aktuell</div>
				<div class="value">{live ? money(futEquity, 'USDT', { digits: 2 }) : '–'}</div>
				<div class="sub">{live ? `verfügbar ${money(futAvailable, 'USDT', { digits: 0 })} · unrealisiert ${money(futUnrealized, 'USDT', { sign: true, digits: 0 })}` : liveError ? 'nicht abrufbar' : 'lade …'}</div>
			</div>
		</aside>
	</div>

	<div class="grid-half block">
		<section class="card">
			<div class="card-title">Kumuliertes Ergebnis im Monat (netto, {unit})</div>
			{#if monthStats.cumulative.length > 1}
				<LineChart labels={monthStats.cumulative.map((c) => c.day.slice(8) + '.')} values={monthStats.cumulative.map((c) => c.value.toNumber())} format={fmtN} height={340} />
			{:else}
				<p class="muted small">Zu wenige Handelstage in diesem Monat für einen Verlauf.</p>
			{/if}
		</section>
		{@render monthTable(calYearStats, `Monate ${calYear}`, month)}
	</div>
{:else}
	<div class="kpis kpis-4">
		<div class="kpi"><div class="label">Ergebnis netto · {rangeLabel}</div><div class="value {tone(stats.total.net)}">{fmtU(stats.total.net, true)}</div><div class="sub">Trades brutto {fmtU(stats.total.pnl, true)}</div></div>
		<div class="kpi"><div class="label">Gebühren</div><div class="value">{fmtU(stats.total.fees)}</div><div class="sub">{pct(stats.feeShare, 0)} der Brutto-Gewinne</div></div>
		<div class="kpi"><div class="label">Funding</div><div class="value {tone(stats.total.funding)}">{fmtU(stats.total.funding, true)}</div><div class="sub">Sonstiges {fmtU(stats.total.other, true)}</div></div>
		<div class="kpi"><div class="label">Trades · Trefferquote</div><div class="value">{stats.total.trades} · {pct(stats.winPct, 0)}</div><div class="sub">{stats.total.wins} / {stats.total.losses}</div></div>
		<div class="kpi"><div class="label">Profit-Faktor · Payoff</div><div class="value">{ratio(stats.profitFactor)} · {ratio(stats.payoff)}</div><div class="sub">Brutto-Gewinne / -Verluste</div></div>
		<div class="kpi"><div class="label">Ø Gewinn · Ø Verlust</div><div class="value small-value"><span class="gain">{fmt(stats.avgWin, true)}</span> · <span class="loss">{fmtU(stats.avgLoss)}</span></div><div class="sub">Erwartung je Trade {fmtU(stats.expectancy, true)}</div></div>
		<div class="kpi"><div class="label">Serien</div><div class="value">{stats.streakWin} / {stats.streakLoss}</div><div class="sub">längste Gewinn- / Verlustserie</div></div>
		<div class="kpi"><div class="label">Max. Rückgang</div><div class="value loss">{fmtU(stats.maxDrawdown.neg())}</div><div class="sub">auf Tagesbasis, netto</div></div>
	</div>

	<div class="grid-half block">
		<section class="card">
			<div class="card-title">Kumuliertes Ergebnis (netto, {unit}) · {rangeLabel}</div>
			{#if stats.cumulative.length > 1}
				<LineChart labels={stats.cumulative.map((c) => c.day)} values={stats.cumulative.map((c) => c.value.toNumber())} format={fmtN} height={340} />
			{:else}
				<p class="muted small">Zu wenige Handelstage im Zeitraum für einen Verlauf.</p>
			{/if}
		</section>
		{#if period !== 'monat'}
			{@render monthTable(stats, 'Nach Monat', null)}
		{:else}
			{@render longShort()}
		{/if}
	</div>

	<div class="grid-3 block">
		{#if period !== 'monat'}{@render longShort()}{/if}


		<section class="card">
			<div class="card-title">Nach Wochentag (Trades, brutto, {unit})</div>
			<table>
				<thead><tr><th>Tag</th><th class="num">Trades</th><th class="num">Treffer</th><th class="num">Ergebnis</th><th style="width:30%"></th></tr></thead>
				<tbody>
					{#each stats.byWeekday as b, i (i)}
						<tr>
							<td>{WEEKDAYS[i]}</td>
							<td class="num">{b.trades}</td>
							<td class="num">{pct(b.wins + b.losses ? b.wins / (b.wins + b.losses) : null, 0)}</td>
							<td class="num {tone(b.pnl)}">{fmt(b.pnl, true)}</td>
							<td><div class="bar {tone(b.pnl)}" style="width:{(Math.abs(b.pnl.toNumber()) / mw) * 100}%"></div></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section class="card">
			<div class="card-title">Nach Uhrzeit (Schließzeitpunkt, deutsche Zeit, {unit})</div>
			<div class="table-wrap" style="max-height:360px;overflow-y:auto">
				<table>
					<thead><tr><th>Stunde</th><th class="num">Trades</th><th class="num">Treffer</th><th class="num">Ergebnis</th><th style="width:30%"></th></tr></thead>
					<tbody>
						{#each stats.byHour as b, h (h)}
							{#if b.trades}
								<tr>
									<td>{String(h).padStart(2, '0')}:00</td>
									<td class="num">{b.trades}</td>
									<td class="num">{pct(b.wins + b.losses ? b.wins / (b.wins + b.losses) : null, 0)}</td>
									<td class="num {tone(b.pnl)}">{fmt(b.pnl, true)}</td>
									<td><div class="bar {tone(b.pnl)}" style="width:{(Math.abs(b.pnl.toNumber()) / mh) * 100}%"></div></td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</div>

{/if}
</Zone>

<details class="card help">
	<summary>So sind die Zahlen zu lesen</summary>
	<ul class="small">
		<li><strong>Trade</strong> = ein Schließ-Ereignis mit realisiertem Ergebnis. Teilschließungen zählen einzeln.</li>
		<li><strong>Brutto</strong> = realisierte Ergebnisse ohne Gebühren und Funding, <strong>netto</strong> = alles zusammen.</li>
		<li><strong>Profit-Faktor</strong> = Summe Gewinne / Summe Verluste. <strong>Payoff</strong> = Ø Gewinn / Ø Verlust.</li>
		<li>Wochentag und Uhrzeit beziehen sich auf den Schließzeitpunkt. EUR über den EZB-Tageskurs.</li>
		<li>Symbol, Preise und Positionsgrößen gibt es in der Tagesansicht für Trades ab ca. September 2025.</li>
	</ul>
</details>

<style>
	.kpis-4 {
		grid-template-columns: repeat(4, minmax(0, 1fr));
	}
	@media (max-width: 900px) {
		.kpis-4 {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.cal-layout {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		align-items: stretch;
	}
	.cal-layout > .card {
		display: flex;
		flex-direction: column;
	}
	.cal-layout .cal {
		flex: 1;
	}
	.kpi-now {
		background: color-mix(in srgb, var(--accent-soft) 70%, var(--surface));
	}
	.grid-3 {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 16px;
	}
	.month-scroll {
		max-height: 360px;
		overflow-y: auto;
	}
	tr.current td {
		background: var(--accent-soft);
	}
	.side-kpis {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-template-rows: repeat(4, 1fr);
		grid-auto-flow: column;
	}
	.cal-head {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
	}
	.cal-unit {
		margin-left: auto;
	}
	.cal-head button.small {
		margin-left: 4px;
	}
	.cal-title {
		font-weight: 600;
		font-size: 1.05rem;
		min-width: 150px;
		text-align: center;
	}
	.cal-head .small {
		margin-left: auto;
	}
	.cal {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr)) minmax(0, 1.1fr);
		gap: 6px;
	}
	.wd {
		font-size: 0.75rem;
		color: var(--muted);
		text-align: center;
		padding-bottom: 2px;
	}
	.cell {
		min-height: 78px;
		border: 1px solid var(--border);
		border-radius: 9px;
		padding: 6px 8px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: var(--surface-2);
		color: var(--text);
		text-decoration: none;
	}
	.cell.blank {
		border-style: dashed;
		background: transparent;
		opacity: 0.4;
	}
	.cell.has {
		cursor: pointer;
	}
	.cell.has:hover {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
	.cell.gain {
		background: var(--gain-bg);
	}
	.cell.loss {
		background: var(--loss-bg);
	}
	.cell.today {
		border-color: var(--accent);
	}
	.cell.week {
		background: var(--surface);
		justify-content: center;
		align-items: flex-end;
	}
	.dnum {
		font-size: 0.75rem;
		color: var(--muted);
	}
	.dval {
		font-size: 0.85rem;
		font-weight: 600;
		margin-top: auto;
	}
	.cell.gain .dval {
		color: var(--gain);
	}
	.cell.loss .dval {
		color: var(--loss);
	}
	.dsub {
		font-size: 0.7rem;
		color: var(--muted);
	}
	.small-value {
		font-size: 1.05rem;
	}
	.bar {
		height: 8px;
		border-radius: 4px;
		background: var(--muted);
	}
	.bar.gain {
		background: var(--gain);
	}
	.bar.loss {
		background: var(--loss);
	}
	.help {
		margin-top: 16px;
	}
	.help summary {
		cursor: pointer;
		font-weight: 600;
	}
	@media (max-width: 1100px) {
		.cal-layout {
			grid-template-columns: 1fr;
		}
		.side-kpis {
			grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
			grid-template-rows: none;
			grid-auto-flow: row;
		}
	}
	@media (max-width: 640px) {
		.cell {
			min-height: 54px;
			padding: 4px;
		}
		.dsub {
			display: none;
		}
		.dval {
			font-size: 0.7rem;
		}
	}
</style>
