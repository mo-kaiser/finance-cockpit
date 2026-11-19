<script lang="ts">
	import { BROKERS, brokerState, setBroker, type Broker } from '#lib/broker.svelte.ts';

	/** Auswahl nur zeigen, wenn KuCoin eingerichtet ist bzw. Buchungen hat */
	let { show = true }: { show?: boolean } = $props();
</script>

{#if show}
	<select value={brokerState.value} onchange={(e) => setBroker(e.currentTarget.value as Broker)} aria-label="Börse">
		{#each BROKERS as b (b)}<option>{b}</option>{/each}
	</select>
{/if}
