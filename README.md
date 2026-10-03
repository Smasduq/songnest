# songnest

Serve with `cargo run -p songnest-cli -- serve` (http://127.0.0.1:8787).

## YouTube throttling (502 / "no candidates")

Undownloaded streaming shells out to `yt-dlp`. YouTube 429/bot-checks
datacenter IPs, and throttled searches return zero entries. If that hits:

1. Log into YouTube in your browser.
2. Export `cookies.txt` (e.g. Get cookies.txt LOCALLY extension).
3. Drop it next to `library.db` (or set `SONGNEST_COOKIES=/path/to/cookies.txt`).
4. No restart needed — it is picked up on the next request.

`cookies.txt` is gitignored. Never commit it.
