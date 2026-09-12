# Nexora Command Center V4

Dashboard trading crypto berbasis HTML — paper trading otomatis, analisis Phase 2 MTF, backtest engine, dan journal lengkap.

## Fitur Utama

- **Scanner V4.4** — 40+ pairs, funding real dari Bitget+BingX+Gate.io
- **Paper Bot** — auto-scan 15 menit, limit order otomatis, monitor SL/TP
- **Phase 2 Analysis** — MTF D1→H4→H1→M15, order flow, best setup
- **Backtest Engine** — single pair + multi 10 pairs dari candle Bitget (CoinGecko fallback)
- **Trading Journal** — equity curve, lesson wall, Kelly Criterion
- **Telegram Alert** — notifikasi ke HP saat entry signal / SL / TP
- **Persistence** — auto-save localStorage + export JSON backup

## Data Sources

| Data | Sumber | Status |
|---|---|---|
| Harga + Funding + OI | Bitget API v2 | Real-time |
| Funding backup | BingX + Gate.io | Real-time |
| Fear & Greed | Alternative.me | Harian |
| MTF klines | Bitget futures candles | Real-time |
| OHLC chart + RSI/MACD | Bitget futures candles | Cached 1 menit |
| OHLC fallback | CoinGecko | Dipakai bila Bitget gagal |

## Cara Pakai Lokal

```bash
# Cukup buka file di browser
open Nexora_V4_Clean.html
# atau pakai Live Server di VS Code
```

## Deploy ke VPS lewat VS Code Remote-SSH

1. Buka folder remote `/var/www/html/nexora` melalui Remote-SSH.
2. Salin isi `Nexora_V4_Clean.html` ke file remote `index.html`, lalu simpan.
3. Pastikan dashboard dibuka melalui `http://43.156.52.203:18084/`.
4. Tekan `Ctrl+Shift+R`, kemudian klik `Refresh`.

File utama frontend hanya satu: `Nexora_V4_Clean.html`.

## Proxy API VPS

`server.js` adalah proxy HTTP untuk port `18085`. Salin file tersebut ke folder
proxy di VPS (contoh `/home/ubuntu/nexora-proxy/server.js`), lalu restart proses
Node yang menjalankannya. Endpoint `/healthz` harus menampilkan `ok: true`.
Proxy mencakup Bitget, BingX, Gate.io, Alternative.me, CoinGecko, dan CoinPaprika.
Proxy memakai modul bawaan Node.js dengan `node-fetch` sebagai fallback TLS.
Jalankan `npm install` satu kali di folder proxy, lalu gunakan `node server.js`
atau `npm start`.

Frontend memakai proxy untuk Bitget, BingX, Gate.io, dan Alternative.me agar
browser tidak terkena CORS. CoinGecko hanya cadangan karena API publiknya dapat
membatasi IP VPS.

## Struktur File

```
Nexora_V4_Clean.html    # Dashboard utama (single file, semua built-in)
server.js               # Proxy API HTTP untuk VPS port 18085
README.md               # Dokumentasi ini
.gitignore              # Git ignore file
```

## Tech Stack

- Pure HTML/CSS/JavaScript (no framework, no build step)
- Node.js built-in HTTP proxy + node-fetch fallback (Node 18+)
- Highcharts 12.1.2 (CDN)
- Font Awesome 6.5.0 (CDN)

## Versi

- V4.4 — Minggu 13 September 2026
- Paper trading mode dengan 15-menit scan interval
- Harga, funding, dan candle memakai API exchange tanpa API key

---

> **Penting:** Dashboard ini untuk paper trading. Pastikan sudah profitable selama 30+ trades sebelum masuk live trading.
