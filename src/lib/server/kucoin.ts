import { createHmac } from 'node:crypto';
import { KUCOIN_API_KEY, KUCOIN_API_PASSPHRASE, KUCOIN_API_SECRET } from '$app/env/private';

/** KuCoin (global, nicht KuCoin EU) – REST-API, nur lesend. */
const BASE = 'https://api.kucoin.com';

export class KucoinError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string
	) {
		super(message);
	}
}

export function kucoinConfigured() {
	return Boolean(KUCOIN_API_KEY && KUCOIN_API_SECRET && KUCOIN_API_PASSPHRASE);
}

/**
 * Signierter GET-Aufruf (API-Key-Version 2).
 * KC-API-SIGN = Base64(HMAC-SHA256(secret, timestamp + 'GET' + path?query)),
 * KC-API-PASSPHRASE = Base64(HMAC-SHA256(secret, passphrase)). Erfolg: code "200000".
 */
export async function kucoinGet<T = unknown>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
	if (!kucoinConfigured()) throw new KucoinError('KuCoin-Zugangsdaten fehlen in den Umgebungsvariablen', 500);
	const secret = KUCOIN_API_SECRET!;
	// KuCoin signiert die nicht URL-kodierte Abfrage; unsere Parameter bestehen nur aus Buchstaben und Ziffern
	const query = Object.entries(params)
		.filter(([, v]) => v !== undefined && v !== '')
		.map(([k, v]) => `${k}=${v}`)
		.join('&');
	const requestPath = query ? `${path}?${query}` : path;
	const ts = Date.now().toString();
	const sign = createHmac('sha256', secret).update(ts + 'GET' + requestPath).digest('base64');
	const passphrase = createHmac('sha256', secret).update(KUCOIN_API_PASSPHRASE!).digest('base64');

	const res = await fetch(BASE + requestPath, {
		headers: {
			'KC-API-KEY': KUCOIN_API_KEY!,
			'KC-API-SIGN': sign,
			'KC-API-TIMESTAMP': ts,
			'KC-API-PASSPHRASE': passphrase,
			'KC-API-KEY-VERSION': '2',
			'Content-Type': 'application/json'
		}
	});
	const body = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: T } | null;
	if (!res.ok || !body || body.code !== '200000') {
		throw new KucoinError(body?.msg ?? `HTTP ${res.status}`, res.status, body?.code);
	}
	return body.data as T;
}

/** Seitenweise Abfrage (currentPage/pageSize, neueste zuerst) – alle Seiten eines Zeitfensters. */
export async function kucoinPaged<T = Record<string, unknown>>(
	path: string,
	params: Record<string, string | number | undefined>,
	pageSize = 500,
	maxPages = 40
): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; page <= maxPages; page++) {
		const data = await kucoinGet<{ items?: T[]; totalPage?: number }>(path, { ...params, currentPage: page, pageSize });
		out.push(...(data.items ?? []));
		if (!data.totalPage || page >= data.totalPage) break;
	}
	return out;
}
