# Nexora Command Center V4

Dashboard trading crypto berbasis HTML — paper trading otomatis, analisis Phase 2 MTF, backtest engine, dan journal lengkap.

## Fitur Utama

- **Scanner V4.4** — 40+ pairs, funding real dari Bitget+BingX+Gate.io
- **Paper Bot** — auto-scan 15 menit, limit order otomatis, monitor SL/TP
- **Phase 2 Analysis** — MTF D1→H4→H1→M15, order flow, best setup
- **Backtest Engine** — single pair + multi 10 pairs dari MEXC klines
- **Trading Journal** — equity curve, lesson wall, Kelly Criterion
- **Telegram Alert** — notifikasi ke HP saat entry signal / SL / TP
- **Persistence** — auto-save localStorage + export JSON backup

## Data Sources

| Data | Sumber | Status |
|---|---|---|
| Harga + Funding + OI | Bitget API v2 | Real-time |
| Funding backup | BingX + Gate.io | Real-time |
| Harga backup | MEXC API v3 | Real-time |
| Fear & Greed | Alternative.me | Harian |
| MTF klines | MEXC klines | Real-time |
| OHLC chart | CoinGecko | Per klik |

## Cara Pakai Lokal

```bash
# Cukup buka file di browser
open Nexora_V4_Clean.html
# atau pakai Live Server di VS Code
```

## Deploy ke VPS (Nginx)

```bash
# 1. Copy file ke server
scp Nexora_V4_Clean.html user@YOUR_VPS_IP:/var/www/html/nexora/index.html

# 2. Atau pakai script deploy (lihat deploy.sh)
chmod +x deploy.sh
./deploy.sh
```

## Deploy ke VPS (dengan password)

```bash
scp -P 22 Nexora_V4_Clean.html root@43.156.52.203:/var/www/html/nexora/index.html
```

## Struktur File

```
Nexora_V4_Clean.html    # Dashboard utama (single file, semua built-in)
README.md               # Dokumentasi ini
deploy.sh               # Script deploy ke VPS
.gitignore              # Git ignore file
```

## Tech Stack

- Pure HTML/CSS/JavaScript (no framework, no build step)
- Highcharts 12.1.2 (bundled via /vendor/highcharts/)
- Font Awesome 6.5.0 (CDN)

## Versi

- V4 Final — Sabtu 12 September 2026
- Paper trading mode dengan 15-menit scan interval
- Semua data real dari exchange API (no API key required)

---

> **Penting:** Dashboard ini untuk paper trading. Pastikan sudah profitable selama 30+ trades sebelum masuk live trading.
