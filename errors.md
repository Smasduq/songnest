# errors.md — running error log

Every error encountered goes here. Delete an entry when it is fixed.
Format: `- [ ] <where> — <what> (<date>)`, checked when fixed.

## Open

- [ ] 2026-10-04 media fetch throttling — googlevideo URLs serve the first ~1MB range (206) then 403 every subsequent range (same/new connection, paced, fresh resolve). Plain/open-range GETs 403 too. yt-dlp's full-file-capable clients serve sequential 1MB chunks 206/206. Workaround in direct download: 1MB chunks, pacing, re-resolve+backoff resume, global 403→cooldown. Full downloads from datacenter IPs currently fail; residential/phone IPs untested. Auth now via cookies.txt (device flow retired 2026-10-07).
