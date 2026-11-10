import { createHmac } from 'node:crypto';
import { env } from '$env/dynamic/private';

const BASE = 'https://api.bitget.com';

export class BitgetError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string
	) {
		super(message);
	}
}

export function bitgetConfigured() {
	return Boolean(env.BITGET_API_KEY && env.BITGET_API_SECRET && env.BITGET_API_PASSPHRASE);
}

/**
 * Signierter GET-Aufruf der Bitget-API v2.
 * Signatur: Base64(HMAC-SHA256(secret, timestamp + METHOD + path + ?query + body)).
 */
export async function bitgetGet<T = unknown>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
	if (!bitgetConfigured()) throw new BitgetError('Bitget-Zugangsdaten fehlen in den Umgebungsvariablen', 500);

	const query = new URLSearchParams(
		Object.entries(params)
			.filter(([, v]) => v !== undefined && v !== '')
			.map(([k, v]) => [k, String(v)])
	).toString();
	const requestPath = query ? `${path}?${query}` : path;
	const ts = Date.now().toString();
	const sign = createHmac('sha256', env.BITGET_API_SECRET!).update(ts + 'GET' + requestPath).digest('base64');

	const res = await fetch(BASE + requestPath, {
		headers: {
			'ACCESS-KEY': env.BITGET_API_KEY!,
			'ACCESS-SIGN': sign,
			'ACCESS-TIMESTAMP': ts,
			'ACCESS-PASSPHRASE': env.BITGET_API_PASSPHRASE!,
			'Content-Type': 'application/json',
			locale: 'en-US'
		}
	});
	const body = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: T } | null;
	if (!res.ok || !body || body.code !== '00000') {
		throw new BitgetError(body?.msg ?? `HTTP ${res.status}`, res.status, body?.code);
	}
	return body.data as T;
}

/** Öffentlicher (unsignierter) GET-Aufruf, z. B. für Marktkurse. */
export async function bitgetPublic<T = unknown>(path: string, params: Record<string, string | number> = {}): Promise<T> {
	const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
	const res = await fetch(BASE + path + (query ? `?${query}` : ''));
	const body = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: T } | null;
	if (!res.ok || !body || body.code !== '00000') {
		throw new BitgetError(body?.msg ?? `HTTP ${res.status}`, res.status, body?.code);
	}
	return body.data as T;
}
