import { describe, expect, it } from 'vitest';
import { mapApiLedger, type ApiLedgerRow } from './bitget-api';
import { classify } from './classify';

const row = (p: Partial<ApiLedgerRow>): ApiLedgerRow => ({
	tx_id: 'x',
	endpoint: 'spot_bills',
	ts: '2026-11-10T08:00:00+00:00',
	day: '2026-11-10',
	business_type: null,
	group_type: null,
	coin: 'USDT',
	size: '0',
	fees: '0',
	biz_order_id: null,
	symbol: null,
	n: 1,
	...p
});

const cats = (rows: ApiLedgerRow[]) => mapApiLedger(rows).map((e) => classify(e));

describe('mapApiLedger (Formate aus der Bitget-Inventur 11/2026)', () => {
	it('Zinsen, Airdrop und Coupon sind Earn', () => {
		expect(
			cats([
				row({ business_type: 'BATCH_INTEREST_USER_IN', group_type: 'financial', coin: 'BGB', size: '0.00000348' }),
				row({ business_type: 'LOCK_INTEREST_USER_IN', group_type: 'financial', coin: 'POL', size: '0.00016' }),
				row({ business_type: 'AIRDROP_REWARDS', group_type: 'other', size: '2.354' }),
				row({ business_type: 'CASH_COUPON_ACTIVITY_USER_IN', group_type: 'other', size: '0.638' })
			])
		).toEqual(['earn_income', 'earn_income', 'earn_income', 'earn_income']);
	});

	it('Earn-Ein-/Ausstieg und Kontoumbuchungen sind interne Umbuchungen', () => {
		expect(
			cats([
				row({ business_type: 'SINGLE_USER_OUT', group_type: 'financial', size: '-11.0089' }),
				row({ business_type: 'SINGLE_RELEASE_USER_IN', group_type: 'financial', size: '3000' }),
				row({ business_type: 'TRANSFER_OUT', group_type: 'transfer', size: '-3000' }),
				row({ endpoint: 'futures_bills_usdt', business_type: 'trans_from_exchange', size: '3000' })
			])
		).toEqual(['transfer', 'transfer', 'transfer', 'transfer']);
	});

	it('Auszahlung: Menge plus Gebühr verlassen das Konto', () => {
		const [e] = mapApiLedger([row({ business_type: 'WITHDRAW', group_type: 'withdraw', coin: 'SOL', size: '-0.994', fees: '-0.006' })]);
		expect(classify(e!)).toBe('external_out');
		expect([e!.sell_amount, e!.fee_amount, e!.fee_cur]).toEqual(['0.994', '0.006', 'SOL']);
	});

	it('Spot-Trade wird über die bizOrderId gepaart', () => {
		const [e] = mapApiLedger([
			row({ tx_id: 'a', business_type: 'TRADE_BUY', group_type: 'trade', coin: 'BTC', size: '0.0012', fees: '-0.0000012', biz_order_id: 'o1' }),
			row({ tx_id: 'b', business_type: 'TRADE_BUY', group_type: 'trade', coin: 'USDT', size: '-100', fees: '0', biz_order_id: 'o1' })
		]);
		expect(classify(e!)).toBe('spot_trade');
		expect([e!.buy_amount, e!.buy_cur, e!.sell_amount, e!.sell_cur, e!.fee_amount, e!.fee_cur]).toEqual(['0.0012', 'BTC', '100', 'USDT', '0.0000012', 'BTC']);
	});

	it('echter Spot-Verkauf vom 10.11.2026 (groupType transaction, BUY/SELL je Seite)', () => {
		const [e] = mapApiLedger([
			row({ tx_id: '1504041705644924932', business_type: 'SELL', group_type: 'transaction', coin: 'BTC', size: '-0.00011900', fees: '0.00000000', biz_order_id: '1504041705566617602' }),
			row({ tx_id: '1504041705644924931', business_type: 'BUY', group_type: 'transaction', coin: 'USDT', size: '8.78746575', fees: '-0.00878746', biz_order_id: '1504041705566617602' })
		]);
		expect(classify(e!)).toBe('spot_trade');
		expect([e!.sell_amount, e!.sell_cur, e!.buy_amount, e!.buy_cur, e!.fee_amount, e!.fee_cur]).toEqual(['0.000119', 'BTC', '8.78746575', 'USDT', '0.00878746', 'USDT']);
	});

	it('echter Futures-Trade vom 10.11.2026 (open_short / close_short)', () => {
		const f = { endpoint: 'futures_bills_usdt', coin: 'USDT' };
		const out = mapApiLedger([
			row({ ...f, tx_id: '1504031764328910850', business_type: 'open_short', size: '0', fees: '-0.8147328' }),
			row({ ...f, tx_id: '1504032311173877770', business_type: 'close_short', size: '0.54032079', fees: '-0.70749054' })
		]);
		expect(out.map((e) => [classify(e), e.buy_amount ?? `-${e.sell_amount}`])).toEqual([
			['kap_fee', '-0.8147328'],
			['kap_pnl', '0.54032079'],
			['kap_fee', '-0.70749054']
		]);
	});

	it('Futures: Schließen ergibt Ergebnis und Gebühr getrennt, Funding separat', () => {
		const f = { endpoint: 'futures_bills_usdt' };
		const out = mapApiLedger([
			row({ ...f, tx_id: 'c', business_type: 'close_long', size: '12.5', fees: '-0.3' }),
			row({ ...f, tx_id: 'd', business_type: 'open_short', size: '0', fees: '-0.2' }),
			row({ ...f, tx_id: 'e', business_type: 'contract_settle_fee', size: '-0.05' })
		]);
		expect(out.map((e) => [e.tx_id, classify(e)])).toEqual([
			['c', 'kap_pnl'],
			['c:fee', 'kap_fee'],
			['d:fee', 'kap_fee'],
			['e', 'kap_funding']
		]);
	});

	it('Unbekannte Spot-Art wird nicht still zugeordnet', () => {
		expect(cats([row({ business_type: 'SOMETHING_NEW', group_type: 'other', size: '1' })])).toEqual(['unknown']);
	});
});
