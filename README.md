# Nexora Command Center V4

Dashboard trading crypto berbasis HTML — paper trading otomatis, analisis Phase 2 MTF, backtest engine, dan journal lengkap.

## Fitur Utama

- **Scanner V4.4** — 40+ pairs, funding real dari Bitget+BingX+Gate.io saat Futures
- **Market selector** — Bitget Futures, Bitget Spot, dan CoinGecko Spot
- **Paper Bot** — auto-scan 15 menit, MTF 4H/1H/30M/15M, indikator server-side, confluence gate, limit order otomatis, monitor candle 1M, partial TP1/TP2, dan batas risiko agregat
- **Phase 2 Analysis** — MTF D1→H4→H1→M15, order flow, best setup
- **Backtest Engine** — single pair + multi 10 pairs dari market yang dipilih
- **Trading Journal** — equity curve, lesson wall, Kelly Criterion
- **Telegram Alert** — notifikasi server-side ke HP saat scan, limit fill, posisi ditutup, dan guard aktif
- **News impact analysis** — badge sentimen, statistik/filter coin, dan analisis dampak per artikel dengan cache 6 jam; memakai OpenAI/Claude bila dikonfigurasi, atau fallback rule-based yang jujur
- **Persistence** — state Paper Bot tersimpan atomik di VPS dengan backup `.bak`; jurnal browser punya export JSON/CSV
- **Health & evidence** — status sumber `LIVE`/`DELAYED`/`ERROR`, timestamp, alasan sinyal, volume ratio, dan MTF
- **Paper analytics** — profit factor, expectancy, drawdown, fill rate, pending expired, waktu fill, MFE/MAE, TP1/TP2, stop loss, cohort, strategy version, candle pattern, serta breakdown symbol/arah/timeframe/score

## Data Sources

| Data | Sumber | Status |
|---|---|---|
| Harga + Funding + OI | Bitget API v2 Futures | Real-time |
| Harga Spot | Bitget API v2 Spot atau CoinGecko Spot | Real-time/cached |
| Funding backup | BingX + Gate.io | Real-time |
| Fear & Greed | Alternative.me | Harian |
| MTF klines + indikator | Bitget futures candles 120 bar, EMA/RSI/MACD/Stoch RSI/Supertrend/ATR, candle pattern | Real-time |
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
Feed News tersedia melalui `/cryptocompare/news/v1/article/list` dan menggunakan
CryptoCompare jika tersedia, lalu fallback ke RSS publik CoinDesk. Analisis dampak
per artikel tersedia di `/api/news/<news_id>/analyze`; hasilnya di-cache 6 jam.
Tanpa credential AI, dashboard tetap bekerja dengan rule-based fallback dan selalu
menampilkan provider yang digunakan. Jika ingin mengaktifkan AI, simpan salah satu
credential berikut di environment service VPS (jangan hardcode atau taruh di HTML):

```bash
OPENAI_API_KEY=...
# atau
ANTHROPIC_API_KEY=...
```

Status drawdown juga tersedia pada `/paper/status` sebagai `drawdown` dan pada
`/api/status`; banner merah/kuning di dashboard hanya memberi peringatan dan tidak
mengubah guard server.

Paper Bot VPS hanya memakai Bitget Futures dan menyimpan state di
`paper-bot-state.json`. Restart normal tidak menghapus trade aktif maupun riwayat.
Setiap order baru diberi `strategyVersion` dan `cohortId`, sehingga hasil trial
baru dapat dibandingkan terpisah dari posisi lama. Trade lama diberi label
`PRE_UPGRADE` atau `LEGACY`, tetap terlihat, tetapi tidak memakai slot maupun
risk budget cohort baru.
Sebelum order dibuat, kandidat wajib memiliki candle MTF 4H/1H/30M/15M lengkap,
minimal 3 dari 4 timeframe searah, dan confluence default minimal 60%. Arah order
ditentukan oleh MTF, bukan hanya perubahan 24 jam. Server menyimpan indikator,
support/resistance, ATR, kualitas data (`FULL`, `PARTIAL`, `STALE`, atau `REJECTED`),
dan alasan sinyal pada trade. Candle yang melewati batas freshness per timeframe
ditolak dari auto-order agar data basi tidak ikut dieksekusi.
Order baru memakai risiko default 0,5% equity per trade dan total risiko aktif
dibatasi 40%, risiko satu arah dibatasi 20%, dan daily loss guard default 3R.
Trial strategy dapat menampung maksimal 80 record aktif agar sampel satu minggu
tidak cepat habis karena order pending; ini tetap paper-only dan bukan rekomendasi
untuk live trading.
posisi `LEGACY` tidak dihapus atau diubah sizing-nya, serta tidak mengambil
slot/risk budget bot baru. Duplikasi coin tetap diblokir agar tidak menambah
exposure yang tidak disengaja. Setup dengan entry/SL/TP invalid tidak akan dibuat
menjadi paper order. Entry, SL, dan TP memakai ATR serta swing/pivot structure
dan dibulatkan mengikuti tick size kontrak Bitget bila metadata tersedia.

