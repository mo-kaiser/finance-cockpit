-- =============================================================================
-- Ledger-View für die Steuer-Engine und Schreibrechte für EZB-Kurse
-- =============================================================================

-- Bitget-Buchungen in der Form, die die Engine erwartet:
--   * Beträge als Text (exakt, keine Gleitkomma-Rundung im Browser)
--   * Kalendertag in Europe/Berlin
--   * Earn-Zinsen (Staking / Reward) pro Tag, Typ und Coin zusammengefasst
create or replace view public.v_ledger
with (security_invoker = true) as
with base as (
	select
		r.*,
		to_char(r.ts at time zone 'Europe/Berlin', 'YYYY-MM-DD') as day,
		(r.exchange = 'Bitget Spot' and r.type in ('Staking', 'Reward / Bonus')) as is_interest
	from public.ct_rows r
	where r.venue = 'bitget'
)
select
	tx_id,
	ts,
	day,
	type,
	buy_amount::text as buy_amount,
	buy_cur,
	sell_amount::text as sell_amount,
	sell_cur,
	fee_amount::text as fee_amount,
	fee_cur,
	exchange,
	trade_group,
	comment,
	1 as n
from base
where not is_interest
union all
select
	'agg:' || type || '|' || buy_cur || '|' || day as tx_id,
	max(ts) as ts,
	day,
	type,
	sum(buy_amount)::text as buy_amount,
	buy_cur,
	null,
	null,
	sum(fee_amount)::text,
	max(fee_cur),
	'Bitget Spot',
	null,
	min(comment),
	count(*)::int
from base
where is_interest
group by type, buy_cur, day;

grant select on public.v_ledger to authenticated;

-- EZB-Kurse dürfen vom eingeloggten User (mit 2FA) geschrieben werden;
-- der Abruf läuft über die Server-Route /api/fx/refresh mit seiner Session.
create policy insert_with_2fa on public.fx_rates for insert to authenticated
	with check ((select public.is_aal2()));
create policy update_with_2fa on public.fx_rates for update to authenticated
	using ((select public.is_aal2())) with check ((select public.is_aal2()));

grant insert, update on public.fx_rates to authenticated;
