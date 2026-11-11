import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { BACKUP_PAGE, BACKUP_TABLES, backupTable } from '$lib/backup/tables';
import { ownerId } from '$lib/server/bitget-sync';
import { supabaseAdmin } from '$lib/server/supabase-admin';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 30 };

/**
 * Datensicherung, seitenweise:
 *   GET /api/backup                         → Liste der Tabellen
 *   GET /api/backup?table=ct_rows&offset=0  → { rows, next } (next = null am Ende)
 * Zugriff mit Anmeldung (2FA) oder für die GitHub-Action mit „Authorization: Bearer BACKUP_SECRET“.
 * Nur lesend.
 */
export const GET: RequestHandler = async ({ url, request, locals }) => {
	const secret = env.BACKUP_SECRET?.trim();
	const bearer = request.headers.get('authorization');
	const viaSecret = !!secret && bearer === `Bearer ${secret}`;
	const claims = viaSecret ? null : await locals.getClaims();
	if (!viaSecret && claims?.aal !== 'aal2') error(401, 'Nicht autorisiert');

	const name = url.searchParams.get('table');
	if (!name) return json({ tables: BACKUP_TABLES.map((t) => ({ name: t.name, splitByMonth: !!t.splitByMonth })), page: BACKUP_PAGE });

	const table = backupTable(name);
	if (!table) error(400, 'Unbekannte Tabelle');
	const offset = Number(url.searchParams.get('offset') ?? 0);
	if (!Number.isInteger(offset) || offset < 0) error(400, 'Ungültiger Offset');

	const admin = supabaseAdmin();
	const userId = claims?.sub ?? (await ownerId(admin));

	// Beim ersten Abruf auch die Gesamtzahl, damit die Sicherung ihre Vollständigkeit prüfen kann
	let q = admin.from(table.name).select(table.select, offset === 0 ? { count: 'exact' } : undefined);
	if (table.owned) q = q.eq('user_id', userId);
	for (const col of table.order) q = q.order(col, { ascending: true });
	const { data, count, error: err } = await q.range(offset, offset + BACKUP_PAGE - 1);
	if (err) error(500, `${table.name}: ${err.message}`);

	const rows = data ?? [];
	return json(
		{ table: table.name, offset, total: count ?? undefined, rows, next: rows.length < BACKUP_PAGE ? null : offset + rows.length },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
