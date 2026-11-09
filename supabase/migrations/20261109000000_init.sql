-- =============================================================================
-- Cockpit – Grundschema
-- Prinzipien:
--   * Rohbuchungen unverändert speichern (Originalstrings bleiben erhalten)
--   * Keine abgeleiteten Steuerwerte speichern – Ausnahme: eingefrorene Jahresreports
--   * Zugriff nur für den eigenen User UND nur mit zweitem Faktor (aal2)
--   * Tabellen werden explizit freigegeben (Data API exponiert nichts automatisch)
-- =============================================================================

-- Hilfsfunktion: Ist die aktuelle Session per 2FA bestätigt?
create or replace function public.is_aal2()
returns boolean
language sql
stable
set search_path = ''
as $$
	select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2';
$$;

-- -----------------------------------------------------------------------------
-- imports: jede Datei bzw. jeder API-Lauf
-- -----------------------------------------------------------------------------
create table public.imports (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	source text not null check (source in ('cointracking_csv', 'bitget_csv', 'kucoin_csv', 'bingx_csv', 'bitget_api')),
	file_name text,
	file_sha256 text,
	-- Zeitzone, in der die Datei ihre Zeitstempel ohne Offset angibt
	source_timezone text not null default 'Europe/Berlin',
	row_count integer,
	status text not null default 'running' check (status in ('running', 'done', 'failed')),
	note text,
	created_at timestamptz not null default now(),
	finished_at timestamptz,
	unique (user_id, file_sha256)
);

-- -----------------------------------------------------------------------------
-- ct_rows: CoinTracking „Trade Table“, Zeile für Zeile wie exportiert
-- Beträge als numeric (exakt aus dem Dezimalstring), Datum zusätzlich als Original
-- -----------------------------------------------------------------------------
create table public.ct_rows (
	id bigint generated always as identity primary key,
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	import_id uuid not null references public.imports (id) on delete cascade,
	tx_id text not null,
	type text not null,
	buy_amount numeric,
	buy_cur text,
	sell_amount numeric,
	sell_cur text,
	fee_amount numeric,
	fee_cur text,
	exchange text not null,
	trade_group text,
	comment text,
	date_raw text not null,
	lpn text,
	-- normalisierte Felder (deterministisch aus den Rohfeldern)
	ts timestamptz not null,
	venue text generated always as (lower(split_part(exchange, ' ', 1))) stored,
	account text generated always as (lower(nullif(substr(exchange, strpos(exchange, ' ') + 1), exchange))) stored,
	unique (user_id, tx_id)
);

create index ct_rows_user_ts on public.ct_rows (user_id, ts);
create index ct_rows_user_venue_ts on public.ct_rows (user_id, venue, ts);

-- ts aus date_raw + Zeitzone des Imports bilden (DST-sicher in Postgres statt im Browser)
create or replace function public.ct_rows_set_ts()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
	tz text;
begin
	select i.source_timezone into tz from public.imports i where i.id = new.import_id;
	new.ts := (new.date_raw::timestamp) at time zone coalesce(tz, 'Europe/Berlin');
	return new;
end;
$$;

create trigger ct_rows_set_ts
	before insert on public.ct_rows
	for each row execute function public.ct_rows_set_ts();

-- -----------------------------------------------------------------------------
-- api_records: Rohantworten der Börsen-APIs (ein Datensatz pro Buchung/Fill)
-- Wird vom Cron mit dem Secret Key geschrieben (user_id dort explizit gesetzt)
-- -----------------------------------------------------------------------------
create table public.api_records (
	id bigint generated always as identity primary key,
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	import_id uuid references public.imports (id) on delete set null,
	source text not null,           -- 'bitget'
	endpoint text not null,         -- z. B. '/api/v2/mix/account/bill'
	record_id text not null,        -- billId / tradeId der Börse
	ts timestamptz not null,
	raw jsonb not null,
	fetched_at timestamptz not null default now(),
	unique (user_id, source, endpoint, record_id)
);

create index api_records_user_ts on public.api_records (user_id, source, ts);

