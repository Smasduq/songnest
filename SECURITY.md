# Security policy

## Reporting a vulnerability

Do not open a public issue for security problems. Instead, contact the
maintainer privately:

> **Contact: WhatsApp +234 704 154 3965 · Instagram [@s.masduq](https://instagram.com/s.masduq)**

Include: what is affected (backend, frontend, desktop app, Android
build), the version or commit, steps to reproduce, and what you think
the impact is. Please give a reasonable time to fix before disclosing.

## Scope notes

- The local server listens on all interfaces (`0.0.0.0:8787`) by default
  so a phone on the same Wi-Fi can reach it. Only run it on networks you
  trust; it is intended for local, trusted-network use, not the open
  internet.
- Never include cookies, tokens, database files, or personal media in
  bug reports or logs. The app's diagnostics screen never needs those to
  debug a problem.
