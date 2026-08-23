/** Événements du backtest, traités en FIFO synchrone par runBacktest. */
export type BacktestEvent =
  | { readonly kind: 'bar-closed'; readonly symbol: string; readonly t: number }
  | { readonly kind: 'order-requested'; readonly symbol: string; readonly side: 'buy' | 'sell'; readonly reason: string }
  | {
      readonly kind: 'order-filled';
      readonly symbol: string;
      readonly side: 'buy' | 'sell';
      readonly quantity: number;
      readonly price: number;
      readonly fee: number;
      readonly time: number;
    }
  | {
      readonly kind: 'order-rejected';
      readonly symbol: string;
      readonly side: 'buy' | 'sell';
      readonly reason: string;
      readonly time: number;
    };
