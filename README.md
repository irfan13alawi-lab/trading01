# Nexora Command Center V4

Dashboard trading crypto berbasis HTML — paper trading otomatis, analisis Phase 2 MTF, backtest engine, dan journal lengkap.

## Fitur Utama

- **Scanner V4.4** — 40+ pairs, funding real dari Bitget+BingX+Gate.io saat Futures
- **Market selector** — Bitget Futures, Bitget Spot, dan CoinGecko Spot
- **Paper Bot** — auto-scan 15 menit, MTF 4H/1H/30M/15M, indikator server-side, confluence gate, limit order otomatis, monitor SL/TP, dan batas risiko agregat
- **Phase 2 Analysis** — MTF D1→H4→H1→M15, order flow, best setup
- **Backtest Engine** — single pair + multi 10 pairs dari market yang dipilih
- **Trading Journal** — equity curve, lesson wall, Kelly Criterion
- **Telegram Alert** — notifikasi server-side ke HP saat scan, limit fill, posisi ditutup, dan guard aktif
- **Persistence** — state Paper Bot tersimpan atomik di VPS dengan backup `.bak`; jurnal browser punya export JSON/CSV
- **Health & evidence** — status sumber `LIVE`/`DELAYED`/`ERROR`, timestamp, alasan sinyal, volume ratio, dan MTF
- **Paper analytics** — profit factor, expectancy, drawdown, fill rate, pending expired, waktu fill, MFE/MAE, serta breakdown symbol/arah/timeframe/score

## Data Sources

| Data | Sumber | Status |
|---|---|---|
| Harga + Funding + OI | Bitget API v2 Futures | Real-time |
| Harga Spot | Bitget API v2 Spot atau CoinGecko Spot | Real-time/cached |
| Funding backup | BingX + Gate.io | Real-time |
| Fear & Greed | Alternative.me | Harian |
| MTF klines + indikator | Bitget futures candles 120 bar, EMA/RSI/MACD/Supertrend/ATR | Real-time |
| OHLC chart + RSI/MACD | Bitget futures candles | Cached 1 menit |
| OHLC Spot | Bitget Spot candles atau CoinGecko Spot OHLC | Sesuai market yang dipilih |

## Cara Pakai Lokal

```bash
# Cukup buka file di browser
open Nexora_V4_Clean.html
# atau pakai Live Server di VS Code
```

## Deploy ke VPS lewat VS Code Remote-SSH

1. Buka folder remote `/var/www/html/nexora` melalui Remote-SSH.
2. Dari terminal terintegrasi VS Code, unduh `server.js` dan `Nexora_V4_Clean.html` dari branch `main`.
3. Pasang frontend ke `/var/www/html/nexora/index.html` dan restart `nexora-proxy`.
4. Pastikan dashboard dibuka melalui `http://43.156.52.203:18084/`, lalu tekan `Ctrl+Shift+R`.

Atau jalankan `deploy-vps.sh` dari terminal Ubuntu Remote-SSH untuk mengunduh,
memasang, me-restart, dan memverifikasi seluruh komponen sekaligus.

File utama frontend hanya satu: `Nexora_V4_Clean.html`.

## Proxy API VPS

`server.js` adalah proxy HTTP untuk port `18085`. Salin file tersebut ke folder
proxy di VPS (contoh `/home/ubuntu/nexora-proxy/server.js`), lalu restart proses
Node yang menjalankannya. Endpoint `/healthz` harus menampilkan `ok: true`.
Proxy mencakup Bitget, BingX, Gate.io, Alternative.me, CoinGecko, dan CoinPaprika.
Proxy memakai modul bawaan Node.js dengan `node-fetch` sebagai fallback TLS.
Jalankan `npm install` satu kali di folder proxy, lalu gunakan `node server.js`
atau `npm start`.

