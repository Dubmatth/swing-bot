/**
 * Petit tableau de bord HTTP en lecture seule pour le runner papier —
 * cash, positions ouvertes avec prix live et P&L latent, courbe du cash
 * dans le temps. N'écoute que sur localhost : consultation via tunnel SSH
 * uniquement, jamais exposé publiquement (voir deploy/README.md).
 *
 * Usage : node --experimental-strip-types scripts/dashboard.ts
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPortfolioSnapshot } from '../src/live/statePersistence.ts';
import { fetchKrakenPairMappings } from '../src/live/krakenAssetPairs.ts';
import { fetchTickerPrices } from '../src/live/krakenTicker.ts';
import { UNIVERSE } from '../src/config/universe.ts';
import type { Trade } from '../src/backtest/portfolio.ts';

const PORT = 8080;
const HOST = '127.0.0.1'; // jamais 0.0.0.0 — aucune exposition publique
const STATE_DIR = join(process.cwd(), 'data', 'live-state');
const PORTFOLIO_PATH = join(STATE_DIR, 'portfolio.json');
const TRADES_PATH = join(STATE_DIR, 'trades.jsonl');
const INITIAL_CASH = 10_000; // valeur de départ fixée par scripts/run-paper.ts

async function loadTradeLog(): Promise<readonly Trade[]> {
  let text: string;
  try {
    text = await readFile(TRADES_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Trade);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderCashChart(trades: readonly Trade[]): string {
  if (trades.length === 0) {
    return '<p>Pas encore de trade — aucune courbe à afficher.</p>';
  }

  let cash = INITIAL_CASH;
  const points: { time: number; cash: number }[] = [{ time: trades[0]!.time, cash }];
  for (const t of trades) {
    cash += t.side === 'buy' ? -(t.quantity * t.price + t.fee) : t.quantity * t.price - t.fee;
    points.push({ time: t.time, cash });
  }

  const width = 760;
  const height = 220;
  const pad = 30;
  const minCash = Math.min(...points.map((p) => p.cash));
  const maxCash = Math.max(...points.map((p) => p.cash));
  const spanCash = maxCash - minCash || 1;
  const minTime = points[0]!.time;
  const maxTime = points[points.length - 1]!.time;
  const spanTime = maxTime - minTime || 1;

  const toX = (t: number): number => pad + ((t - minTime) / spanTime) * (width - 2 * pad);
  const toY = (c: number): number => height - pad - ((c - minCash) / spanCash) * (height - 2 * pad);

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(p.time).toFixed(1)} ${toY(p.cash).toFixed(1)}`)
    .join(' ');

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:#0d1117;border-radius:8px">
      <path d="${path}" fill="none" stroke="#58a6ff" stroke-width="2" />
      <text x="${pad}" y="16" fill="#8b949e" font-size="12">${maxCash.toFixed(0)} €</text>
      <text x="${pad}" y="${height - pad + 16}" fill="#8b949e" font-size="12">${minCash.toFixed(0)} €</text>
    </svg>`;
}

async function renderPage(): Promise<string> {
  const portfolio = await loadPortfolioSnapshot(PORTFOLIO_PATH);
  const trades = await loadTradeLog();

  if (!portfolio) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>swing-bot</title></head>
<body style="font-family:monospace;background:#0d1117;color:#c9d1d9;padding:2rem">
<h1>swing-bot — trading papier</h1>
<p>Aucun état persisté trouvé — le runner n'a encore effectué aucun trade.</p>
</body></html>`;
  }

  let priceBySymbol: ReadonlyMap<string, number> = new Map();
  let priceError: string | undefined;
  if (portfolio.positions.size > 0) {
    try {
      const mappings = await fetchKrakenPairMappings(
        UNIVERSE.filter((p) => portfolio.positions.has(p.symbol)),
      );
      priceBySymbol = await fetchTickerPrices({ mappings });
    } catch (err) {
      priceError = err instanceof Error ? err.message : String(err);
    }
  }

  let equity = portfolio.cash;
  const rows: string[] = [];
  for (const position of portfolio.positions.values()) {
    const livePrice = priceBySymbol.get(position.symbol);
    const valeurEntree = position.quantity * position.entryPrice;
    const valeurLive = livePrice !== undefined ? position.quantity * livePrice : undefined;
    const pnl = valeurLive !== undefined ? valeurLive - valeurEntree : undefined;
    equity += valeurLive ?? valeurEntree;

    rows.push(`
      <tr>
        <td>${escapeHtml(position.symbol)}</td>
        <td>${position.quantity.toFixed(6)}</td>
        <td>${position.entryPrice.toFixed(4)} €</td>
        <td>${livePrice !== undefined ? `${livePrice.toFixed(4)} €` : '—'}</td>
        <td style="color:${pnl === undefined ? '#8b949e' : pnl >= 0 ? '#3fb950' : '#f85149'}">
          ${pnl === undefined ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} €`}
        </td>
      </tr>`);
  }

  const recentTrades = trades
    .slice(-15)
    .reverse()
    .map(
      (t) => `
      <tr>
        <td>${new Date(t.time * 1000).toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td>${t.side}</td>
        <td>${escapeHtml(t.symbol)}</td>
        <td>${t.quantity.toFixed(6)}</td>
        <td>${t.price.toFixed(4)} €</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="60">
  <title>swing-bot</title>
  <style>
    body { font-family: -apple-system, monospace; background:#0d1117; color:#c9d1d9; padding:2rem; }
    table { border-collapse: collapse; margin-top: 1rem; width: 100%; }
    th, td { text-align: left; padding: 4px 12px; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-weight: normal; }
    h1 { font-size: 1.2rem; }
    .stat { font-size: 1.8rem; }
    .label { color: #8b949e; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>swing-bot — trading papier (rafraîchi toutes les 60s)</h1>
  <div class="label">Équité estimée (cash + positions au prix actuel)</div>
  <div class="stat">${equity.toFixed(2)} €</div>
  <p class="label">Cash disponible : ${portfolio.cash.toFixed(2)} € — ${portfolio.positions.size} position(s) ouverte(s)</p>
  ${priceError ? `<p style="color:#f85149">Prix live indisponibles : ${escapeHtml(priceError)}</p>` : ''}

  <h2>Courbe du cash</h2>
  ${renderCashChart(trades)}

  <h2>Positions ouvertes</h2>
  <table>
    <tr><th>Paire</th><th>Quantité</th><th>Prix d'entrée</th><th>Prix actuel</th><th>P&amp;L latent</th></tr>
    ${rows.join('') || '<tr><td colspan="5">Aucune position ouverte.</td></tr>'}
  </table>

  <h2>Derniers trades</h2>
  <table>
    <tr><th>Date</th><th>Sens</th><th>Paire</th><th>Quantité</th><th>Prix</th></tr>
    ${recentTrades || '<tr><td colspan="5">Aucun trade.</td></tr>'}
  </table>
</body>
</html>`;
}

const server = createServer((req, res) => {
  if (req.url !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  renderPage()
    .then((html) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    })
    .catch((err: unknown) => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Erreur : ${err instanceof Error ? err.message : String(err)}`);
    });
});

server.listen(PORT, HOST, () => {
  console.log(`Tableau de bord sur http://${HOST}:${PORT} (localhost uniquement)`);
});
