<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';

	let { data } = $props();

	type Mode = 'loading' | 'verify' | 'enroll';
	let mode = $state<Mode>('loading');
	let factorId = $state('');
	let qr = $state('');
	let secret = $state('');
	let code = $state('');
	let error = $state('');
	let busy = $state(false);

	onMount(async () => {
		const { data: aal } = await data.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
		if (aal?.currentLevel === 'aal2') return goto('/');

		const { data: factors, error: err } = await data.supabase.auth.mfa.listFactors();
		if (err) {
			error = err.message;
			return;
		}
		const verified = factors.totp.find((f) => f.status === 'verified');
		if (verified) {
			factorId = verified.id;
			mode = 'verify';
			return;
		}

		// Reste abgebrochener Einrichtungen entfernen, dann neu einrichten
		for (const f of factors.all.filter((f) => f.status === 'unverified')) {
			await data.supabase.auth.mfa.unenroll({ factorId: f.id });
		}
		const { data: enrolled, error: enrollErr } = await data.supabase.auth.mfa.enroll({
			factorType: 'totp',
			friendlyName: 'Cockpit'
		});
		if (enrollErr || !enrolled) {
			error = enrollErr?.message ?? 'Einrichtung fehlgeschlagen.';
			return;
		}
		factorId = enrolled.id;
		qr = enrolled.totp.qr_code;
		secret = enrolled.totp.secret;
		mode = 'enroll';
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		const { error: err } = await data.supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
		busy = false;
		if (err) {
			error = 'Code ungültig. Bitte erneut versuchen.';
			code = '';
			return;
		}
		await invalidateAll();
		await goto('/');
	}
</script>

<div class="card narrow">
	<h1>Zwei-Faktor-Prüfung</h1>

	{#if mode === 'loading'}
		<p class="muted">Lade …</p>
	{:else}
		{#if mode === 'enroll'}
			<p>
				Scanne den QR-Code mit Deiner Authenticator-App und gib danach den sechsstelligen Code ein.
			</p>
			<img src={qr} alt="QR-Code für die Authenticator-App" width="200" height="200" />
			<p class="muted">Manuell: <code>{secret}</code></p>
		{:else}
			<p>Gib den Code aus Deiner Authenticator-App ein.</p>
		{/if}

		<form onsubmit={submit}>
			<label for="code">Code</label>
			<input
				id="code"
				inputmode="numeric"
				autocomplete="one-time-code"
				pattern="[0-9]{6}"
				maxlength="6"
				bind:value={code}
				required
			/>
			<p><button type="submit" disabled={busy}>Bestätigen</button></p>
		</form>
	{/if}

	{#if error}<p class="error">{error}</p>{/if}
</div>
