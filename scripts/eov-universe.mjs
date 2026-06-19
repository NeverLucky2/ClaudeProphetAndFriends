export const EOV_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'NFLX', 'ADBE',
  'BABA', 'SHOP', 'PYPL', 'ROKU', 'MRNA', 'BA', 'WMT', 'JPM', 'ZM', 'EBAY',
];
export const BENCHMARK = 'QQQ';
export const BENCHMARK2 = 'SPY';
export const eovUniverse = () => [...EOV_UNIVERSE];
export const allEovStockTickers = () => [...EOV_UNIVERSE, BENCHMARK, BENCHMARK2];
