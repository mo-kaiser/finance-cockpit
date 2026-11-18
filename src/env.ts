import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * Server-Variablen (privat, zur Laufzeit gelesen). Fehlende Werte werden zu '' –
 * der Code prüft überall selbst auf leer und meldet „fehlt“ (System-Seite, Cron, Mail).
 */
export const variables = defineEnvVars({
	COCKPIT_DEMO: { schema: (input) => input ?? '' },
	CRON_SECRET: { schema: (input) => input ?? '' },
	BACKUP_SECRET: { schema: (input) => input ?? '' },
	RESEND_API_KEY: { schema: (input) => input ?? '' },
	ALERT_EMAIL_TO: { schema: (input) => input ?? '' },
	ALERT_EMAIL_FROM: { schema: (input) => input ?? '' },
	BITGET_API_KEY: { schema: (input) => input ?? '' },
	BITGET_API_SECRET: { schema: (input) => input ?? '' },
	BITGET_API_PASSPHRASE: { schema: (input) => input ?? '' },
	KUCOIN_API_KEY: { schema: (input) => input ?? '' },
	KUCOIN_API_SECRET: { schema: (input) => input ?? '' },
	KUCOIN_API_PASSPHRASE: { schema: (input) => input ?? '' },
	SUPABASE_SECRET_KEY: { schema: (input) => input ?? '' },
	VERCEL_ENV: { schema: (input) => input ?? '' }
});
