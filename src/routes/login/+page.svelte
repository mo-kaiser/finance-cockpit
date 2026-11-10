<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';

	let { data } = $props();
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let busy = $state(false);

	async function login(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		const { error: err } = await data.supabase.auth.signInWithPassword({ email, password });
		busy = false;
		if (err) {
			error = `Anmeldung fehlgeschlagen: ${err.message}${err.code ? ` (${err.code})` : ''}`;
			return;
		}
		await invalidateAll();
		await goto('/mfa');
	}
</script>

<div class="card narrow">
	<h1>Anmelden</h1>
	<form onsubmit={login}>
		<label for="email">E-Mail</label>
		<input id="email" type="email" autocomplete="username" bind:value={email} required />
		<label for="password">Passwort</label>
		<input id="password" type="password" autocomplete="current-password" bind:value={password} required />
		{#if error}<p class="error">{error}</p>{/if}
		<p><button type="submit" disabled={busy}>Weiter</button></p>
	</form>
</div>
