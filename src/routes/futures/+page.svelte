<script lang="ts">
	import Decimal from 'decimal.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import LineChart from '$lib/components/LineChart.svelte';
	import { futuresEvents, futuresStats, inRange, type Bucket, type Currency } from '$lib/analysis/futures';
	import { MONTHS, WEEKDAYS, money, pct, ratio, tone } from '$lib/format';
	import { FxTable } from '$lib/tax/fx';

	let { data } = $props();

	const fx = $derived(new FxTable(data.fx));
	const events = $derived(futuresEvents(data.ledger, fx));
	const lastDay = $derived(events.length ? events[events.length - 1]!.day : new Date().toISOString().slice(0, 10));

	// Zustand in der URL, damit Zurück/Lesezeichen funktionieren
	const view = $derived(page.url.searchParams.get('view') === 'statistik' ? 'statistik' : 'kalender');
	const cur = $derived<Currency>(page.url.searchParams.get('cur') === 'EUR' ? 'EUR' : 'USDT');
	const month = $derived(page.url.searchParams.get('m') ?? lastDay.slice(0, 7));
	const period = $derived((page.url.searchParams.get('p') as 'monat' | 'jahr' | 'gesamt' | null) ?? 'jahr');

	function setParam(k: string, v: string) {
		const u = new URL(page.url);
		u.searchParams.set(k, v);
		goto(u, { replaceState: true, noScroll: true, keepFocus: true });
	}

	function shiftMonth(delta: number) {
		const [y, m] = month.split('-').map(Number) as [number, number];
		const d = new Date(Date.UTC(y, m - 1 + delta, 1));
		setParam('m', d.toISOString().slice(0, 7));
	}

	const fmt = (d: Decimal | null, sign = false) => money(d, cur, { sign, unit: false });
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
</script>

<div class="page-head">
	<h1>Futures</h1>
	<div class="toolbar">
		<div class="seg" role="group" aria-label="Ansicht">
			<button aria-pressed={view === 'kalender'} onclick={() => setParam('view', 'kalender')}>Kalender</button>
			<button aria-pressed={view === 'statistik'} onclick={() => setParam('view', 'statistik')}>Statistik</button>
		</div>
		<div class="seg" role="group" aria-label="Währung">
			<button aria-pressed={cur === 'USDT'} onclick={() => setParam('cur', 'USDT')}>USDT</button>
			<button aria-pressed={cur === 'EUR'} onclick={() => setParam('cur', 'EUR')}>EUR</button>
		</div>
	</div>
</div>

