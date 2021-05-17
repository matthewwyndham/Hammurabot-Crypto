const KrakenClient = require('kraken-api');
const d3 = require('d3-dsv');
const fs = require('fs');
const n = require('nonce')(); // use n() to generate better nonces than the kraken client

const [key, secret] = require('./tokens.js'); // module.exports = [ 'your-kraken-api-key', 'your-kraken-api-secret' ];
const kraken = new KrakenClient(key, secret);

let K_MAX_RATE_LIMIT = 20;
let K_DECAY = (1000/0.5)*1.02; // 1/2 per second, so multiply this by any integer to get that number of points back, with a little buffer
let K_SLOWMODE = 0;

// const methods = {
// 	public  : [ 'Time', 'Assets', 'AssetPairs', 'Ticker', 'Depth', 'Trades', 'Spread', 'OHLC' ],
// 	private : [ 'Balance', 'TradeBalance', 'OpenOrders', 'ClosedOrders', 'QueryOrders', 'TradesHistory', 'QueryTrades', 'OpenPositions', 'Ledgers', 'QueryLedgers', 'TradeVolume', 'AddOrder', 'CancelOrder', 'DepositMethods', 'DepositAddresses', 'DepositStatus', 'WithdrawInfo', 'Withdraw', 'WithdrawStatus', 'WithdrawCancel', 'GetWebSocketsToken' ],
// };

// cleaner kraken.api calls
async function k(_method, data={}) {
    // get back a little more than one point per api call, biggest call is 2 points. 
    // Refills at 0.5 points per second, so we want to get 3 points back just in case our api call is worth 2 points. We want to get ahead of the curve
    if (K_SLOWMODE > 0) { 
        await new Promise(resolve => setTimeout(resolve, K_DECAY * 3 )); 
        K_SLOWMODE -= 1; // kept triggering so I set this to slow it down longer
        if (K_SLOWMODE <= 0) { console.log('KRAKEN: Slowmode disabled') }
    }

    try {

        data.nonce = n(); // default nonce isn't as good
        let res = await kraken.api(_method, data);

        if (res.error == '') {
            return res.result;
        } else {
            throw res.error;
        }

    } catch (error) {

        if (String(error).includes('API:Rate limit exceeded')) {
            // check for api rate limit exceeded
            K_SLOWMODE = K_MAX_RATE_LIMIT
            console.log( 'KRAKEN: API:Rate limit exceeded' )
            console.log( 'KRAKEN: waiting 8 sec. for slight api rate limit refill, slowmode enabled' )
            await new Promise(resolve => setTimeout(resolve, K_DECAY * 4 ));
            console.log( 'KRAKEN: retrying...' )

            try {
                
                data.nonce = n(); // default nonce isn't as good
                let res = await kraken.api(_method, data);

                if (res.error == '') {
                    return res.result;
                } else {
                    throw res.error;
                }

            } catch (error) {
                console.log( error );
            }
        }

        console.log( error );
    }
}

// wrapper for console.log with pretty json parsing easier
function say(_message, _json=false) {
    // if (Array.isArray(_message)) {
    //     for (let mm of _message) {   
    //         if (!_json) {
    //             console.log(mm); 
    //         } else {
    //             console.log( JSON.stringify(mm, null, 3) );
    //         }
    //     }
    // } else {   
        if (!_json) {
            console.log(_message); 
        } else {
            console.log( JSON.stringify(_message, null, 3) );
        }
    // }
}

