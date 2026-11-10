-- =============================================================================
-- Bitget-API-Buchungen für die Steuerberechnung
--   * Doppelzählung ausgeschlossen: CoinTracking-Tx-IDs sind Bitget-billIds
--     (teils mit Suffix wie „_earn“). API-Buchungen, deren billId bereits im
--     CoinTracking-Import steckt, werden ignoriert.
--   * Earn-Zinsen pro Tag, Art und Coin zusammengefasst (wie in v_ledger)
-- =============================================================================

alter table public.ct_rows
	add column bill_id text generated always as (split_part(tx_id, '_', 1)) stored;
create index ct_rows_user_bill on public.ct_rows (user_id, bill_id);

create or replace view public.v_api_ledger
with (security_invoker = true) as
with base as (
	select
		a.record_id,
		a.endpoint,
		a.ts,
		to_char(a.ts at time zone 'Europe/Berlin', 'YYYY-MM-DD') as day,
		a.raw ->> 'businessType' as business_type,
		a.raw ->> 'groupType' as group_type,
		a.raw ->> 'coin' as coin,
		coalesce(a.raw ->> 'size', a.raw ->> 'amount') as size,
		coalesce(a.raw ->> 'fees', a.raw ->> 'fee') as fees,
		a.raw ->> 'bizOrderId' as biz_order_id,
		a.raw ->> 'symbol' as symbol
	from public.api_records a
	where a.source = 'bitget'
		and a.endpoint in ('spot_bills', 'futures_bills_usdt')
		and not exists (
			select 1 from public.ct_rows c
			where c.user_id = a.user_id and c.bill_id = a.record_id
		)
)
select
	record_id as tx_id, endpoint, ts, day, business_type, group_type, coin,
	size, fees, biz_order_id, symbol, 1 as n
from base
where not (endpoint = 'spot_bills' and business_type in ('BATCH_INTEREST_USER_IN', 'LOCK_INTEREST_USER_IN'))
union all
select
	'agg-api:' || business_type || '|' || coin || '|' || day,
	endpoint,
	max(ts),
	day,
	business_type,
	max(group_type),
	coin,
	sum(size::numeric)::text,
	sum(coalesce(fees, '0')::numeric)::text,
	null,
	null,
	count(*)::int
from base
where endpoint = 'spot_bills' and business_type in ('BATCH_INTEREST_USER_IN', 'LOCK_INTEREST_USER_IN')
group by endpoint, business_type, coin, day;

grant select on public.v_api_ledger to authenticated;