Saat dashboard dibuka dari port `18084`, seluruh market/API yang dipakai dashboard
melewati proxy VPS agar browser tidak terkena CORS. CoinGecko ditampilkan sebagai
market Spot yang eksplisit; dashboard tidak menyamarkannya sebagai Futures.

Paper Bot VPS hanya memakai Bitget Futures dan menyimpan state di
`paper-bot-state.json`. Restart normal tidak menghapus trade aktif maupun riwayat.
Sebelum order dibuat, kandidat wajib memiliki candle MTF 4H/1H/30M/15M lengkap,
minimal 3 dari 4 timeframe searah, dan confluence default minimal 60%. Arah order
ditentukan oleh MTF, bukan hanya perubahan 24 jam. Server menyimpan indikator,
support/resistance, ATR, kualitas data (`FULL`, `PARTIAL`, `STALE`, atau `REJECTED`),
dan alasan sinyal pada trade. Candle yang melewati batas freshness per timeframe
ditolak dari auto-order agar data basi tidak ikut dieksekusi.
Order baru memakai risiko default 0,5% equity per trade dan total risiko aktif
dibatasi 15%; posisi `LEGACY` tidak dihapus atau diubah sizing-nya, serta tidak
mengambil slot/risk budget bot baru. Duplikasi coin tetap diblokir agar tidak
menambah exposure yang tidak disengaja. Setup dengan entry/SL/TP invalid tidak
akan dibuat menjadi paper order.

Parameter MTF dapat disesuaikan melalui environment service bila diperlukan:

```bash
PAPER_CANDLE_LIMIT=120
PAPER_MTF_MIN_ALIGNMENT=3
PAPER_MIN_CONFLUENCE=60
PAPER_MTF_MAX_CANDIDATES=24
PAPER_MTF_CONCURRENCY=6
```

Status `/paper/status` juga menampilkan parameter tersebut, `mtfStatus`,
`mtfAlignment`, `confluencePct`, `dataQuality`, dan detail indikator per kandidat.
Endpoint `/paper/stats` menyajikan statistik paper lengkap dari state VPS; endpoint
ini tidak mengubah state dan aman dipakai dashboard untuk monitoring.

Konfigurasi alert dilakukan hanya pada service VPS, bukan di browser:

```bash
sudo systemctl edit nexora-proxy
# tambahkan TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID pada [Service]
sudo systemctl daemon-reload && sudo systemctl restart nexora-proxy
```

Status server dapat dicek melalui `/paper/status` dan `/paper/alerts/status`.

Untuk menerima peringatan ketika proses atau VPS Paper Bot berhenti, pasang juga
`nexora-watchdog.service`. Buat `/etc/nexora/nexora.env` di VPS dengan permission
`640` dan isi `TELEGRAM_BOT_TOKEN=...` serta `TELEGRAM_CHAT_ID=...`, lalu salin
kedua file service/script ke `/etc/systemd/system` dan aktifkan watchdog. Dashboard
tidak lagi menghidupkan bot browser sebagai fallback ketika proxy VPS mati, supaya
riwayat paper trading tetap satu sumber.
Jika ingin ringkasan Telegram untuk setiap scan 15 menit, tambahkan
`TELEGRAM_SCAN_SUMMARY=true` ke file environment VPS; default-nya `false`.
History dan statistik mendukung filter `symbol`, `timeframe`, `outcome`, `from`, dan `to`.

Untuk rotasi journal, pasang `nexora-journald.conf` ke
`/etc/systemd/journald.conf.d/nexora.conf`, reload `systemd-journald`, lalu jalankan
`journalctl --vacuum-size=300M` satu kali.

## Struktur File

```
Nexora_V4_Clean.html    # Dashboard utama (single file, semua built-in)
server.js               # Proxy API HTTP untuk VPS port 18085
nexora-watchdog.sh      # Watchdog status VPS/Telegram
nexora-watchdog.service
nexora-journald.conf    # Batas journal dan retention
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
