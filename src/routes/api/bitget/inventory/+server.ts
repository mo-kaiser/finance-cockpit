import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

interface Slim {
	endpoint: string;
	record_id: string;
	ts: string;
	gt: string | null;
	bt: string | null;
	ty: string | null;
	side: string | null;
}

/** Buchungsarten in den gespeicherten Bitget-Rohdaten: Anzahl, Zeitraum, Beispiel. */
export const GET: RequestHandler = async ({ locals }) => {
	const claims = await locals.getClaims();
	if (claims?.aal !== 'aal2') error(401, 'Nicht angemeldet');
	const db = locals.supabase;

	const rows: Slim[] = [];
	for (let from = 0; ; from += 1000) {
		const { data, error: e } = await db
			.from('api_records')
			.select('endpoint,record_id,ts,gt:raw->>groupType,bt:raw->>businessType,ty:raw->>type,side:raw->>tradeSide')
			.eq('source', 'bitget')
			.order('id')
			.range(from, from + 999);
		if (e) error(500, e.message);
		rows.push(...(data as Slim[]));
		if (data.length < 1000) break;
	}

	const { data: ctLast } = await db.from('ct_rows').select('ts').order('ts', { ascending: false }).limit(1);
	const ctEnd = ctLast?.[0]?.ts ?? null;

	const groups = new Map<string, { endpoint: string; group: string | null; kind: string; n: number; afterCt: number; first: string; last: string; sampleId: string }>();
	for (const r of rows) {
		const kind = r.bt ?? r.ty ?? r.side ?? '–';
		const k = `${r.endpoint}|${r.gt ?? ''}|${kind}`;
		const g = groups.get(k);
		const after = ctEnd !== null && r.ts > ctEnd ? 1 : 0;
		if (!g) groups.set(k, { endpoint: r.endpoint, group: r.gt, kind, n: 1, afterCt: after, first: r.ts, last: r.ts, sampleId: r.record_id });
		else {
			g.n++;
			g.afterCt += after;
			if (r.ts < g.first) g.first = r.ts;
			if (r.ts > g.last) g.last = r.ts;
		}
	}

	const list = [...groups.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint) || b.n - a.n);

	// Ein Beispiel pro Buchungsart
	const samples: Record<string, unknown> = {};
	await Promise.all(
		list.map(async (g) => {
			const { data } = await db
				.from('api_records')
				.select('raw')
				.eq('endpoint', g.endpoint)
				.eq('record_id', g.sampleId)
				.limit(1);
			samples[`${g.endpoint}|${g.group ?? ''}|${g.kind}`] = data?.[0]?.raw ?? null;
		})
	);

	return json({
		total: rows.length,
		ctEnd,
		groups: list.map((g) => ({ ...g, sample: samples[`${g.endpoint}|${g.group ?? ''}|${g.kind}`] }))
	});
};
