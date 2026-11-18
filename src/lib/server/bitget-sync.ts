import type { SupabaseClient } from '@supabase/supabase-js';
import { bitgetGet } from './bitget';
import { kucoinPaged } from './kucoin';

const DAY = 86_400_000;

type Item = Record<string, unknown>;

export interface EndpointDef {
	key: string;
	label: string;
	path: string;
	params: Record<string, string | number>;
	limit: number;
	/** Maximale Fensterbreite pro Anfrage in Tagen (Bitget begrenzt start/endTime). */
	windowDays: number;
	/** Wie weit die Schnittstelle zurückreicht (Tage), laut Reichweiten-Prüfung 11/2026. */
	maxDays: number;
	/** Grundlage für die Steuerberechnung (gleiche IDs wie CoinTracking) oder nur Zusatzinfo. */
	role: 'ledger' | 'detail';
	/** Datensatz kann sich bei Bitget noch ändern (Status pending → success): vorhandene Zeile mit der neuen Fassung überschreiben */
	refresh?: boolean;
	/** Liste aus der Antwort ziehen. */
	list: (data: unknown) => Item[];
	/** Cursor für die nächste (ältere) Seite. */
	nextCursor: (data: unknown, items: Item[]) => string | undefined;
	idField: string;
	timeField: string;
	/** Börse (api_records.source), Standard 'bitget' */
	source?: 'bitget' | 'kucoin';
	/** Eigener Abruf eines Zeitfensters (andere Börse/Paginierung) statt Bitget-Cursor */
	fetchWindow?: (start: number, end: number) => Promise<Item[]>;
	/** ID aus dem Datensatz bilden, wenn es kein eindeutiges ID-Feld gibt */
	makeId?: (raw: Item) => string | null;
}

const arr = (x: unknown): Item[] => (Array.isArray(x) ? (x as Item[]) : []);
const field = (o: unknown, k: string) => (o && typeof o === 'object' ? (o as Item)[k] : undefined);
const lastId = (items: Item[], k: string) => {
	const v = items[items.length - 1]?.[k];
	return v === undefined || v === null ? undefined : String(v);
};

/** Bitget-API v2: Kontobuchungen, Fills, Ein- und Auszahlungen. */
export const ENDPOINTS: EndpointDef[] = [
	{
		key: 'spot_bills',
		label: 'Spot-Kontobuchungen',
		path: '/api/v2/spot/account/bills',
		params: {},
		limit: 500,
		windowDays: 30,
		maxDays: 89,
		role: 'ledger',
		list: arr,
		nextCursor: (_d, items) => lastId(items, 'billId'),
		idField: 'billId',
		timeField: 'cTime'
	},
	{
		key: 'futures_bills_usdt',
		label: 'Futures-Kontobuchungen (USDT-M)',
		path: '/api/v2/mix/account/bill',
		params: { productType: 'USDT-FUTURES' },
		limit: 100,
		windowDays: 30,
		maxDays: 89,
		role: 'ledger',
		list: (d) => arr(field(d, 'bills')),
		nextCursor: (d, items) => (field(d, 'endId') as string | undefined) ?? lastId(items, 'billId'),
		idField: 'billId',
		timeField: 'cTime'
	},
	{
		key: 'futures_fills_usdt',
		label: 'Futures-Fills (USDT-M)',
		path: '/api/v2/mix/order/fill-history',
		params: { productType: 'USDT-FUTURES' },
		limit: 100,
		windowDays: 7,
		maxDays: 365,
		role: 'detail',
		list: (d) => arr(field(d, 'fillList')),
		nextCursor: (d, items) => (field(d, 'endId') as string | undefined) ?? lastId(items, 'tradeId'),
		idField: 'tradeId',
		timeField: 'cTime'
	},
	{
		key: 'deposits',
		refresh: true,
		label: 'Einzahlungen',
		path: '/api/v2/spot/wallet/deposit-records',
		params: {},
		limit: 100,
		windowDays: 30,
		maxDays: 365,
		role: 'detail',
		list: arr,
		nextCursor: (_d, items) => lastId(items, 'orderId'),
		idField: 'orderId',
		timeField: 'cTime'
	},
	{
		key: 'withdrawals',
		refresh: true,
		label: 'Auszahlungen',
		path: '/api/v2/spot/wallet/withdrawal-records',
		params: {},
		limit: 100,
		windowDays: 30,
		maxDays: 365,
		role: 'detail',
		list: arr,
		nextCursor: (_d, items) => lastId(items, 'orderId'),
		idField: 'orderId',
		timeField: 'cTime'
	}
];

export const endpointByKey = (k: string) => ENDPOINTS.find((e) => e.key === k) ?? KUCOIN_ENDPOINTS.find((e) => e.key === k);

const KC_DAY = 86_400_000;
/**
 * KuCoin (global): Kontobuchungen aller klassischen Konten (Main/Trade, inkl. Earn-Zinsen), Ein- und Auszahlungen.
 * Kontobuchungen: höchstens 24 h je Anfrage, Historie 1 Jahr (KuCoin-Doku 11/2026). Ein-/Auszahlungen: Fenster
 * vorsichtshalber 7 Tage, Reichweite laut Export ebenfalls 1 Jahr.
 */