async function volatility(_assetpair, _say=true) {
    let min = 0;
    if (_assetpair.min) {
        min = _assetpair.min;
        _assetpair = _assetpair.name;
    }

    let res = {};

    res = await k('Ticker', {pair: _assetpair});
    // say(res);
    let high24 = res[_assetpair].h[1];
    let low24 = res[_assetpair].l[1];
    // say(res);

    res = await k('Trades', { pair: _assetpair })

    fs.writeFileSync( './trades/trades-'+_assetpair+'.csv', d3.csvFormat(res[_assetpair]) )

    let high = 0;
    let low = Infinity;

    let normalVolumeAVG_sum = 0;
    let normalVolumeAVG_count = 0;

    if (res[_assetpair]) {
        for (let r of res[_assetpair]) {
            try {
                if (parseFloat(r[0]) > high) { high = parseFloat(r[0]) }
                if (parseFloat(r[0]) < low) { low = parseFloat(r[0]) }
                normalVolumeAVG_sum += parseFloat(r[1]) / parseFloat(r[0])
                normalVolumeAVG_count += 1
            } catch (error) {
                say(error)
                say(r)
                continue;
            }
        }
    }

    if (normalVolumeAVG_count < 1) { normalVolumeAVG_count = 1 }
    let normalVolumeAVG = normalVolumeAVG_sum / normalVolumeAVG_count

    // errors with new assets
    if (res[_assetpair].length < 1) { return { name: _assetpair, potential:0, profit:0, profit24:0, percentRecent:0, percentDaily:0, latest:0, high:0, high24:0, low:0, low24:0, min:0, } }

    let now = res[_assetpair][res[_assetpair].length-2][0]; // get latest trade price
    let percentRecent = ((100*(now-low))/(high-low)).toFixed(2);
    if (percentRecent < 0.01) { percentRecent = 0.01 }
    let percentDaily = ((100*(now-low24))/(high24-low24)).toFixed(2)
    if (percentDaily < 0.01) { percentDaily = 0.01 }
 
    if (_say) {
        say([
            '------------------------------', 
            _assetpair+' ('+percentRecent+'% | '+percentDaily+'%)', 
            '------------------------------', 
            'Latest: '+now, 
            'High: '+high+' | '+high24, 
            'Low: '+low+' | '+low24, 
            (min != 0 ? 'Min: '+min+'\n' : '') ]);       
    }

    let profit = (((high - now) / now) * 100).toFixed(2)
    let profit24 = (((high24 - now) / now) * 100).toFixed(2)
    let potential = (profit * profit24)/(percentRecent*percentDaily)

    return {
        name: _assetpair,
        volume: normalVolumeAVG,
        potential: potential,
        profit: profit,
        profit24: profit24,
        percentRecent: percentRecent,
        percentDaily: percentDaily,
        latest: now,
        high: high,
        high24: high24,
        low: low,
        low24: low24,
        min: min,
    }
}

// ninety-nine-percent
// easily calculate approximately 100% of tradeable assets with enough to cover fees
// considering worst case fee is 0.26% as a taker
function nnp(_amount) { 
    if (typeof(_amount)=="string") {
        _amount = _amount.replace(/,/g, '');
    }
    _amount = ( isNaN(parseFloat(_amount)) ? 0 : parseFloat(_amount) )
    return _amount * 0.997; 
}