Setelah order limit dibuat, statusnya `PENDING`. Fill hanya terjadi bila range
candle 1M tertutup menyentuh limit (`1M_HIGH_LOW`), bukan hanya karena ticker
terakhir melewati level. Saat TP1 tersentuh, default 50% posisi direalisasikan,
SL sisa dipindahkan ke breakeven, dan status berubah `TP1_PARTIAL`; TP2 menutup
sisa posisi dan menyimpan `closeStage=CLOSED_TP2`. Jika high/low candle menyentuh SL dan TP sekaligus, server memakai
aturan konservatif SL lebih dulu. Pending yang tidak fill setelah 120 menit
dibatalkan otomatis. Semua event dan timestamp candle disimpan.

Parameter MTF dapat disesuaikan melalui environment service bila diperlukan:

```bash
PAPER_CANDLE_LIMIT=120
PAPER_MIN_CANDLES=100
PAPER_MTF_MIN_ALIGNMENT=3
PAPER_MIN_CONFLUENCE=60
PAPER_MIN_SIGNAL_SCORE=70
PAPER_SIGNAL_MODE=WEIGHTED
PAPER_MTF_MAX_CANDIDATES=40
PAPER_MTF_CONCURRENCY=6
PAPER_STRATEGY_VERSION=MTF_ATR_V2
PAPER_COHORT_ID=trial-YYYY-MM-DD
PAPER_TP1_CLOSE_PCT=50
PAPER_MAX_DAILY_LOSS_R=3
PAPER_MAX_DIRECTION_RISK_PCT=10
PAPER_MAX_PER_DIRECTION=5
PAPER_MAX_HIGH_CORR_POSITIONS=10
```

Status `/paper/status` juga menampilkan parameter tersebut, `mtfStatus`,
`mtfAlignment`, `confluencePct`, `dataQuality`, dan detail indikator per kandidat.
`PAPER_SIGNAL_MODE=WEIGHTED` memberi bobot trigger 15M dan timeframe besar pada
konfluensi; `CLASSIC` memakai pembobotan alignment yang lebih sederhana. Mode
yang dipakai disimpan pada setiap trade agar hasilnya bisa dibandingkan.
Status `/paper/status` juga memisahkan `trialActiveCount`, `preUpgradeActiveCount`,
`dailyLossR`, `dailyGuard`, `trialStats`, dan metadata cohort. Endpoint
`/paper/stats` menyajikan statistik paper lengkap dari state VPS, termasuk
`byStrategyVersion`, `byCohort`, `byCandlePattern`, TP1/TP2, dan median waktu fill;
plus bucket confluence, funding, volume ratio, median R, hit-rate TP1/TP2/SL,
dan pending-expired rate;
filter `strategyVersion` dan `cohortId` tersedia untuk analisis bersih. Endpoint
`/paper/diagnostics` menampilkan runtime scan/monitor, counter error, alasan
rejection terstruktur, dan kesehatan semua sumber. Endpoint-endpoint ini tidak
mengubah state dan aman dipakai dashboard untuk monitoring.

Konfigurasi alert dilakukan hanya pada service VPS, bukan di browser:

```bash
sudo systemctl edit nexora-proxy
# tambahkan TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID pada [Service]
sudo systemctl daemon-reload && sudo systemctl restart nexora-proxy
```

Status server dapat dicek melalui `/paper/status` dan `/paper/alerts/status`.

Untuk menerima peringatan ketika proses, scan, atau sumber data VPS Paper Bot
bermasalah, pasang juga `nexora-watchdog.service`. Buat
`/etc/nexora/nexora.env` di VPS dengan permission `640` dan isi
`TELEGRAM_BOT_TOKEN=...` serta `TELEGRAM_CHAT_ID=...`, lalu salin
kedua file service/script ke `/etc/systemd/system` dan aktifkan watchdog. Dashboard
tidak lagi menghidupkan bot browser sebagai fallback ketika proxy VPS mati, supaya
riwayat paper trading tetap satu sumber.
Jika ingin ringkasan Telegram untuk setiap scan 15 menit, tambahkan
`TELEGRAM_SCAN_SUMMARY=true` ke file environment VPS; default-nya `false`.
History dan statistik mendukung filter `symbol`, `timeframe`, `outcome`,
`strategyVersion`, `cohortId`, `from`, dan `to`. Untuk evaluasi strategi, tunggu
minimal 50–100 trade cohort baru yang konsisten sebelum mengubah parameter lagi.

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
