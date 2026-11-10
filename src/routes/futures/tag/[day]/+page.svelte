<script lang="ts">
	import Decimal from 'decimal.js';
	import { page } from '$app/state';
	import LineChart from '$lib/components/LineChart.svelte';
	import { futuresEvents, futuresStats, inRange, type Currency } from '$lib/analysis/futures';
	import { dayLabel, money, pct, qty, tone } from '$lib/format';
	import { FxTable } from '$lib/tax/fx';

	let { data } = $props();

	const cur = $derived<Currency>(page.url.searchParams.get('cur') === 'EUR' ? 'EUR' : 'USDT');
	const fx = $derived(new FxTable(data.fx));
	const all = $derived(futuresEvents(data.ledger, fx));
	const events = $derived(inRange(all, data.day, data.day));
	const s = $derived(futuresStats(events, cur));

	// Nachbartage mit Futures-Buchungen
	const days = $derived([...new Set(all.map((e) => e.day))]);
	const idx = $derived(days.indexOf(data.day));
	const prev = $derived(idx > 0 ? days[idx - 1] : null);
	const next = $derived(idx >= 0 && idx < days.length - 1 ? days[idx + 1] : null);

	const fmt = (d: Decimal | null, sign = false) => money(d, cur, { sign, unit: false });
	const time = (ts: string) =>
		/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts)
			? new Date(ts).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })
			: ts.slice(11, 19);
	const KIND = { pnl: 'Ergebnis', fee: 'Gebühr', funding: 'Funding', other: 'Sonstiges' } as const;

	const intraday = $derived.by(() => {
		let run = new Decimal(0);
		return events.map((e) => {
			run = run.add(cur === 'USDT' ? e.usdt : (e.eur ?? 0));
			return { t: time(e.ts).slice(0, 5), v: run.toNumber() };
		});
	});

	const fillDir = (f: { side: string; tradeSide: string }) =>
		`${f.tradeSide === 'open' ? 'Eröffnen' : f.tradeSide === 'close' ? 'Schließen' : f.tradeSide} ${f.side === 'buy' ? 'Long' : 'Short'}`;
	const fillFee = (f: { feeDetail?: { totalFee: string }[] }) =>
		(f.feeDetail ?? []).reduce((a, x) => a.add(x.totalFee || 0), new Decimal(0));
	const fillSum = $derived.by(() => {
		let fee = new Decimal(0);
		let taker = 0;
		for (const f of data.fills) {
			fee = fee.add(fillFee(f));
			if (f.tradeScope === 'taker') taker++;
		}
		return { fee, taker, n: data.fills.length };
	});
</script>

<div class="page-head">
	<div>
		<a class="small" href={`/futures?view=kalender&m=${data.day.slice(0, 7)}&cur=${cur}`}>← Kalender</a>
		<h1 style="margin-top:4px">{dayLabel(data.day)}</h1>
	</div>
	<div class="toolbar">
		{#if prev}<a class="nav-btn" href={`/futures/tag/${prev}?cur=${cur}`}>‹ {prev}</a>{/if}
		{#if next}<a class="nav-btn" href={`/futures/tag/${next}?cur=${cur}`}>{next} ›</a>{/if}
	</div>
</div>

<div class="kpis">
	<div class="kpi"><div class="label">Tag netto</div><div class="value {tone(s.total.net)}">{fmt(s.total.net, true)}</div><div class="sub">Trades brutto {fmt(s.total.pnl, true)}</div></div>
	<div class="kpi"><div class="label">Trades · Treffer</div><div class="value">{s.total.trades} · {pct(s.winPct, 0)}</div><div class="sub">{s.total.wins} / {s.total.losses}</div></div>
	<div class="kpi"><div class="label">Brutto-Gewinne · -Verluste</div><div class="value small-value"><span class="gain">{fmt(s.grossWin)}</span> · <span class="loss">{fmt(s.grossLoss)}</span></div></div>
	<div class="kpi"><div class="label">Gebühren · Funding</div><div class="value">{fmt(s.total.fees)}</div><div class="sub">Funding {fmt(s.total.funding, true)}</div></div>
</div>

{#if intraday.length > 1}
	<section class="card" style="margin-top:16px">
		<div class="card-title">Kumuliert im Tagesverlauf (netto)</div>
		<LineChart labels={intraday.map((p) => p.t)} values={intraday.map((p) => p.v)} height={200} />
	</section>
{/if}

<section class="card" style="margin-top:16px">
	<div class="card-title">Buchungen</div>
	<div class="table-wrap">
		<table>
			<thead><tr><th>Zeit</th><th>Art</th><th>Richtung</th><th>Kommentar</th><th class="num">Betrag</th></tr></thead>
			<tbody>
				{#each events as e (e.txId)}
					<tr>
						<td class="mono">{time(e.ts)}</td>
						<td>{KIND[e.kind]}</td>
						<td>{e.dir === 'long' ? 'Long' : e.dir === 'short' ? 'Short' : ''}</td>
						<td class="muted small">{e.comment.replace(/^api:/, '')}</td>
						<td class="num {tone(e.usdt)}">{fmt(cur === 'USDT' ? e.usdt : e.eur, true)}</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="muted">Keine Futures-Buchungen an diesem Tag.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<section class="card" style="margin-top:16px">
	<div class="card-title">Ausführungen (Bitget-Fills, USDT)</div>
	{#if data.fillsError}<p class="error">{data.fillsError}</p>{/if}
	{#if data.fills.length}
		<p class="small muted">
			{fillSum.n} Ausführungen, davon {fillSum.taker} als Taker · Gebühren laut Fills {qty(fillSum.fee, 4)} USDT
		</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Zeit</th><th>Symbol</th><th>Aktion</th><th class="num">Preis</th><th class="num">Menge</th><th class="num">Volumen</th><th class="num">Ergebnis</th><th class="num">Gebühr</th><th>Typ</th></tr></thead>
				<tbody>
					{#each data.fills as f (f.tradeId)}
						<tr>
							<td class="mono">{new Date(Number(f.cTime)).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}</td>
							<td>{f.symbol}</td>
							<td>{fillDir(f)}</td>
							<td class="num">{qty(new Decimal(f.price), 6)}</td>
							<td class="num">{qty(new Decimal(f.baseVolume), 6)}</td>
							<td class="num">{qty(new Decimal(f.quoteVolume), 2)}</td>
							<td class="num {tone(new Decimal(f.profit || 0))}">{Number(f.profit) ? qty(new Decimal(f.profit), 4) : ''}</td>
							<td class="num">{qty(fillFee(f), 4)}</td>
							<td class={f.tradeScope === 'taker' ? 'loss small' : 'gain small'}>{f.tradeScope === 'taker' ? 'Taker' : f.tradeScope === 'maker' ? 'Maker' : (f.tradeScope ?? '')}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="small muted">Keine Ausführungsdetails für diesen Tag. Die Bitget-Fills reichen etwa ein Jahr zurück; ältere Tage haben nur die Buchungen oben.</p>
	{/if}
</section>

<style>
	.nav-btn {
		padding: 7px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		text-decoration: none;
		color: var(--text);
		background: var(--surface);
		font-size: 0.9rem;
	}
	.small-value {
		font-size: 1.05rem;
	}
</style>