// Answers at: https://blockgeeks.com/guides/6-of-the-best-crypto-trading-bots-strategies-updated-list/
// run the show
(async ()=>{
    say('==============================================================');
    say('======== TRADEBOT v0.1 =======================================');
    say('==============================================================');
    say('');

    // DOGECOIN STRATEGY: utilize ML, predict changes in price, PROFIT

    // on init
    // get a month worth of data
    K_SLOWMODE = Number.MAX_SAFE_INTEGER; // this is gonna take a while so we want slowmode all the time

    let doge = 'XDGUSD'
    let week_ago = (new Date().setDate((new Date()).getDate()-7))
    let week_data = (await k('Trades', { pair: doge, since: week_ago }))[doge]
    let next_thousand = []

    let now = Date.now() / 1000;
    console.log('now: '+now);
    let latest_time = week_data[week_data.length-1][2]

    do {
        next_thousand = (await k('Trades', { pair: doge, since: latest_time }))[doge]
        latest_time = next_thousand[next_thousand.length-1][2]

        // kraken includes the row that you pass in the "since" time for, so there will be duplicate rows every thousand unless we pop()
        week_data = week_data.concat(next_thousand)
        
        say({'count': week_data.length, 'latest': latest_time})

    } while ( parseFloat(latest_time) < parseFloat(now) );

    // a future date will return [] ==> say( await k('Trades', { pair: doge, since: 1621295251 })) // returns []

    fs.writeFileSync( './doge_week.csv', d3.csvFormat(week_data) )
    say( 'updated doge_week.csv with '+week_data.length+' lines!')

    return; 
    // LOTS OF DIFFERENT ASSETS STRATEGY

    // LOOP

    // CHECK IF WE CAN TRADE (check if we have fiat currency)
    // CHECK FOR A POTENTIALLY GOOD TRADE
    // BUY CURRENCY AND MAKE SELL ORDER
    // SLEEP UNTIL WE HAVE SOLD AND CAN TRADE AGAIN


    // GET ALL TRADEABLE ASSET PAIRS
    let taps_raw = await k('AssetPairs');
    let taps_values = Object.values(taps_raw);
    let taps = Object.keys(taps_raw)
        .map( (value, index)=>{ return {name: value, min: taps_values[index].ordermin} })
        .filter( (e)=>{ 
            // BTC has 20 less markets than USD on kraken (atm) but is the next best candidate
            return e.name.includes('USD') // real us dollar has the most tradeability (of any stablecoin, on kraken)
            && !e.name.includes('USDT')
            && !e.name.includes('USDC')
            && !e.name.includes('DAI')
            && e.name[0] != 'Z' // ignore fiat currencies
            && !e.name.includes('AUDUSD') // australian dollars didn't have the Z in front of it
            && !e.name.includes('.') // ignore staked currency (i think)
            && !e.name.includes('MKR') // mkr was added recently and started at 10000, but is trading at much less
        })

    // STRATEGY: this is basically mean reversion
    let taps_vol = await Promise.all(taps.map( value=>{ return volatility(value, false) }))

    // export as csv so we can view the 
    fs.writeFileSync( './cryptos.csv', d3.csvFormat(taps_vol) )
    say('csv created/updated!')
    
    return '';

    // check how much of each asset we have
    let balance = await kraken.api('Balance', { nonce: n() } );
    console.log(balance);

    console.log( JSON.stringify( await kraken.api('Ticker', { pair: crypto[0]+fiat, nonce: n() }), null, 4) );
    // console.log( JSON.stringify( (await kraken.api('Trades', { pair: crypto[0]+fiat, nonce: n() })).result, null, 4) );
    console.log(await kraken.api('Trades', { pair: crypto[0]+fiat, nonce: n() }));
    // if we have 0 usd, then we want to sell crypto
    // else we want to buy crypto

    // SELLING:
    // 

    return;

    // testing
    try {
        // console.log( Object.values((await kraken.api('TradesHistory', { nonce: n() })).result.trades).filter(e=>{ return (e.type == "buy") }) )
        // console.log( (await kraken.api('Ticker', {pair: 'XXBTZUSD', nonce: n()})).result )
        console.log( (await kraken.api('AddOrder', {
            nonce: n(),
            ordertype: "limit",
            type: "buy",
            volume: "0.000382",
            price: "57460",
            pair: 'XXBTZUSD',
        })).result )
    } catch (error) {
        console.log(error)
    }

    // console.log( await kraken.api('Ticker', { pair: 'XXBTZUSD', nonce: n() }) );


/* algorithm
====================================================================================
api call rate limitting
====================================================================================
call counter starts at 0
ledger/trade history calls increase counter by 2
place/cancel order calls do not affect the counter
all other api calls increase the counter by 1

counter is reduced every couple of seconds
Intermediate users: max=20, count is reduced by 1 every 2 seconds

keep place/cancel orders down to 1 per second

====================================================================================
fee structure
====================================================================================
30- Day Volume (USD)	    Maker	Taker
$0 - $50,000	            0.16%	0.26%
$50,001 - $100,000	        0.14%	0.24%
$100,001 - $250,000	        0.12%	0.22%
$250,001 - $500,000	        0.10%	0.20%
$500,001 - $1,000,000	    0.08%	0.18%
$1,000,001 - $2,500,000	    0.06%	0.16%
$2,500,001 - $5,000,000	    0.04%	0.14%
$5,000,001 - $10,000,000	0.02%	0.12%
$10,000,000+	            0.00%	0.10%

WORST_CASE_FEES: Taker (buy & sell) = 0.52% of trade's quote currency volume

====================================================================================
general plan
====================================================================================
buy low, sell high

multiple times per day, 
wait for the price to drop and then buy a large chunk of asset,
wait for the price to rise more than WORST_CASE_FEES and then sell chunk of asset,
repeat

to check for price drop (and then buy):
- assume the price will generally go up over time
- check TIMEFRAME price highs and lows
- compare current price to see if it is closer to the TIMEFRAME low than the high
- check to ensure that the price has gone up past WORST_CASE_FEES before within TIMEFRAME

to check for price rise (and then sell):
- set limit order to sell at price greater than WORST_CASE_FEES with a margin for profit
- (using a limit order will ensure lower fees and require less logic to determine when to sell)

====================================================================================
interesting api endpoints
====================================================================================
Public:
/public/AssetPairs/ -> fees, fees_maker (if they are different)
/public/Ticker/ -> last trade closed array, low array, high array, 
Private:
/private/TradesHistory/ -> time, type, price, cost, fee, vol, margin
/private/OpenPositions/ -> wait for them to close
/private/AddOrder/ -> to actually make buys/sells
/private/CancelAllOrdersAfter/ -> dead mans switch to make sure you don't keep positions open after a network outage, (send this call every 15 to 30 seconds with a timeout of 60 seconds)

*/




})();


