/**
 * Tabellen der Datensicherung. Beträge (numeric) und JSON-Rohdaten werden als Text gelesen,
 * damit beim Export nichts gerundet wird – die Sicherung enthält die Werte exakt wie in der Datenbank.
 * Abgeleitete Spalten (z. B. ct_rows.venue/account) fehlen bewusst; sie entstehen beim Einspielen neu.
 */
export interface BackupTable {
	name: string;
	select: string;
	order: string[];
	/** Tabelle gehört einem User (Filter auf user_id) oder ist global */
	owned: boolean;
	/** Datei in der Sicherung nach Monat (Spalte ts) aufteilen – für wachsende Tabellen */
	splitByMonth?: boolean;
}

export const BACKUP_TABLES: BackupTable[] = [
	{
		name: 'imports',
		select: 'id,user_id,source,file_name,file_sha256,source_timezone,row_count,status,note,created_at,finished_at',
		order: ['created_at', 'id'],
		owned: true
	},
	{
		name: 'ct_rows',
		select:
			'id,user_id,import_id,tx_id,type,buy_amount::text,buy_cur,sell_amount::text,sell_cur,fee_amount::text,fee_cur,exchange,trade_group,comment,date_raw,lpn,ts',
		order: ['id'],
		owned: true
	},
	{
		name: 'api_records',
		select: 'id,user_id,import_id,source,endpoint,record_id,ts,raw::text,fetched_at',
		order: ['id'],
		owned: true,
		splitByMonth: true
	},
	{
		name: 'manual_adjustments',
		select: 'id,user_id,ts,venue,asset,amount::text,cost_eur::text,kind,note,created_at',
		order: ['created_at', 'id'],
		owned: true
	},
	{
		name: 'report_snapshots',
		select: 'id,user_id,tax_year,engine_version,params::text,summary::text,detail::text,note,created_at',
		order: ['created_at', 'id'],
		owned: true
	},
	{ name: 'ticker_map', select: 'source,source_ticker,asset,note', order: ['source', 'source_ticker'], owned: false },
	{ name: 'fx_rates', select: 'rate_date,pair,rate::text,source,fetched_at', order: ['rate_date', 'pair', 'source'], owned: false }
];

export const backupTable = (name: string) => BACKUP_TABLES.find((t) => t.name === name);

/** Seitengröße: Supabase liefert standardmäßig höchstens 1000 Zeilen pro Anfrage. */
export const BACKUP_PAGE = 1000;
