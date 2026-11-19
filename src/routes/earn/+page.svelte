<script lang="ts">
	import Decimal from 'decimal.js';
	import BarChart from '#lib/components/BarChart.svelte';
	import { EARN_KIND_LABEL, earnEvents, realizedApr, summarizeEarn, type EarnKind } from '#lib/analysis/earn.ts';
	import { buildPortfolio } from '#lib/analysis/portfolio.ts';
	import { MONTHS, money, pct, qty, type Cur } from '#lib/format.ts';
	import { FxTable } from '#lib/tax/fx.ts';

	import BrokerSelect from '#lib/components/BrokerSelect.svelte';
	import { brokerHas, brokerState, ledgerFor, liveFor } from '#lib/broker.svelte.ts';
	import { earnPositions } from '#lib/analysis/earn-positions.ts';
	import { onChainNet } from '#lib/analysis/reconcile.ts';

	let { data } = $props();

	const hasKucoin = $derived(!!data.kucoin || (data.ledger?.sources.kucoin ?? 0) > 0);
	const broker = $derived(hasKucoin ? brokerState.value : 'Bitget');
	const live = $derived(liveFor(broker, data.live, data.kucoin));

	const today = new Date().toISOString().slice(0, 10);
	const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

	let period = $state<string>('30');
	let cur = $state<Cur>('EUR');

	const fx = $derived(new FxTable(data.ledger?.fx ?? []));
	const eurPerUsdt = $derived.by(() => {
		const r = fx.last ? fx.rateFor(fx.last) : null;
		return r ? new Decimal(1).div(r.rate) : null;
	});
	const conv = (usdt: Decimal | null) => (usdt === null ? null : cur === 'USDT' ? usdt : eurPerUsdt ? usdt.mul(eurPerUsdt) : null);
	const fmt = (usdt: Decimal | null, sign = false) => money(conv(usdt), cur, { sign });

	const events = $derived(data.ledger ? earnEvents(ledgerFor(broker, data.ledger.ledger)) : []);
	const years = $derived([...new Set(events.map((e) => e.day.slice(0, 4)))].sort().reverse());

	// heutige Kurse (USDT je Coin)
	const prices = $derived.by(() => {
		const out: Record<string, Decimal> = {};
		if (live?.tickers.ok) for (const [c, p] of Object.entries(live.tickers.data)) out[c] = new Decimal(p);
		return out;
	});

	const range = $derived.by((): [string, string, number] => {
		if (period === '30') return [daysAgo(29), today, 30];
		if (period === 'gesamt') {
			const first = events[0]?.day ?? today;
			return [first, today, Math.max(1, Math.round((Date.parse(today) - Date.parse(first)) / 86_400_000) + 1)];
		}
		const end = period === today.slice(0, 4) ? today : `${period}-12-31`;
		return [`${period}-01-01`, end, Math.round((Date.parse(end) - Date.parse(`${period}-01-01`)) / 86_400_000) + 1];
	});
	const s = $derived(summarizeEarn(events, range[0], range[1], prices));
	const last30 = $derived(summarizeEarn(events, daysAgo(29), today, prices));
	const last30ByCoin = $derived(new Map(last30.byCoin.map((c) => [c.coin, c])));

	// aktuelle Earn-Bestände (live) und APY laut Börse
	const holdings = $derived(live ? buildPortfolio(live, eurPerUsdt, [], new Set(['earn'] as const)) : null);
	const holdingByCoin = $derived(new Map((holdings?.rows ?? []).map((r) => [r.coin, r])));
	const apyByCoin = $derived.by(() => {
		const m = new Map<string, string>();
		if (!live) return m;
		for (const sec of [live.earnFlex, live.earnFixed]) if (sec.ok) for (const e of sec.data) if (e.apy && !m.has(e.coin)) m.set(e.coin, e.apy);
		if (live.elite?.ok) for (const e of live.elite.data) if (e.apr && !m.has(e.coin)) m.set(e.coin, e.apr);
		return m;
	});

	// Coins: Erträge im Zeitraum, ergänzt um gehaltene Coins ohne Erträge
	const coins = $derived.by(() => {
		const list = s.byCoin.map((c) => c.coin);
		for (const r of holdings?.rows ?? []) if (!list.includes(r.coin) && (r.valueUsdt?.gte(1) ?? false)) list.push(r.coin);
		return list;
	});

	const perDay = $derived(s.totalUsdt.div(range[2]));
	const realized30Total = $derived(
		holdings && !holdings.totalUsdt.isZero() ? last30.totalUsdt.div(holdings.totalUsdt).mul(365).div(30).toNumber() : null
	);
	const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]!.slice(0, 3)} ${m.slice(2, 4)}`;
	const fmtAxis = (v: number) => (cur === 'EUR' ? `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : v.toLocaleString('de-DE', { maximumFractionDigits: 0 }));
	const KINDS: EarnKind[] = ['zinsen', 'airdrop', 'bonus'];

	// Aktuelle Earn- und Staking-Positionen (live); On-Chain-Staking ohne Live-Daten aus den Bitget-Buchungen
	const positions = $derived(
		earnPositions(live, data.ledger && brokerHas(broker, 'bitget') ? onChainNet(data.ledger.ledger) : new Map()).filter(
			(p) => p.valueUsdt === null || p.valueUsdt.gte(0.5)
		)
	);
	const positionsTotal = $derived(positions.reduce((s, p) => s.add(p.valueUsdt ?? 0), new Decimal(0)));
	const dateDe = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('de-DE') : '');
	const VNAME = { bitget: 'Bitget', kucoin: 'KuCoin' } as const;