-- -----------------------------------------------------------------------------
-- manual_adjustments: bewusste, dokumentierte Korrekturen (z. B. fehlende Zugänge)
-- -----------------------------------------------------------------------------
create table public.manual_adjustments (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	ts timestamptz not null,
	venue text not null,
	asset text not null,
	amount numeric not null,
	cost_eur numeric,
	kind text not null check (kind in ('opening_balance', 'correction')),
	note text not null,
	created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- ticker_map: CoinTracking-/Börsen-Ticker → einheitliches Asset
-- -----------------------------------------------------------------------------
create table public.ticker_map (
	source text not null,
	source_ticker text not null,
	asset text not null,
	note text,
	primary key (source, source_ticker)
);

insert into public.ticker_map (source, source_ticker, asset, note) values
	('cointracking', 'SOL2', 'SOL', 'Solana'),
	('cointracking', 'POL3', 'POL', 'Polygon Ecosystem Token'),
	('cointracking', 'SUI3', 'SUI', 'Sui'),
	('cointracking', 'OP3', 'OP', 'Optimism'),
	('cointracking', 'SEI2', 'SEI', 'Sei');

-- -----------------------------------------------------------------------------
-- fx_rates: EZB EUR/USD und USDT/USD je Tag (global, vom Cron befüllt)
-- -----------------------------------------------------------------------------
create table public.fx_rates (
	rate_date date not null,
	pair text not null check (pair in ('EURUSD', 'USDTUSD')),
	rate numeric not null,
	source text not null,
	fetched_at timestamptz not null default now(),
	primary key (rate_date, pair, source)
);

-- -----------------------------------------------------------------------------
-- report_snapshots: eingefrorene Jahresreports (nur anlegen und lesen)
-- -----------------------------------------------------------------------------
create table public.report_snapshots (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	tax_year integer not null check (tax_year >= 2026),
	engine_version text not null,
	params jsonb not null default '{}'::jsonb,
	summary jsonb not null,
	detail jsonb not null,
	note text,
	created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Übersicht für das Dashboard (läuft mit den Rechten des Aufrufers)
-- -----------------------------------------------------------------------------
create view public.v_ct_overview
with (security_invoker = true) as
select
	venue,
	exchange,
	extract(year from ts at time zone 'Europe/Berlin')::int as year,
	type,
	count(*)::int as n,
	min(ts) as first_ts,
	max(ts) as last_ts
from public.ct_rows
group by venue, exchange, year, type;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.imports enable row level security;
alter table public.ct_rows enable row level security;
alter table public.api_records enable row level security;
alter table public.manual_adjustments enable row level security;
alter table public.ticker_map enable row level security;
alter table public.fx_rates enable row level security;
alter table public.report_snapshots enable row level security;

create policy own_rows on public.imports for all to authenticated
	using (user_id = (select auth.uid()) and (select public.is_aal2()))
	with check (user_id = (select auth.uid()) and (select public.is_aal2()));

create policy own_rows on public.ct_rows for all to authenticated
	using (user_id = (select auth.uid()) and (select public.is_aal2()))
	with check (user_id = (select auth.uid()) and (select public.is_aal2()));

create policy own_rows on public.api_records for select to authenticated
	using (user_id = (select auth.uid()) and (select public.is_aal2()));

create policy own_rows on public.manual_adjustments for all to authenticated
	using (user_id = (select auth.uid()) and (select public.is_aal2()))
	with check (user_id = (select auth.uid()) and (select public.is_aal2()));

create policy read_with_2fa on public.ticker_map for select to authenticated
	using ((select public.is_aal2()));
create policy write_with_2fa on public.ticker_map for insert to authenticated
	with check ((select public.is_aal2()));
create policy update_with_2fa on public.ticker_map for update to authenticated
	using ((select public.is_aal2())) with check ((select public.is_aal2()));

create policy read_with_2fa on public.fx_rates for select to authenticated
	using ((select public.is_aal2()));

create policy own_read on public.report_snapshots for select to authenticated
	using (user_id = (select auth.uid()) and (select public.is_aal2()));
create policy own_insert on public.report_snapshots for insert to authenticated
	with check (user_id = (select auth.uid()) and (select public.is_aal2()));

-- =============================================================================
-- Grants (anon bekommt nichts; Snapshots sind unveränderlich)
-- =============================================================================
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on public.imports to authenticated;
grant select, insert, delete on public.ct_rows to authenticated;
grant select on public.api_records to authenticated;
grant select, insert, update, delete on public.manual_adjustments to authenticated;
grant select, insert, update on public.ticker_map to authenticated;
grant select on public.fx_rates to authenticated;
grant select, insert on public.report_snapshots to authenticated;
grant select on public.v_ct_overview to authenticated;
grant usage on all sequences in schema public to authenticated;
