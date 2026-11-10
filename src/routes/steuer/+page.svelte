<script lang="ts">
	import Decimal from 'decimal.js';
	import { invalidate } from '$app/navigation';
	import { computeTax, type DisposalStatus, type WarningKind } from '$lib/tax/engine';
	import { FxTable } from '$lib/tax/fx';
	import { download, kapCsv, soCsv } from '$lib/tax/csv';

	let { data } = $props();

	const thisYear = new Date().getFullYear();
	const years = Array.from({ length: Math.max(1, thisYear - 2026 + 1) }, (_, i) => 2026 + i);
	let year = $state(Math.max(2026, thisYear));

	const fx = $derived(new FxTable(data.fx));
	const result = $derived(fx.size && data.ledger.length ? computeTax(data.ledger, fx, year) : null);

	let fxBusy = $state(false);
	let fxMsg = $state('');
	async function refreshFx() {
		fxBusy = true;
		fxMsg = '';
		try {
			const res = await fetch('/api/fx/refresh', { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
			fxMsg = `${body.count} Kurse geladen (${body.first} bis ${body.last}).`;
			await invalidate('app:steuer');
		} catch (e) {
			fxMsg = `Fehler: ${(e as Error).message}`;
		}
		fxBusy = false;
	}

	const eur = (d: Decimal | null) =>
		d === null ? '–' : d.toNumber().toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
	const num = (d: Decimal, digits = 8) =>
		d.toNumber().toLocaleString('de-DE', { maximumFractionDigits: digits });
	const sign = (d: Decimal | null) => (d === null || d.isZero() ? '' : d.isNeg() ? 'loss' : 'gain');

	const FREIGRENZE_SO = new Decimal(1000);

	const months = $derived.by(() => {
		if (!result) return [];
		const m = new Map<string, { gains: Decimal; losses: Decimal; fees: Decimal; funding: Decimal; other: Decimal }>();
		for (const k of result.kap) {
			const key = k.day.slice(0, 7);
			const r = m.get(key) ?? { gains: new Decimal(0), losses: new Decimal(0), fees: new Decimal(0), funding: new Decimal(0), other: new Decimal(0) };
			const v = k.eur ?? new Decimal(0);
			if (k.category === 'kap_pnl') {
				if (v.gt(0)) r.gains = r.gains.add(v);
				else r.losses = r.losses.add(v);
			} else if (k.category === 'kap_fee') r.fees = r.fees.add(v);
			else if (k.category === 'kap_funding') r.funding = r.funding.add(v);
			else r.other = r.other.add(v);
			m.set(key, r);
		}
		return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
	});

	const STATUS: Record<DisposalStatus, string> = {
		ok: 'OK',
		geschaetzt: 'Kosten geschätzt',
		kosten_unbekannt: 'Kosten fehlen',
		fehlbestand: 'Fehlbestand',
		unbewertet: 'EUR-Wert fehlt'
	};

	const WARN: Record<WarningKind, string> = {
		fx_missing: 'EZB-Kurs fehlt',
		trade_unvalued: 'Tausch ohne EUR-Wert',
		fee_other_currency: 'Gebühr in dritter Währung',
		external_in: 'Einzahlung von außen',
		external_out: 'Auszahlung nach außen',
		other_out: 'Sonstiger Abgang',
		consume_shortfall: 'Abgang ohne Bestand',
		kap_non_usd: 'Futures nicht in USDT/USDC',
		unknown_category: 'Buchungsart unbekannt'
	};

	const warnGroups = $derived.by(() => {
		if (!result) return [];
		const g = new Map<WarningKind, typeof result.warnings>();
		for (const w of result.warnings) g.set(w.kind, [...(g.get(w.kind) ?? []), w]);
		return [...g.entries()];
	});

	let showAllDisposals = $state(false);
	const disposalsShown = $derived(
		!result ? [] : showAllDisposals ? result.disposals : result.disposals.filter((d) => d.asset !== 'USDT' || d.status !== 'ok' || !d.gainTaxable.isZero())
	);
</script>

<div class="head">
	<h1>Steuer</h1>
	<select bind:value={year} aria-label="Steuerjahr">
		{#each years as y (y)}<option value={y}>{y}</option>{/each}
	</select>
</div>

{#if data.loadError}
	<p class="error">{data.loadError}</p>
{/if}

<div class="card fxbar">
	<div>
		{#if fx.size}
			EZB-Kurse vorhanden vom {fx.first} bis {fx.last}
		{:else}
			<strong>Noch keine EZB-Kurse geladen.</strong> Ohne Kurse lassen sich USDT-Beträge nicht in Euro umrechnen.
		{/if}
		{#if fxMsg}<div class={fxMsg.startsWith('Fehler') ? 'error' : 'muted'}>{fxMsg}</div>{/if}
	</div>
	<button onclick={refreshFx} disabled={fxBusy}>{fxBusy ? 'Lade …' : 'EZB-Kurse aktualisieren'}</button>
</div>

{#if !data.ledger.length && !data.loadError}
	<div class="card"><p>Noch keine Buchungen. <a href="/import">Zum Import</a></p></div>
{/if}

{#if result}
	{@const t = result.totals}
	<div class="tiles">
		<div class="card tile">
			<div class="label">Anlage KAP · Termingeschäfte</div>
			<div class="value {sign(t.kapNet)}">{eur(t.kapNet)}</div>
			<div class="muted small">{result.kap.length} Buchungen</div>
		</div>
		<div class="card tile">
			<div class="label">Anlage SO · private Veräußerungen</div>
			<div class="value {sign(t.soTaxableGain)}">{eur(t.soTaxableGain)}</div>
			<div class="muted small">
				{#if t.soOpenIssues}
					<span class="error">{t.soOpenIssues} offene Punkte</span>
				{:else if t.soTaxableGain.gt(0) && t.soTaxableGain.lt(FREIGRENZE_SO)}
					unter der Freigrenze von 1.000 € – steuerfrei
				{:else if t.soTaxableGain.gte(FREIGRENZE_SO)}
					Freigrenze überschritten – voll steuerpflichtig
				{:else}
					{result.disposals.length} Veräußerungen
				{/if}
			</div>
		</div>
		<div class="card tile">
			<div class="label">Earn · Zinsen und Boni</div>
			<div class="value">{eur(t.earnEurKnown)}</div>
			<div class="muted small">nur Stablecoins bewertet – folgt</div>
		</div>
	</div>

	<details class="card assumptions">
		<summary>Annahmen dieser Berechnung</summary>
		<ul>
			<li>USDT und USDC werden 1:1 als US-Dollar bewertet und mit dem EZB-Referenzkurs des Tages in Euro umgerechnet (Wochenende/Feiertag: letzter Kurs davor).</li>
			<li>Perpetual Futures gelten als Termingeschäfte (§ 20 Abs. 2 S. 1 Nr. 3 EStG); das BMF-Schreiben vom 06.03.2025 regelt sie nicht ausdrücklich.</li>
			<li>Spot: FIFO je Coin über alle Bitget-Konten, Haltefrist ein Jahr (§ 23 EStG). Auch Käufe mit USDT sind Veräußerungen von USDT.</li>
			<li>Gebühren im gekauften Coin mindern die erhaltene Menge, Gebühren im verkauften Coin erhöhen die abgegebene Menge.</li>
			<li>Auszahlungen nach außen gelten als Übertrag auf eine eigene Wallet (nicht steuerbar).</li>
			<li>Zeiten in Europe/Berlin. Engine-Version {result.engineVersion}.</li>
		</ul>
		<p class="muted small">Ich bin kein Steuerberater – bitte das Ergebnis vor der Abgabe prüfen lassen. Die Zeilennummern der Formulare 2026 bitte am amtlichen Vordruck abgleichen.</p>
	</details>

	<section>
		<div class="sechead">
			<h2>Anlage KAP – Termingeschäfte {year}</h2>
			<button class="ghost" onclick={() => download(`kap-${year}.csv`, kapCsv(result))}>CSV-Export</button>
		</div>
		<div class="card">
			<table class="summary">
				<tbody>
					<tr><td>Gewinne aus Termingeschäften</td><td class="num">{eur(t.kapGains)}</td></tr>
					<tr><td>Verluste aus Termingeschäften</td><td class="num">{eur(t.kapLosses)}</td></tr>
					<tr><td>Handelsgebühren</td><td class="num">{eur(t.kapFees)}</td></tr>
					<tr><td>Funding (Saldo)</td><td class="num">{eur(t.kapFunding)}</td></tr>
					<tr><td>Sonstiges (Boni, Copy-Trading)</td><td class="num">{eur(t.kapOther)}</td></tr>
					<tr class="total"><td>Ergebnis</td><td class="num {sign(t.kapNet)}">{eur(t.kapNet)}</td></tr>
				</tbody>
			</table>
			{#if !t.kapUnvaluedUsd.isZero()}
				<p class="error">{num(t.kapUnvaluedUsd, 2)} USDT ohne EZB-Kurs – bitte Kurse aktualisieren.</p>
			{/if}
			{#if months.length}
				<div class="table-wrap">
					<table>
						<thead>
							<tr><th>Monat</th><th class="num">Gewinne</th><th class="num">Verluste</th><th class="num">Gebühren</th><th class="num">Funding</th><th class="num">Sonstiges</th><th class="num">Saldo</th></tr>
						</thead>
						<tbody>
							{#each months as [m, r] (m)}
								{@const s = r.gains.add(r.losses).add(r.fees).add(r.funding).add(r.other)}
								<tr>
									<td>{m}</td>
									<td class="num">{eur(r.gains)}</td>
									<td class="num">{eur(r.losses)}</td>
									<td class="num">{eur(r.fees)}</td>
									<td class="num">{eur(r.funding)}</td>
									<td class="num">{eur(r.other)}</td>
									<td class="num {sign(s)}">{eur(s)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</section>

	<section>
		<div class="sechead">
			<h2>Anlage SO – private Veräußerungsgeschäfte {year}</h2>
			<button class="ghost" onclick={() => download(`so-${year}.csv`, soCsv(result))}>CSV-Export</button>
		</div>
		<div class="card">
			<table class="summary">
				<tbody>
					<tr><td>Ergebnis innerhalb der Haltefrist (steuerpflichtig)</td><td class="num {sign(t.soTaxableGain)}">{eur(t.soTaxableGain)}</td></tr>
					<tr><td>Ergebnis nach Ablauf der Haltefrist (steuerfrei)</td><td class="num muted">{eur(t.soFreeGain)}</td></tr>
					<tr><td>Veräußerungen</td><td class="num">{result.disposals.length}</td></tr>
				</tbody>
			</table>
			<p class="muted small">
				Freigrenze 1.000 € pro Jahr für alle privaten Veräußerungsgeschäfte zusammen. Liegt der Gesamtgewinn darunter, bleibt er steuerfrei; darüber ist er voll steuerpflichtig.
			</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th>Datum</th><th>Asset</th><th class="num">Menge</th><th>gegen</th><th class="num">Erlös</th><th class="num">Kosten</th><th class="num">stpfl.</th><th class="num">steuerfrei</th><th>Status</th></tr>
					</thead>
					<tbody>
						{#each disposalsShown as d (d.txId)}
							{@const cost = d.portions.reduce<Decimal | null>((s, p) => (s === null || p.cost === null ? null : s.add(p.cost)), new Decimal(0))}
							<tr>
								<td>{d.day}</td>
								<td>{d.asset}</td>
								<td class="num">{num(d.qty)}</td>
								<td>{d.counter}</td>
								<td class="num">{eur(d.proceeds)}</td>
								<td class="num">{eur(cost)}</td>
								<td class="num {sign(d.gainTaxable)}">{eur(d.gainTaxable)}</td>
								<td class="num muted">{eur(d.gainFree)}</td>
								<td class={d.status === 'ok' ? 'muted' : 'error'}>{STATUS[d.status]}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if disposalsShown.length < result.disposals.length || showAllDisposals}
				<p>
					<button class="ghost" onclick={() => (showAllDisposals = !showAllDisposals)}>
						{showAllDisposals ? 'USDT-Abgänge ohne Ergebnis ausblenden' : `Alle ${result.disposals.length} Veräußerungen zeigen (inkl. USDT-Abgänge ohne steuerpflichtiges Ergebnis)`}
					</button>
				</p>
			{/if}
		</div>
	</section>

	{#if warnGroups.length}
		<section>
			<h2>Zu prüfen</h2>
			<div class="card">
				{#each warnGroups as [kind, list] (kind)}
					<details>
						<summary>{WARN[kind]} ({list.length})</summary>
						<div class="table-wrap">
							<table>
								<tbody>
									{#each list.slice(0, 100) as w, i (i)}
										<tr>
											<td>{w.day}</td>
											<td>{w.asset ?? ''}</td>
											<td class="num">{w.qty ? num(w.qty) : ''}</td>
											<td class="muted">{w.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</details>
				{/each}
			</div>
		</section>
	{/if}

	<section>
		<h2>Earn {year} (Vorschau)</h2>
		<div class="card">
			<p class="muted small">
				Zinsen und Boni sind Einkünfte nach § 22 Nr. 3 EStG (Freigrenze 256 €). Bewertet sind bisher nur Stablecoins; für BTC, ETH, BGB usw. fehlen noch Tageskurse.
			</p>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Coin</th><th class="num">Menge</th><th class="num">Buchungen</th><th class="num">EUR</th></tr></thead>
					<tbody>
						{#each result.earn as r (r.asset)}
							<tr>
								<td>{r.asset}</td>
								<td class="num">{num(r.qty)}</td>
								<td class="num">{r.bookings.toLocaleString('de-DE')}</td>
								<td class="num">{r.qtyUnvalued.isZero() ? eur(r.eurKnown) : '–'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</section>

	<section>
		<h2>Bestand zum 01.01.{year}</h2>
		<div class="card table-wrap">
			<table>
				<thead><tr><th>Coin</th><th class="num">Menge</th><th class="num">Anschaffungskosten bekannt</th><th class="num">Menge ohne Kosten</th></tr></thead>
				<tbody>
					{#each result.holdingsStart as h (h.asset)}
						<tr>
							<td>{h.asset}</td>
							<td class="num">{num(h.qty)}</td>
							<td class="num">{eur(h.costKnown)}</td>
							<td class="num">{h.qtyCostUnknown.isZero() ? '' : num(h.qtyCostUnknown)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<style>
	.head {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 16px;
	}
	.head h1 {
		margin: 0;
	}
	select {
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	.fxbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 16px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
		margin-bottom: 16px;
	}
	.tile .label {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.tile .value {
		font: 600 1.6rem/1.3 var(--mono);
		font-variant-numeric: tabular-nums;
		margin: 4px 0;
	}
	.small {
		font-size: 0.85rem;
	}
	.gain {
		color: var(--gain);
	}
	.loss {
		color: var(--loss);
	}
	.assumptions summary {
		cursor: pointer;
		font-weight: 600;
	}
	.assumptions li {
		margin: 4px 0;
	}
	section {
		margin-top: 24px;
	}
	.sechead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.sechead h2 {
		margin: 0 0 8px;
	}
	table.summary {
		max-width: 520px;
		margin-bottom: 12px;
	}
	tr.total td {
		font-weight: 700;
		border-top: 2px solid var(--border);
	}
	details + details {
		margin-top: 8px;
	}
	details summary {
		cursor: pointer;
	}
</style>
