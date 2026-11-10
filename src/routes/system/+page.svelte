<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
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

<style>
	.ok {
		color: var(--gain);
	}
	.small {
		font-size: 0.85rem;
		font-weight: 400;
	}
</style>
