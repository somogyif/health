# Health Centre

A personal health intelligence dashboard. A scheduled sync engine pulls from seven
external services — a wearable, a strength-training log, a smart scale, two calendars,
a task manager and a weather API — normalises them into a single document, computes
derived metrics (recovery signals, training load, progressive overload, a daily plan),
and publishes to an authenticated endpoint that a static frontend reads. Nothing on the
dashboard is hardcoded: every value is fetched live or computed from fetched data.

**[▶ Live demo](https://somogyif.github.io/health/?demo=1)** — runs on anonymised sample
data, no login required. The real dashboard reads private data from an authenticated
endpoint and is not publicly accessible.

> **On how this was built.** I directed Claude Code; I don't write code by hand. What I
> own here is the product: what it should do, how it should be structured, which
> trade-offs to take, and — most of the work — verifying that what came back actually
> holds up against live APIs and adversarial input. Several sections below exist because
> the first working version was wrong in ways that only showed up under real data. Where
> that happened, I've written down what broke and why the fix is structural rather than
> local.

---

## What's in this repository

This repo holds the **static frontend only** — a single-file dashboard, a printable
brief, the demo dataset and PWA assets. The sync engine and the Cloudflare Worker live
outside it, because the sync runs on a personal machine and the data must not be public.

```
index.html            the whole dashboard: HTML + CSS + vanilla JS in one file, no build
brief.html            self-contained printable one-page brief
demo-data.json        anonymised sample data powering ?demo=1
manifest.webmanifest  PWA — installs to an iPhone home screen
robots.txt            crawlers excluded
```

## Architecture

```
seven sources → sync engine (Python, scheduled) → guards → authenticated endpoint
                                                    ↓              ↓
                                          local daily backup   static frontend
```

**Integrations (7).** A wearable platform (recovery, sleep, HRV, training load, body
battery), a strength-training API, a smart scale exporting through a cloud drive, an
iCal calendar feed, a second calendar via Notion, a local task manager, and a weather
API. Four different authentication models: username/password with token reuse, an API
key, a service-account JWT, and a secret feed URL.

**Sync engine.** ~1,500 lines of Python, standard library plus three dependencies, run
on a schedule by `launchd`. A fetch layer (one adapter per source, each independently
failable), a builder layer that computes the derived metrics, and a set of guards that
decide whether the result is safe to publish.

**Data endpoint.** A Cloudflare Worker backed by KV. Separate read and write keys,
constant-time comparison, rate limiting on failed authentication, structured logging of
auth failures, and a health check that reveals nothing without a key. The sync writes;
the frontend reads. Roughly two dozen writes a day against a free-tier ceiling of a
thousand.

**Frontend.** One hand-written HTML file, vanilla JS, Chart.js from a CDN, no bundler
and no build step. Three tabs, a printable brief, and an installable PWA. Deliberately
no service worker: the whole point is live data, and a cache layer would serve stale
numbers. Data source resolution is demo → authenticated endpoint → fallback.

---

## The hard problems

The interesting work wasn't wiring up APIs. It was the places where the obvious
implementation is quietly wrong.

**Overnight metrics don't exist under today's date yet.** Sleep, HRV, body battery and
readiness are only filed under a given day *after* the watch syncs. Query "today" at
07:00 and you get an empty response — not an error, just nothing. The first version
rendered that as `0.0h` of sleep and a crashed HRV parse. Every overnight metric now
tries today, then falls back to the most recent night, and carries a type guard because
one endpoint returns an empty string rather than an object when it has no data.

**Readiness needs timestamp selection, not array position.** The platform records
several readiness readings per day as conditions change. Taking element zero of
yesterday's array — which looks perfectly reasonable — gives you a stale end-of-day
score. The dashboard showed a number less than half the current one for days before I
checked it against the live API. The fix is to query today and select the reading with
the newest timestamp, falling back a day only when today is genuinely empty.

**Progressive overload has to match on identity, not name.** To detect that you lifted
more than last time, you have to recognise the same exercise across two sessions. Names
look like the obvious key, and they're a trap: "Bent Over Row (Barbell)" and "Bent Over
Row (Dumbbell)" are different lifts at different weights, and naive normalisation
collapses them into a fictitious "improvement". Matching on the platform's stable
template ID fixes it. The same code had the comparison direction inverted, so badges
landed on the older session and the newest card was always empty — visible only if you
knew what the numbers should say.

**Partial failures are more dangerous than total ones.** A source that returns nothing
is easy to handle. A source that returns *some* fields is what quietly corrupts your
history. The guards, in order: a total fetch failure publishes nothing and leaves the
last good document in place; a partial failure backfills the missing fields from daily
snapshots, searching backwards rather than one step, because a run of degraded syncs
had already washed out the last good values; and every source carries its own freshness
timestamp, so a carried-forward value displays with the time it was actually measured
instead of masquerading as current. Sleep and HRV are deliberately excluded from
carry-forward — they're night-bound, and showing last night's figure as today's would
be a lie the freshness stamp doesn't excuse.

**A secret in a fallback path.** The calendar integration looked up a display name per
event and fell back to the feed URL when it found nothing. The name lives on the
calendar object, not on individual events, so the lookup always failed — and the feed
URL is a secret bearer token. It was published in the data file for weeks. Fixed, and
the URL rotated.

---

## Security

Three things went wrong. All are fixed; the third is the one worth reading.

**Stored XSS leading to credential theft.** Calendar event titles were interpolated into
template literals and assigned via `innerHTML` without escaping, while an API token sat
in `localStorage`. Calendar titles are attacker-influenceable: anyone who knows your
address can send an invite. I proved it with a working payload — an injected script
executed on page load and read the token — then fixed it by deep-escaping the entire
payload as the first statement of the render function rather than patching individual
call sites, because one missed site silently reinstates the whole class of bug. A
regression test executes the payload in Node and asserts it comes back inert, and the
pre-deploy check fails if the escaping is ever removed from the render entry point.

**A publicly readable data file.** The synced document sat on public static hosting at a
guessable path. Making the repository private wouldn't have fixed it — the published
site stays public either way. The data moved behind the authenticated Worker endpoint,
which had the side effect of eliminating the hourly rebuild the old push triggered.

**Rewriting git history wasn't enough.** Roughly 440 commits contained daily snapshots
of the data, including calendar titles with other people's names. An orphan branch and
a force push removed them from the browsable history — and I verified afterwards that
the old commits were **still reachable by SHA**, serving the full data file. Unreachable
is not deleted; the platform keeps orphaned objects until garbage collection. The repo
had to be deleted and recreated from a clean tree before the old content actually
returned 404. The full history is preserved in a private archive and offline.

**Standing posture.** Secrets in environment variables only, never in source. A
pre-commit hook scans staged content for credential patterns and blocks the commit.
Separate read and write keys on the endpoint, so a browser never holds a key that can
write. Rate limiting and logging on failed authentication. The frontend's token prompt
is a convenience, not a security boundary — enforcement is server-side, and the code
says so.

---

## Testing and operations

**31 regression tests**, standard-library `unittest`, no new dependencies. Every test
pins a bug that actually occurred: readiness freshness, overload pairing direction,
template-ID matching, streak logic across partial weeks, the day-plan classifier, the
publish-churn guard, the carry-forward source, XSS neutralisation, and demo-data
cleanliness. The suite caught a live bug within minutes of being written — a
week-over-week comparison that reported a 100% drop every Monday morning.

**Pre-deploy check** (`preflight.sh`) — a runnable script rather than a checklist:
secret scanning across published files, the XSS invariant, demo-data cleanliness, the
test suite, syntax and JSON validity, live endpoint reachability, and known-exposure
checks. Non-zero exit blocks the deploy.

**Daily backups.** The KV store is a source of truth, not a backup, and has no export.
Every successful sync writes a timestamped snapshot to a local, backed-up folder. The
snapshots also feed the carry-forward guard.

**Heartbeat monitoring.** The sync pings a dead-man's-switch only after a fully
successful run. A laptop-hosted schedule has three silent failure modes — lid closed,
machine off, script erroring after launch — and alert-on-absence catches all three,
where monitoring the output catches none of them.

---

## Known limitations

Honest list. These are known and deliberate, not oversights waiting to be discovered.

- **Notion mirroring is not implemented.** The function logs that it's skipped. It used
  to log a success tick while doing nothing, which is worse than not having it.
- **One value is hardcoded** — a fitness-age figure whose endpoint requires a browser
  session that the API client can't produce. It's marked as such in the source.
- **Single user, no auth system.** There are no accounts and no multi-tenant model.
  Adding a second user would change the threat model entirely.
- **No full WCAG audit.** Semantic landmarks, visible focus states, `aria-label`s and
  screen-reader data tables behind the canvas charts are in place; a complete AA pass
  with assistive technology has not been done.
- **Laptop-hosted schedule.** If the machine is off at the scheduled time, that run is
  missed. The heartbeat surfaces it rather than preventing it.
- **A couple of half-finished features** remain in the codebase and stay hidden when
  their data is absent. They're noted rather than quietly shipped.

---

## Roadmap

Natural-language daily coaching via an LLM; anomaly detection over trend data;
identity-based access in front of the data endpoint (needs a custom domain); error
tracking. Nothing here is a commitment — the system is complete and running as it is.
