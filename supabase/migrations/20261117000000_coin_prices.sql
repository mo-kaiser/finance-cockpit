-- =============================================================================
-- Tageskurse je Coin (Bitget-Tageskerzen, Schlusskurs in USDT)
--   * global wie fx_rates (keine user_id), vom Server mit dem Secret Key befüllt
--   * price_date = UTC-Tag der Kerze (Granularität 1Dutc), close = Schlusskurs
--   * Verwendung: Earn-Erträge (§ 22 Nr. 3) am Zuflusstag, Tausch Coin gegen Coin,
--     Anschaffungskosten von Zins-Beständen, Wertverlauf
-- =============================================================================

create table public.coin_prices (
	coin text not null,
	price_date date not null,
	close numeric not null check (close > 0),
	quote text not null default 'USDT',
	source text not null default 'bitget',
	fetched_at timestamptz not null default now(),
	primary key (coin, price_date, quote, source)
);

alter table public.coin_prices enable row level security;

create policy read_with_2fa on public.coin_prices for select to authenticated
	using ((select public.is_aal2()));

grant select on public.coin_prices to authenticated;
grant select, insert, update, delete on public.coin_prices to service_role;

-- Je Coin eine Zeile mit allen Kursen als JSON ({"2026-01-01": "93421.5", …}) –
-- der Browser lädt damit alle Kurse in einer Anfrage statt zehntausender Zeilen.
create view public.v_coin_prices
with (security_invoker = true) as
select
	coin,
	quote,
	source,
	min(price_date) as first_day,
	max(price_date) as last_day,
	count(*)::int as n,
	jsonb_object_agg(price_date::text, close::text) as prices
from public.coin_prices
group by coin, quote, source;

grant select on public.v_coin_prices to authenticated, service_role;