{#if data.loadError}<p class="error">{data.loadError}</p>{/if}

{#if view === 'kalender'}
	<div class="cal-layout">
		<section class="card">
			<div class="cal-head">
				<button class="ghost" onclick={() => shiftMonth(-1)} aria-label="Vormonat">‹</button>
				<div class="cal-title">{MONTHS[Number(month.slice(5)) - 1]} {month.slice(0, 4)}</div>
				<button class="ghost" onclick={() => shiftMonth(1)} aria-label="Folgemonat">›</button>
				<button class="ghost small" onclick={() => setParam('m', lastDay.slice(0, 7))}>Letzter Handelsmonat</button>
			</div>
			<div class="cal">
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
				<div class="value {tone(monthStats.total.net)}">{fmt(monthStats.total.net, true)}</div>
				<div class="sub">Trades brutto {fmt(monthStats.total.pnl, true)}</div>
			</div>
			<div class="kpi">
				<div class="label">Gebühren · Funding</div>
				<div class="value">{fmt(monthStats.total.fees)}</div>
				<div class="sub">Funding {fmt(monthStats.total.funding, true)}</div>
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
				<div class="value {tone(monthStats.expectancy)}">{fmt(monthStats.expectancy, true)}</div>
				<div class="sub">inkl. Gebühren und Funding</div>
			</div>
			<div class="kpi">
				<div class="label">Long / Short</div>
				<div class="value">{monthStats.byDir.long.trades} / {monthStats.byDir.short.trades}</div>
				<div class="sub">{fmt(monthStats.byDir.long.pnl, true)} / {fmt(monthStats.byDir.short.pnl, true)}</div>
			</div>
		</aside>
	</div>

	{#if monthStats.cumulative.length > 1}
		<section class="card" style="margin-top:16px">
			<div class="card-title">Kumuliertes Ergebnis im Monat (netto)</div>
			<LineChart labels={monthStats.cumulative.map((c) => c.day.slice(8) + '.')} values={monthStats.cumulative.map((c) => c.value.toNumber())} format={fmtN} />
		</section>
	{/if}
{:else}
	<div class="toolbar" style="margin-bottom:16px">
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
	</div>

	<div class="kpis">
		<div class="kpi"><div class="label">Ergebnis netto · {rangeLabel}</div><div class="value {tone(stats.total.net)}">{fmt(stats.total.net, true)}</div><div class="sub">Trades brutto {fmt(stats.total.pnl, true)}</div></div>
		<div class="kpi"><div class="label">Gebühren</div><div class="value">{fmt(stats.total.fees)}</div><div class="sub">{pct(stats.feeShare, 0)} der Brutto-Gewinne</div></div>
		<div class="kpi"><div class="label">Funding</div><div class="value {tone(stats.total.funding)}">{fmt(stats.total.funding, true)}</div><div class="sub">Sonstiges {fmt(stats.total.other, true)}</div></div>
		<div class="kpi"><div class="label">Trades · Trefferquote</div><div class="value">{stats.total.trades} · {pct(stats.winPct, 0)}</div><div class="sub">{stats.total.wins} / {stats.total.losses}</div></div>
		<div class="kpi"><div class="label">Profit-Faktor · Payoff</div><div class="value">{ratio(stats.profitFactor)} · {ratio(stats.payoff)}</div><div class="sub">Brutto-Gewinne / -Verluste</div></div>
		<div class="kpi"><div class="label">Ø Gewinn · Ø Verlust</div><div class="value small-value"><span class="gain">{fmt(stats.avgWin, true)}</span> · <span class="loss">{fmt(stats.avgLoss)}</span></div><div class="sub">Erwartung je Trade {fmt(stats.expectancy, true)}</div></div>
		<div class="kpi"><div class="label">Serien</div><div class="value">{stats.streakWin} / {stats.streakLoss}</div><div class="sub">längste Gewinn- / Verlustserie</div></div>
		<div class="kpi"><div class="label">Max. Rückgang</div><div class="value loss">{fmt(stats.maxDrawdown.neg())}</div><div class="sub">auf Tagesbasis, netto</div></div>
	</div>

	{#if stats.cumulative.length > 1}
		<section class="card" style="margin-top:16px">
			<div class="card-title">Kumuliertes Ergebnis (netto)</div>
			<LineChart labels={stats.cumulative.map((c) => c.day)} values={stats.cumulative.map((c) => c.value.toNumber())} format={fmtN} height={260} />
		</section>
	{/if}

	<div class="grid-2" style="margin-top:16px">
		<section class="card">
			<div class="card-title">Long vs. Short</div>
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

		{#if period !== 'monat'}
			<section class="card">
				<div class="card-title">Nach Monat</div>
				<div class="table-wrap" style="max-height:260px;overflow-y:auto">
					<table>
						<thead><tr><th>Monat</th><th class="num">Trades</th><th class="num">Brutto</th><th class="num">Gebühren</th><th class="num">Funding</th><th class="num">Netto</th></tr></thead>
						<tbody>
							{#each [...stats.byMonth.entries()].reverse() as [m, b] (m)}
								<tr>
									<td><a href={`/futures?view=kalender&m=${m}&cur=${cur}`}>{m}</a></td>
									<td class="num">{b.trades}</td>
									<td class="num {tone(b.pnl)}">{fmt(b.pnl)}</td>
									<td class="num">{fmt(b.fees)}</td>
									<td class="num">{fmt(b.funding)}</td>
									<td class="num {tone(b.net)}">{fmt(b.net, true)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}

		<section class="card">
			<div class="card-title">Nach Wochentag (Trades, brutto)</div>
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
			<div class="card-title">Nach Uhrzeit (Schließzeitpunkt, deutsche Zeit)</div>
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
{/if}

<style>
	.cal-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 16px;
		align-items: start;
	}
	.side-kpis {
		grid-template-columns: 1fr;
	}
	.cal-head {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
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
