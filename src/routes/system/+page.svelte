<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import { ago, assessSync, berlin } from '#lib/monitor/health.ts';
	import { clearLedgerCache, loadLedger } from '#lib/data/ledger.ts';
	import { neededPriceCoins } from '#lib/tax/prices.ts';

	let { data, form } = $props();

	const sync = $derived(assessSync(data.syncRuns));

	/** Kurzfassung der Lauf-Notiz (JSON mit Ergebnis je Schnittstelle) */
	function runSummary(note: string | null): string {
		if (!note) return '';
		try {
			const o = JSON.parse(note) as Record<string, { received?: number; stored?: number; error?: string } | string>;
			return Object.entries(o)
				.map(([k, v]) => (typeof v === 'string' ? `${k}: ${v}` : v.error ? `${k}: ${v.error}` : `${k} ${v.stored ?? 0} neu`))
				.join(' · ');
		} catch {
			return note;
		}
	}
	// Datensicherung als Download: alle Tabellen seitenweise, eine gzip-komprimierte NDJSON-Datei
	let backupBusy = $state(false);
	let backupMsg = $state('');
	let backupErr = $state('');
	async function downloadBackup() {
		backupBusy = true;
		backupMsg = '';
		backupErr = '';
		try {
			const get = async (q: string) => {
				const res = await fetch(`/api/backup${q}`);
				const body = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
				return body;
			};
			const { tables } = (await get('')) as { tables: { name: string }[] };
			const lines: string[] = [JSON.stringify({ backup: 'finance-cockpit', version: 1, created_at: new Date().toISOString() })];
			const counts: string[] = [];
			for (const t of tables) {
				let offset: number | null = 0;
				let n = 0;
				let total: number | undefined;
				while (offset !== null) {
					backupMsg = `${t.name}: ${n.toLocaleString('de-DE')} Zeilen …`;
					const page = (await get(`?table=${t.name}&offset=${offset}`)) as { rows: unknown[]; next: number | null; total?: number };
					if (offset === 0) total = page.total;
					for (const row of page.rows) lines.push(JSON.stringify({ table: t.name, row }));
					n += page.rows.length;
					offset = page.next;
				}
				if (total !== undefined && total !== n) throw new Error(`${t.name}: ${n} von ${total} Zeilen gelesen – Sicherung unvollständig`);
				counts.push(`${t.name} ${n.toLocaleString('de-DE')}`);
			}
			const gz = new Blob([lines.join('\n') + '\n']).stream().pipeThrough(new CompressionStream('gzip'));
			const blob = await new Response(gz).blob();
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = `cockpit-backup-${new Date().toISOString().slice(0, 10)}.ndjson.gz`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
			backupMsg = `Fertig (${(blob.size / 1e6).toFixed(1)} MB): ${counts.join(' · ')}`;
		} catch (e) {
			backupErr = (e as Error).message;
			backupMsg = '';
		}
		backupBusy = false;
	}

	// Tageskurse je Coin: Abdeckung prüfen und fehlende Kurse Coin für Coin nachladen
	interface PriceRow {
		coin: string;
		needed: string;
		first: string | null;
		last: string | null;
		n: number;
		state: 'ok' | 'fehlt' | 'luecke' | 'veraltet' | 'nicht_bei_bitget' | 'ab_listing';
	}
	let priceRows = $state<PriceRow[]>([]);
	let priceErr = $state('');
	let priceBusy = $state(false);
	let priceLog = $state<string[]>([]);
	// Coins ohne Bitget-Kurse merken (nur in diesem Browser), damit sie nicht jedes Mal als „fehlt“ erscheinen
	const KEY = 'cockpit.prices.unavailable';
	const readSet = (k: string) => {
		try {
			return new Set<string>(JSON.parse(localStorage.getItem(k) ?? '[]'));
		} catch {
			return new Set<string>();
		}
	};
	const saveSet = (k: string, v: Set<string>) => {
		try {
			localStorage.setItem(k, JSON.stringify([...v]));
		} catch {
			/* ohne Speicher geht es auch */
		}
	};
	const unavailable = readSet(KEY);
	const listedLater = readSet(`${KEY}.later`);
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

	async function loadPriceStatus(force = false) {
		priceErr = '';
		try {
			const d = await loadLedger(data.supabase, force);
			if (d.pricesError) priceErr = `Tageskurse: ${d.pricesError}`;
			const have = new Map(d.prices.map((p) => [p.coin, p]));
			priceRows = [...neededPriceCoins(d.ledger)]
				.map(([coin, needed]) => {
					const p = have.get(coin);
					const first = p?.first_day ?? null;
					const last = p?.last_day ?? null;
					let state: PriceRow['state'] = 'ok';
					if (!p) state = unavailable.has(coin) ? 'nicht_bei_bitget' : 'fehlt';
					else if (first! > plusDays(needed, 3)) state = listedLater.has(coin) ? 'ab_listing' : 'luecke';
					else if (last! < plusDays(yesterday, -2)) state = 'veraltet';
					return { coin, needed, first, last, n: p?.n ?? 0, state };
				})
				.sort((a, b) => (a.state === 'ok' ? 1 : 0) - (b.state === 'ok' ? 1 : 0) || a.coin.localeCompare(b.coin));
		} catch (e) {
			priceErr = (e as Error).message;
		}
	}
	onMount(() => void loadPriceStatus());

	const priceTodo = $derived(priceRows.filter((r) => r.state === 'fehlt' || r.state === 'luecke' || r.state === 'veraltet'));
	const PRICE_STATE: Record<PriceRow['state'], string> = {
		ok: 'vollständig',
		fehlt: 'fehlt',
		luecke: 'Anfang fehlt',
		veraltet: 'nicht aktuell',
		nicht_bei_bitget: 'nicht bei Bitget',
		ab_listing: 'ab Bitget-Listing'
	};

	async function syncPrices() {
		priceBusy = true;
		priceLog = [];
		const todo = [...priceTodo];
		for (const [i, r] of todo.entries()) {
			// Anfang fehlt / ganz neu: ab Erstauftreten; sonst ab dem letzten vorhandenen Tag
			const from = r.state === 'veraltet' ? plusDays(r.last!, 1) : r.needed;
			priceLog = [`${i + 1}/${todo.length} ${r.coin} …`, ...priceLog.slice(0, 40)];
			try {
				const res = await fetch('/api/prices/sync', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ coin: r.coin, from })
				});
				const b = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(b.message ?? `HTTP ${res.status}`);
				if (b.unavailable) unavailable.add(r.coin);
				else if (b.first && b.first > plusDays(r.needed, 3)) listedLater.add(r.coin);
				priceLog[0] = b.unavailable
					? `${r.coin}: nicht bei Bitget`
					: b.error
						? `${r.coin}: Fehler – ${b.error}`
						: `${r.coin}: ${b.received} Tage (${b.first ?? '–'} bis ${b.last ?? '–'}), ${b.stored} neu`;
			} catch (e) {
				priceLog[0] = `${r.coin}: Fehler – ${(e as Error).message}`;
			}
		}
		saveSet(KEY, unavailable);
		saveSet(`${KEY}.later`, listedLater);
		await loadPriceStatus(true);
		priceBusy = false;
	}

	const STATUS: Record<string, string> = { done: 'erfolgreich', failed: 'fehlgeschlagen', running: 'läuft' };

	interface ProbeResult {
		key: string;
		label: string;
		windowDays: number;
		results: { from: string; to: string; count: number | null; error?: string }[];
		sample: unknown;
		ctMatches: { checked: number; matched: number; examples: string[] } | null;
	}

	let probes = $state<Record<string, ProbeResult | { error: string }>>({});
	let probing = $state<string | null>(null);

	async function probe(key: string) {
		probing = key;
		try {
			const res = await fetch('/api/bitget/probe', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key })
			});
			const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
			probes[key] = res.ok ? body : { error: body.message ?? `HTTP ${res.status}` };
		} catch (e) {
			probes[key] = { error: (e as Error).message };
		}
		probing = null;
	}

	async function probeAll() {
		for (const ep of data.endpoints) await probe(ep.key);
	}

	const reach = (p: ProbeResult) => {
		const withData = p.results.filter((r) => r.count);
		return withData.length ? withData[withData.length - 1]!.from : null;
	};

	// Nachladen: alle Fenster einer Schnittstelle seit einem Datum
	// Standard: ab gestern – deckt den heutigen Berliner Tag sicher ab (Bitget rechnet in UTC)
	const berlinDate = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
	let syncFrom = $state(berlinDate(Date.now() - 86_400_000));
	let syncLog = $state<string[]>([]);
	let syncing = $state(false);

	interface InvGroup {
		endpoint: string;
		group: string | null;
		kind: string;
		n: number;
		afterCt: number;
		first: string;
		last: string;
		sample: unknown;
	}
	let inventory = $state<{ total: number; ctEnd: string | null; groups: InvGroup[] } | null>(null);
	let invError = $state('');
	let invBusy = $state(false);

	async function loadInventory() {
		invBusy = true;
		invError = '';
		const res = await fetch('/api/bitget/inventory');
		const body = await res.json().catch(() => ({}));
		if (res.ok) inventory = body;
		else invError = body.message ?? `HTTP ${res.status}`;
		invBusy = false;
	}

	/** Kompakte Textfassung zum Kopieren in den Chat (ohne Adressen). */
	const inventoryText = $derived.by(() => {
		if (!inventory) return '';
		const strip = (o: unknown) => {
			if (!o || typeof o !== 'object') return o;
			const c = { ...(o as Record<string, unknown>) };
			for (const k of ['toAddress', 'fromAddress', 'tradeId', 'tag']) if (k in c) c[k] = '…';
			return c;
		};
		return inventory.groups
			.map((g) => `${g.endpoint} | ${g.group ?? ''} | ${g.kind} | n=${g.n} | nach CT=${g.afterCt} | ${g.first.slice(0, 10)}–${g.last.slice(0, 10)}\n  ${JSON.stringify(strip(g.sample))}`)
			.join('\n');
	});

	let liveRaw = $state('');
	let liveBusy = $state(false);
	async function loadLiveRaw() {
		liveBusy = true;
		const res = await fetch('/api/bitget/live');
		const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
		// Kurse weglassen (sehr lang), Rest vollständig
		if (body.tickers?.ok) body.tickers = { ok: true, data: `${Object.keys(body.tickers.data).length} Kurse` };
		liveRaw = JSON.stringify(body, null, 2);
		liveBusy = false;
	}

	async function syncAll(from?: string) {
		if (from) syncFrom = from;
		syncing = true;
		syncLog = [];
		const endMs = Date.now();
		for (const ep of data.endpoints) {
			// jede Schnittstelle nur so weit zurück, wie Bitget sie liefert
			const startMs = Math.max(new Date(`${syncFrom}T00:00:00Z`).getTime(), endMs - ep.maxDays * 86_400_000 + 60_000);
			let received = 0;
			let stored = 0;
			let err = '';
			const step = ep.windowDays * 86_400_000;
			for (let e = endMs; e > startMs; e -= step) {
				const s = Math.max(startMs, e - step);
				const res = await fetch('/api/bitget/sync', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ key: ep.key, start: s, end: e })
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) {
					err = `${new Date(s).toISOString().slice(0, 10)}: ${body.message ?? res.status}`;
					break;
				}
				received += body.received;
				stored += body.stored;
			}
			const from = new Date(startMs).toISOString().slice(0, 10);
			syncLog = [...syncLog, `${ep.label} (ab ${from}): ${received} abgerufen, ${stored} neu gespeichert${err ? ` – abgebrochen bei ${err}` : ''}`];
		}
		// Neue Buchungen sofort auf allen Seiten sichtbar machen (sonst bis zu 5 Minuten Zwischenspeicher)
		clearLedgerCache();
		syncing = false;
	}
