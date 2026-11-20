<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Bereich einer Auswertungsseite.
	 * now = true: „Aktueller Stand“ – beim Seitenaufruf bzw. „Aktualisieren“ abgefragt, unabhängig vom Zeitraum, farbig abgesetzt, mit Abrufzeit.
	 * Sonst „Auswertung“: Zeitraum-Schalter gehören in tools, damit klar ist, wofür sie gelten.
	 */
	let {
		title,
		now = false,
		at = null,
		tools,
		children
	}: { title: string; now?: boolean; at?: string | null; tools?: Snippet; children: Snippet } = $props();
</script>

<section class="zone" class:zone-now={now}>
	<div class="zone-head">
		<div class="zone-title">
			{title}
			{#if now}<span class="stamp small">{at ? `abgerufen um ${new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : 'lade …'}</span>{/if}
		</div>
		{#if tools}<div class="zone-tools">{@render tools()}</div>{/if}
	</div>
	{@render children()}
</section>
