# Local recovery — 2026-09-09

The original checkout in Documents was marked `compressed,dataless` by macOS. Its source files reported nonzero logical sizes but sometimes returned zero bytes when read. Foundation confirmed they were iCloud items with status `NotDownloaded`. Download requests restored some files; the cause of the stalled downloads was not established.

A working copy was assembled at `~/Developer/automate-cinema-recovered`, outside iCloud. Recovery used current files that could be read, preserved backend/dashboard copies, Git object snapshots for unchanged scaffold files, and the original task edits for setup documentation. The original checkout was not overwritten. Recovery provenance and independent backups remain locally under `~/Developer/cinema-recovery-20260909` and are not committed.

The SQLite database was backed up through SQLite's backup API and passed its integrity check. The working copy preserves four projects, eleven asset records and eleven media files. Local data and credentials are excluded from Git.

Validation in the recovered working copy: dependency installation completed with zero audit findings; full TypeScript checks, lint, all 25 tests, and the production build passed. OpenAI tests use mocked HTTP responses; no live paid API request was made.

For daily use, run `nvm use` and `npm run dev:studio` in the working copy. A fresh clone needs `npm ci` once. Stop the studio before deliberately reinstalling dependencies. Keep a separate backup of `data/`; Git protects source code, not the excluded project database or generated media.