async function getPrice(_assetpair, _buy=true) {
    let last_price = 0;
    try {
        kraken_ticker = await kraken.api('Ticker', { pair: _assetpair, nonce: n() });
        if (_buy) { last_price = kraken_ticker.result[_assetpair].a[0]; }
        else { last_price = kraken_ticker.result[_assetpair].b[0]; }
    } catch (error) {
        console.log(error);
        return 0;
    }
    return last_price;
}

// account for fee probably
// get the market value
// pass in your funds (the second part of the assetpair) as the first parameter
// third parameter is the most recent price
// the third parameter is the percentage fee that kraken charges. Make sure you pass it in as a percent, and not as a decimal!
function getVolume(_funds, _price, _fee=0.5) {
    return (_funds / _price)*(1-(_fee/100));
}

async function getUSD() {
    let _funds = 0;
    try {
        _funds = ( await kraken.api('Balance', { nonce: n() }) ).result['ZUSD'];
    } catch (error) {
        console.log(error);
        _funds = 0;
    }

    return _funds;
}
async function liquid(_asset, _fee=0.5) {
    let _funds = 0;

    if (_asset == "bitcoin") {
        try {
            _funds = ( await kraken.api('Balance', { nonce: n() }) ).result['XXBT'];
        } catch (error) {
            console.log(error);
            _funds = 0;
        }
    } else if (_asset == 'usd' || _asset=="dollar") {
        getVolume( await getUSD(), await getPrice('XXBTZUSD') )
    }

    return _funds*(1-(_fee/100));
}

async function buyMarket(_assetpair) {
    try {
        let vol = getVolume( await getUSD(), await getPrice(_assetpair) );
        let results = await kraken.api('AddOrder', {
            nonce: n(),
            type: "buy",
            ordertype: "market",
            volume: vol,
            pair: _assetpair,
        });
        console.log(results);
    } catch (error) {
        console.log(error)
    }
}