</script>

<h1>System</h1>

<div class="card">
	<h2 style="margin-top:0">Umgebungsvariablen <span class="muted small">({data.vercelEnv})</span></h2>
	<p class="muted small">Angezeigt wird nur, ob ein Wert ankommt und wie lang er ist – nie der Wert selbst.</p>
	<div class="table-wrap">
		<table>
			<thead><tr><th>Variable</th><th>Status</th><th class="num">Länge</th><th>Hinweis</th></tr></thead>
			<tbody>
				{#each data.vars as v (v.name)}
					<tr>
						<td><code>{v.name}</code></td>
						<td class={v.present ? 'ok' : 'error'}>{v.present ? 'vorhanden' : 'fehlt'}</td>
						<td class="num">{v.present ? v.length : ''}</td>
						<td class="error">
							{v.whitespace ? 'Leerzeichen am Anfang/Ende ' : ''}{v.quoted ? 'in Anführungszeichen' : ''}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="muted small">
		Nach Änderungen in Vercel ist ein Redeploy nötig, bevor neue Werte hier ankommen.
	</p>
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Täglicher Abruf</h2>
	<p class="sync-{sync.level}">
		Zuletzt erfolgreich: <strong>{berlin(sync.lastSuccess)}</strong> ({ago(sync.lastSuccess)})
	</p>
	{#each sync.problems as p (p)}<p class="error small">{p}</p>{/each}
	{#if data.syncRunsError}<p class="error small">{data.syncRunsError}</p>{/if}
	<p class="muted small">
		Abruf täglich um 04:17 UTC (nur Production). Schlägt ein Lauf fehl, kommt sofort eine E-Mail; ein Wächter prüft
		zusätzlich jeden Nachmittag, ob seit über 2 Tagen kein Lauf erfolgreich war.
	</p>
	<form method="POST" action="?/testmail" use:enhance>
		<button type="submit">Test-E-Mail senden</button>
	</form>
	{#if form?.testmail}
		<p class={form.testmail.ok ? 'ok' : 'error'}>
			{form.testmail.ok ? 'Test-E-Mail wurde an Resend übergeben – bitte Postfach (auch Spam) prüfen.' : `E-Mail fehlgeschlagen: ${form.testmail.error}`}
		</p>
	{/if}
	{#if data.syncRuns.length}
		<details>
			<summary><span>Letzte {data.syncRuns.length} Läufe</span></summary>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Start</th><th>Status</th><th>Ergebnis</th></tr></thead>
					<tbody>
						{#each data.syncRuns as r (r.id)}
							<tr>
								<td class="small">{berlin(r.created_at)}</td>
								<td class={r.status === 'done' ? 'ok' : r.status === 'failed' ? 'error' : ''}>{STATUS[r.status] ?? r.status}</td>
								<td class="small">{runSummary(r.note)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Tageskurse je Coin</h2>
	<p class="muted small">
		Bitget-Tagesschlusskurse (USDT) für jeden Coin ab dem Tag, an dem er zum ersten Mal in den Buchungen vorkommt.
		Gebraucht für Earn-Erträge am Zuflusstag, Tausch Coin gegen Coin und den Einstand von Zins-Beständen. Neue Tage
		lädt ein täglicher Abruf; die Historie einmalig hier.
	</p>
	{#if priceErr}<p class="error small">{priceErr}</p>{/if}
	{#if priceRows.length}
		{@const ok = priceRows.filter((r) => r.state === 'ok' || r.state === 'ab_listing').length}
		{@const na = priceRows.filter((r) => r.state === 'nicht_bei_bitget').length}
		<p>
			<strong>{ok}</strong> von {priceRows.length} Coins mit Kursen{#if na}{' · '}{na} nicht bei Bitget{/if}{#if priceTodo.length}{' · '}<span class="error">{priceTodo.length} unvollständig</span>{/if}
		</p>
		<p>
			<button onclick={syncPrices} disabled={priceBusy || !priceTodo.length}>
				{priceBusy ? 'Lade …' : priceTodo.length ? `Fehlende Kurse laden (${priceTodo.length} Coins)` : 'Alle Kurse vorhanden'}
			</button>
		</p>
		{#each priceLog as l, i (i)}<p class="small" style="margin:2px 0">{l}</p>{/each}
		<details>
			<summary><span>Alle Coins</span></summary>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Coin</th><th>benötigt ab</th><th>Kurse von – bis</th><th class="num">Tage</th><th>Status</th></tr></thead>
					<tbody>
						{#each priceRows as r (r.coin)}
							<tr>
								<td><strong>{r.coin}</strong></td>
								<td class="small">{r.needed}</td>
								<td class="small">{r.first ? `${r.first} – ${r.last}` : '–'}</td>
								<td class="num">{r.n ? r.n.toLocaleString('de-DE') : ''}</td>
								<td class="small {r.state === 'ok' ? 'ok' : r.state === 'nicht_bei_bitget' || r.state === 'ab_listing' ? 'muted' : 'error'}">{PRICE_STATE[r.state]}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
		<p class="muted small">
			„Nicht bei Bitget“: kein USDT-Handelspaar (meist kleine, delistete Airdrop-Token) – deren Erträge bleiben unbewertet
			und erscheinen auf der Steuer-Seite als Hinweis.
		</p>
	{:else if !priceErr}
		<p class="muted small">Lade Buchungen …</p>
	{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Datensicherung</h2>
	<p class="muted small">
		Lädt alle Rohdaten (CoinTracking-Import, Bitget-API, Korrekturen, Snapshots, Kurse) als eine komprimierte Datei
		herunter. Beträge exakt als Text. Zusätzlich sichert eine GitHub-Action jede Woche in ein privates Repository.
	</p>
	<p><button onclick={downloadBackup} disabled={backupBusy}>{backupBusy ? 'Sichere …' : 'Sicherung herunterladen'}</button></p>
	{#if backupMsg}<p class="small">{backupMsg}</p>{/if}
	{#if backupErr}<p class="error">{backupErr}</p>{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Verbindungstests</h2>

	<form method="POST" action="?/bitget" use:enhance>
		<button type="submit">Bitget-Key testen</button>
	</form>
	{#if form?.bitget}
		{#if form.bitget.ok}
			<p class="ok">Verbindung zu Bitget erfolgreich.</p>
			<p>Rechte des Keys: <code>{form.bitget.authorities?.join(', ') || '–'}</code></p>
			{#if form.bitget.risky?.length}
				<p class="error">
					Achtung: Der Key hat mehr als Leserechte ({form.bitget.risky.join(', ')}). Bitte in Bitget auf „nur
					Lesen“ beschränken.
				</p>
			{/if}
		{:else}
			<p class="error">Bitget: {form.bitget.error}</p>
		{/if}
	{/if}

	<form method="POST" action="?/kucoin" use:enhance style="margin-top:16px">
		<button type="submit" disabled={!data.kucoin}>KuCoin-Key testen</button>
		{#if !data.kucoin}<span class="muted small"> – erst die KUCOIN_API_…-Variablen in Vercel anlegen</span>{/if}
	</form>
	{#if form?.kucoin}
		{#if form.kucoin.ok}
			<p class="ok">Verbindung zu KuCoin erfolgreich.</p>
			<p>Rechte des Keys: <code>{form.kucoin.permissions?.join(', ') || '–'}</code></p>
			{#if form.kucoin.risky?.length}
				<p class="error">Achtung: Der Key hat mehr als „General“ ({form.kucoin.risky.join(', ')}). Bitte in KuCoin auf „General“ beschränken.</p>
			{/if}
			<p class="small muted">Konten mit Guthaben: {form.kucoin.accounts?.join(', ') || 'keine'}</p>
		{:else}
			<p class="error">KuCoin: {form.kucoin.error}</p>
		{/if}
	{/if}

	<form method="POST" action="?/supabase" use:enhance style="margin-top:16px">
		<button type="submit">Supabase Secret Key testen</button>
	</form>
	{#if form?.supabase}
		{#if form.supabase.ok}
			<p class="ok">Secret Key funktioniert ({form.supabase.imports} Importe sichtbar).</p>
		{:else}
			<p class="error">Supabase: {form.supabase.error}</p>
		{/if}
	{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Bitget-Schnittstellen: Reichweite</h2>
	<p class="muted small">
		Fragt jede Schnittstelle Monat für Monat rückwärts ab und zeigt, bis wann Daten kommen. Es wird nichts gespeichert.
	</p>
	<p><button onclick={probeAll} disabled={probing !== null}>{probing ? 'Prüfe …' : 'Alle prüfen'}</button></p>

	{#each data.endpoints as ep (ep.key)}
		{@const p = probes[ep.key]}
		<details open={!!p}>
			<summary>
				<strong>{ep.label}</strong>
				<span class="muted small">
					{#if probing === ep.key}prüfe …
					{:else if p && 'error' in p}<span class="error">{p.error}</span>
					{:else if p}Daten ab {reach(p) ?? '– (keine)'}
					{/if}
				</span>
			</summary>
			{#if p && !('error' in p)}
				<div class="table-wrap">
					<table>
						<thead><tr><th>Zeitraum</th><th class="num">Treffer (1. Seite)</th><th>Fehler</th></tr></thead>
						<tbody>
							{#each p.results as r (r.from)}
								<tr>
									<td>{r.from} – {r.to}</td>
									<td class="num">{r.count ?? ''}</td>
									<td class="error small">{r.error ?? ''}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if p.ctMatches}
					<p class="small">
						Abgleich mit CoinTracking: {p.ctMatches.matched} von {p.ctMatches.checked} Bitget-IDs gefunden
						{#if p.ctMatches.examples.length}(z. B. <code>{p.ctMatches.examples.join(', ')}</code>){/if}
					</p>
				{/if}
				{#if p.sample}
					<p class="small muted">Beispielbuchung:</p>
					<pre>{JSON.stringify(p.sample, null, 2)}</pre>
				{/if}
			{/if}
		</details>
	{/each}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Börsen-Daten nachladen {data.kucoin ? '(Bitget und KuCoin)' : '(Bitget)'}</h2>
	<p class="muted small">
		Holt neue Buchungen sofort, statt auf den täglichen Abruf zu warten – z. B. nach einem Futures-Trade. Bereits vorhandene
		Datensätze werden übersprungen, mehrfaches Nachladen schadet also nicht. Für den Alltag reicht „Letzte 2 Tage“; ein
		früheres Datum nur, wenn der tägliche Abruf länger ausgefallen ist.
	</p>
	<p><button onclick={() => syncAll(berlinDate(Date.now() - 86_400_000))} disabled={syncing}>{syncing ? 'Lade …' : 'Letzte 2 Tage nachladen'}</button></p>
	<details>
		<summary><span>Ab einem bestimmten Datum</span></summary>
		<label for="from">Ab</label>
		<input id="from" type="date" bind:value={syncFrom} style="max-width:200px" disabled={syncing} />
		<p><button class="ghost" onclick={() => syncAll()} disabled={syncing}>Nachladen ab {syncFrom}</button></p>
	</details>
	{#each syncLog as l, i (i)}<p class="small">{l}</p>{/each}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Bitget-Bestände (Rohdaten)</h2>
	<p class="muted small">Zeigt die Antwort der Live-Abfrage, die das Dashboard nutzt – zur Fehlersuche bei abweichenden Beständen.</p>
	<p><button onclick={loadLiveRaw} disabled={liveBusy}>{liveBusy ? 'Lade …' : 'Rohdaten anzeigen'}</button></p>
	{#if liveRaw}<textarea readonly rows="16" onfocus={(e) => e.currentTarget.select()}>{liveRaw}</textarea>{/if}
</div>

<div class="card" style="margin-top:16px">
	<h2 style="margin-top:0">Buchungsarten in den Bitget-Daten</h2>
	<p class="muted small">Gruppiert die gespeicherten Rohdaten nach Buchungsart, mit Anzahl und einem Beispiel.</p>
	<p><button onclick={loadInventory} disabled={invBusy}>{invBusy ? 'Lade …' : 'Inventur anzeigen'}</button></p>
	{#if invError}<p class="error">{invError}</p>{/if}
	{#if inventory}
		<p class="small">
			{inventory.total.toLocaleString('de-DE')} Datensätze · CoinTracking-Export endet {inventory.ctEnd?.slice(0, 16) ?? '–'}
		</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Schnittstelle</th><th>Gruppe</th><th>Art</th><th class="num">Anzahl</th><th class="num">nach CT-Export</th><th>Zeitraum</th></tr></thead>
				<tbody>
					{#each inventory.groups as g (g.endpoint + g.group + g.kind)}
						<tr>
							<td>{g.endpoint}</td>
							<td>{g.group ?? ''}</td>
							<td><code>{g.kind}</code></td>
							<td class="num">{g.n.toLocaleString('de-DE')}</td>
							<td class="num">{g.afterCt.toLocaleString('de-DE')}</td>
							<td class="small">{g.first.slice(0, 10)} – {g.last.slice(0, 10)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="small muted">Zum Kopieren in den Chat (Adressen ausgeblendet):</p>
		<textarea readonly rows="12" onfocus={(e) => e.currentTarget.select()}>{inventoryText}</textarea>
	{/if}
</div>

<style>
	textarea {
		width: 100%;
		font: 0.8rem/1.4 var(--mono);
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px;
	}
	pre {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px;
		font-size: 0.8rem;
		overflow-x: auto;
		max-height: 320px;
	}
	details {
		border-top: 1px solid var(--border);
		padding: 8px 0;
	}
	details summary {
		cursor: pointer;
		display: flex;
		gap: 12px;
		align-items: baseline;
		flex-wrap: wrap;
	}
	.ok,
	.sync-ok strong {
		color: var(--gain);
	}
	.sync-error strong {
		color: var(--loss);
	}
	.small {
		font-size: 0.85rem;
		font-weight: 400;
	}
</style>
