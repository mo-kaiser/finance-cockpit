import type { SupabaseClient } from '@supabase/supabase-js';
import { bitgetGet } from './bitget';

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
	/** Liste aus der Antwort ziehen. */
	list: (data: unknown) => Item[];
	/** Cursor für die nächste (ältere) Seite. */
	nextCursor: (data: unknown, items: Item[]) => string | undefined;
	idField: string;
	timeField: string;
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

export const endpointByKey = (k: string) => ENDPOINTS.find((e) => e.key === k);

/** Alle Datensätze eines Zeitfensters (paginiert über idLessThan). */
export async function fetchWindow(ep: EndpointDef, start: number, end: number, maxPages = 50): Promise<Item[]> {
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

/** Speichert Rohdatensätze unverändert; vorhandene (gleiche ID) werden übersprungen. */
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
			const id = raw[ep.idField];
			const t = Number(raw[ep.timeField]);
			if (id === undefined || id === null || !Number.isFinite(t)) return null;
			return {
				user_id: userId,
				import_id: importId,
				source: 'bitget',
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
			.upsert(chunk, { onConflict: 'user_id,source,endpoint,record_id', ignoreDuplicates: true, count: 'exact' });
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
