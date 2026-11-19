<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Einheitliche Lesehilfe ganz unten auf einer Seite, eingeklappt */
	let { children }: { children: Snippet } = $props();
</script>

<details class="card help block">
	<summary>So sind die Zahlen zu lesen</summary>
	<div class="small muted help-body">
		{@render children()}
	</div>
</details>