</script>

<div class="page-head">
	<h1>Earn</h1>
	<div class="toolbar">
		<BrokerSelect show={hasKucoin} />
		<div class="seg" role="group" aria-label="Zeitraum">
			<button aria-pressed={period === '30'} onclick={() => (period = '30')}>30 Tage</button>
			{#each years as y (y)}<button aria-pressed={period === y} onclick={() => (period = y)}>{y}</button>{/each}
			<button aria-pressed={period === 'gesamt'} onclick={() => (period = 'gesamt')}>Gesamt</button>
		</div>
		<div class="seg" role="group" aria-label="Währung">
			<button aria-pressed={cur === 'EUR'} onclick={() => (cur = 'EUR')}>EUR</button>
			<button aria-pressed={cur === 'USDT'} onclick={() => (cur = 'USDT')}>USDT</button>
		</div>
	</div>
</div>

{#if data.ledgerError}<p class="error">{data.ledgerError}</p>{/if}
{#if broker !== 'KuCoin' && data.liveError}<p class="error small">Bitget nicht erreichbar: {data.liveError}</p>{/if}
{#if broker !== 'Bitget' && data.kucoinError}<p class="error small">KuCoin nicht erreichbar: {data.kucoinError}</p>{/if}

<div class="kpis">
	<div class="kpi">
		<div class="label">Erträge im Zeitraum</div>
		<div class="value gain">{fmt(s.totalUsdt, true)}</div>
		<div class="sub">{s.bookings.toLocaleString('de-DE')} Gutschriften · zum heutigen Kurs</div>
	</div>
	<div class="kpi">
		<div class="label">Ø pro Tag</div>
		<div class="value">{fmt(perDay)}</div>
		<div class="sub">≈ {fmt(perDay.mul(30))} im Monat</div>
	</div>
	<div class="kpi">
		<div class="label">Earn-Bestand jetzt</div>
		<div class="value">{fmt(holdings?.totalUsdt ?? null)}</div>
		<div class="sub">{holdings?.rows.length ?? 0} Positionen</div>
	</div>
	<div class="kpi">
		<div class="label">Rendite der letzten 30 Tage</div>
		<div class="value">{pct(realized30Total)}</div>
		<div class="sub">p. a., Erträge ÷ heutiger Bestand</div>
	</div>
</div>

<section class="card" style="margin-top:16px">
	<div class="card-title">Aktuelle Earn- und Staking-Positionen</div>
	{#if !live}
		<p class="muted small">Keine Live-Daten.</p>
	{:else if !positions.length}
		<p class="muted small">Derzeit nichts im Earn oder Staking.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						{#if broker === 'Alle'}<th>Börse</th>{/if}
						<th>Coin</th>
						<th>Produkt</th>
						<th class="num">Menge</th>
						<th class="num">Wert</th>
						<th class="num">Zins p. a.</th>
						<th class="num">Ertrag bisher</th>
						<th>seit</th>
						<th>bis</th>
					</tr>
				</thead>
				<tbody>
					{#each positions as p, i (i)}
						<tr>
							{#if broker === 'Alle'}<td class="small">{VNAME[p.venue]}</td>{/if}
							<td><strong>{p.coin}</strong></td>
							<td class="small">{p.product}{#if p.note}<br /><span class="muted">{p.note}</span>{/if}</td>
							<td class="num">{qty(p.qty, 6)}</td>
							<td class="num">{fmt(p.valueUsdt)}</td>
							<td class="num">{p.apy !== null ? `${p.apy.toLocaleString('de-DE', { maximumFractionDigits: 2 })} %` : ''}</td>
							<td class="num gain">{p.profit && !p.profit.isZero() ? `${qty(p.profit, 6)} ${p.coin}` : ''}</td>
							<td class="small">{dateDe(p.start)}</td>
							<td class="small">{dateDe(p.end)}</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<td colspan={broker === 'Alle' ? 4 : 3}><strong>Summe</strong></td>
						<td class="num"><strong>{fmt(positionsTotal)}</strong></td>
						<td colspan="4"></td>
					</tr>
				</tfoot>
			</table>
		</div>
		<p class="small muted">
			Live von {broker === 'Alle' ? 'Bitget und KuCoin' : broker}, bewertet zum aktuellen Kurs. Zinssatz, Laufzeit und bisheriger Ertrag, soweit die Börse sie liefert;
			bei festen Bitget-Produkten ist das Enddatum aus Laufzeit und Haltedauer berechnet. Positionen unter 0,50 USDT ausgeblendet.
		</p>
	{/if}
</section>

{#if s.byMonth.length > 1}
	<section class="card" style="margin-top:16px">
		<div class="card-title">Erträge je Monat (zum heutigen Kurs)</div>
		<BarChart labels={s.byMonth.map((m) => monthLabel(m.month))} values={s.byMonth.map((m) => conv(m.valueUsdt)?.toNumber() ?? 0)} format={fmtAxis} />
	</section>
{/if}

<section class="card" style="margin-top:16px">
	<div class="card-title">Coins</div>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>Coin</th>
					<th class="num">Erträge (Menge)</th>
					<th class="num">Wert heute</th>
					<th class="num">Anteil</th>
					<th class="num">Gutschriften</th>
					<th class="num">Earn-Bestand</th>
					<th class="num">Rendite 30 T. p. a.</th>
					<th class="num">APY laut Börse</th>
				</tr>
			</thead>
			<tbody>
				{#each coins as coin (coin)}
					{@const c = s.byCoin.find((x) => x.coin === coin)}
					{@const h = holdingByCoin.get(coin)}
					{@const l30 = last30ByCoin.get(coin)}
					{@const apr = h && l30 ? realizedApr(l30.qty, h.qty, 30) : null}
					{@const apy = apyByCoin.get(coin)}
					<tr>
						<td><strong>{coin}</strong></td>
						<td class="num">{c ? qty(c.qty, 6) : '–'}</td>
						<td class="num gain">{c ? fmt(c.valueUsdt) : '–'}</td>
						<td class="num muted">{c?.valueUsdt && !s.totalUsdt.isZero() ? pct(c.valueUsdt.div(s.totalUsdt).toNumber()) : ''}</td>
						<td class="num muted">{c ? c.bookings.toLocaleString('de-DE') : ''}</td>
						<td class="num">{h ? qty(h.qty, 6) : ''}</td>
						<td class="num">{pct(apr, 2)}</td>
						<td class="num muted">{apy ? `${Number(apy).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %` : ''}</td>
					</tr>
				{:else}
					<tr><td colspan="8" class="muted">Keine Erträge im Zeitraum.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if s.unpricedCoins.length}<p class="small muted">Ohne aktuellen Kurs (nicht im Wert enthalten): {s.unpricedCoins.join(', ')}</p>{/if}
</section>

<div class="grid-2" style="margin-top:16px">
	<section class="card">
		<div class="card-title">Nach Art</div>
		<table>
			<tbody>
				{#each KINDS as k (k)}
					<tr>
						<td>{EARN_KIND_LABEL[k]}</td>
						<td class="num">{fmt(s.byKind[k])}</td>
						<td class="num muted">{!s.totalUsdt.isZero() ? pct(s.byKind[k].div(s.totalUsdt).toNumber(), 0) : ''}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section class="card">
		<div class="card-title">So sind die Zahlen zu lesen</div>
		<ul class="small muted">
			<li>Erträge sind alle Earn-Gutschriften (Zinsen, Staking, Airdrops, Boni) aus CoinTracking und dem täglichen Abruf von Bitget und KuCoin.</li>
			<li>Bewertet wird mit dem <strong>heutigen</strong> Kurs. Der Wert am Tag des Zuflusses – maßgeblich für die Steuer – folgt mit den Tageskursen.</li>
			<li>Die Rendite der letzten 30 Tage teilt die Erträge durch den heutigen Bestand; wurde im Zeitraum viel ein- oder ausgezahlt, ist sie nur eine Näherung.</li>
		</ul>
	</section>
</div>