export const KUCOIN_ENDPOINTS: EndpointDef[] = [
	{
		key: 'kucoin_ledgers',
		label: 'KuCoin: Kontobuchungen',
		source: 'kucoin',
		path: '/api/v1/accounts/ledgers',
		params: {},
		limit: 500,
		windowDays: 1,
		maxDays: 364,
		role: 'ledger',
		list: arr,
		nextCursor: () => undefined,
		idField: 'id',
		timeField: 'createdAt',
		fetchWindow: (start, end) => kucoinPaged('/api/v1/accounts/ledgers', { startAt: start, endAt: Math.min(end, start + KC_DAY) })
	},
	{
		key: 'kucoin_deposits',
		label: 'KuCoin: Einzahlungen',
		source: 'kucoin',
		refresh: true,
		path: '/api/v1/deposits',
		params: {},
		limit: 500,
		windowDays: 7,
		maxDays: 364,
		role: 'detail',
		list: arr,
		nextCursor: () => undefined,
		idField: 'id',
		timeField: 'createdAt',
		// ältere Datensätze haben teils keine id → Tx-Hash bzw. Zeit + Coin + Menge
		makeId: (r) => (r.id ? String(r.id) : r.walletTxId ? `tx:${r.walletTxId}` : `${r.createdAt}:${r.currency}:${r.amount}`),
		fetchWindow: (start, end) => kucoinPaged('/api/v1/deposits', { startAt: start, endAt: end }, 100)
	},
	{
		key: 'kucoin_withdrawals',
		label: 'KuCoin: Auszahlungen',
		source: 'kucoin',
		refresh: true,
		path: '/api/v1/withdrawals',
		params: {},
		limit: 500,
		windowDays: 7,
		maxDays: 364,
		role: 'detail',
		list: arr,
		nextCursor: () => undefined,
		idField: 'id',
		timeField: 'createdAt',
		makeId: (r) => (r.id ? String(r.id) : r.walletTxId ? `tx:${r.walletTxId}` : `${r.createdAt}:${r.currency}:${r.amount}`),
		fetchWindow: (start, end) => kucoinPaged('/api/v1/withdrawals', { startAt: start, endAt: end }, 100)
	}
];

/** Alle Datensätze eines Zeitfensters (paginiert über idLessThan). */
export async function fetchWindow(ep: EndpointDef, start: number, end: number, maxPages = 50): Promise<Item[]> {
	if (ep.fetchWindow) return ep.fetchWindow(start, end);
	const out: Item[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const data = await bitgetGet(ep.path, {
			...ep.params,
			startTime: start,
			endTime: end,
			limit: ep.limit,
			idLessThan: cursor
		});
		const items = ep.list(data);
		out.push(...items);
		if (items.length < ep.limit) break;
		const next = ep.nextCursor(data, items);
		if (!next || next === cursor) break;
		cursor = next;
	}
	return out;
}

/** Frühester sinnvoller Startzeitpunkt für eine Schnittstelle. */
export const earliestStart = (ep: EndpointDef, now = Date.now()) => now - ep.maxDays * DAY;

/** Zerlegt einen Zeitraum in Fenster, die Bitget akzeptiert (neueste zuerst). */
export function windows(ep: EndpointDef, start: number, end: number) {
	const out: { start: number; end: number }[] = [];
	for (let e = end; e > start; e -= ep.windowDays * DAY) {
		out.push({ start: Math.max(start, e - ep.windowDays * DAY), end: e });
	}
	return out;
}

/**
 * Speichert Rohdatensätze unverändert; vorhandene (gleiche ID) werden übersprungen.
 * Ausnahme `refresh`: Ein-/Auszahlungen werden durch Bitgets neueste Fassung ersetzt (Status), „stored“ zählt dann auch Aktualisierungen.
 */
export async function storeRecords(
	admin: SupabaseClient,
	userId: string,
	importId: string | null,
	ep: EndpointDef,
	items: Item[]
) {
	let stored = 0;
	const rows = items
		.map((raw) => {
			const id = ep.makeId ? ep.makeId(raw) : raw[ep.idField];
			const t = Number(raw[ep.timeField]);
			if (id === undefined || id === null || !Number.isFinite(t)) return null;
			return {
				user_id: userId,
				import_id: importId,
				source: ep.source ?? 'bitget',
				endpoint: ep.key,
				record_id: String(id),
				ts: new Date(t).toISOString(),
				raw
			};
		})
		.filter((r) => r !== null);

	for (let i = 0; i < rows.length; i += 500) {
		const chunk = rows.slice(i, i + 500);
		const { error, count } = await admin
			.from('api_records')
			.upsert(chunk, { onConflict: 'user_id,source,endpoint,record_id', ignoreDuplicates: !ep.refresh, count: 'exact' });
		if (error) throw new Error(`Speichern ${ep.key}: ${error.message}`);
		stored += count ?? 0;
	}
	return { received: items.length, valid: rows.length, stored };
}

/** Der einzige Cockpit-User (Cron läuft ohne Session). */
export async function ownerId(admin: SupabaseClient): Promise<string> {
	const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 2 });
	if (error) throw new Error(error.message);
	if (data.users.length !== 1) throw new Error(`Erwartet genau einen User, gefunden: ${data.users.length}`);
	return data.users[0]!.id;
}

export const DAY_MS = DAY;
