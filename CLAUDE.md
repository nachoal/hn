# CLAUDE.md — hn CLI

Agent-first TypeScript CLI for Hacker News research. All commands output JSON to stdout. Errors go to stderr. No interactive prompts. No auth of any kind.

This doc captures the architecture, the **API research** behind the design, and the **roadmap**. The full pre-build proposal (with every claim verified live) is in `research/2026-08-24-hn-cli-proposal.md`.

## Purpose

Make Hacker News a first-class research surface for agents — the same role `rit` plays for Reddit, `civit` for Civitai and `bird` for X. Unlike those, HN needs no cookies or reverse-engineering: two public keyless APIs cover everything except account features.

## Architecture

```
src/
├── index.ts              # Entry point (shebang via tsup banner); any error → JSON on stderr, exit 1
├── cli.ts                # Root yargs tree; global --pretty; usage failures → JSON on stderr
├── context.ts            # createContext() → { http, firebase, algolia, settings }; buildMeta()
├── http.ts               # fetch wrapper: timeout, retry on 5xx/429/network, request counter, pMap()
├── clients/
│   ├── firebase.ts       # Official API: ranked id lists, item, user, updates, maxitem
│   └── algolia.ts        # HN Search API: search / search_by_date, items/:id tree, users, batch hydrate
├── hydrate.ts            # ids → items: one Algolia request per 40 ids, Firebase for the misses (--live = all Firebase)
├── paginate.ts           # searchAll(): pages + recursive date-window slicing past the 1,000-hit cap
├── normalize.ts          # Firebase item | Algolia hit | Algolia tree → HnItem / HnComment; parsers; tree helpers
├── text.ts               # HN HTML → plain text / light markdown
├── query.ts              # --type → tags, --since/--after/--before → numericFilters, clamp()
├── config.ts             # ~/.hn/config.json (HN_CONFIG_DIR override), feeds dir, effective settings
├── skill-install.ts      # Locates the bundled skill; symlink / adapted copy into Claude Code, Codex, pi
├── output.ts, errors.ts, types.ts
└── commands/             # One file per command group, each exports registerXCommands(yargs)
    ├── feeds.ts          # top new best ask show jobs
    ├── search.ts         # search, domain (+ hitToEntry shared by digest/feed)
    ├── thread.ts         # thread get, thread search
    ├── item.ts           # item get
    ├── user.ts           # user get|posts|comments
    ├── hiring.ts         # whoishiring threads
    ├── launches.ts       # "Launch HN" posts
    ├── digest.ts         # multi-keyword scan
    ├── feed.ts           # persistent feeds (seen_ids dedupe)
    ├── status.ts, config.ts, skill.ts
skills/hn-hackernews-research/   # The agent skill shipped with the package (SKILL.md, references/, agents/openai.yaml)
tests/                    # vitest, global fetch mocked — never hits the network
```

## Key patterns

- **Command pattern**: `hn <command> [verb]`; every command file exports `registerXCommands(yargs)` and every subcommand has 2–3 `.example()`s. Same skeleton as `rit`/`civit`.
- **Which API for what**: Firebase for ranking, live numbers, users, jobs; Algolia for search, filters, date ranges, comment trees, and batch hydration. `_meta.source` reports `firebase | algolia | mixed`.
- **Batch hydration**: `tags=(story,job,poll),(story_a,story_b,…)` returns a whole page of stories in one request. The first OR-group is required — comments also carry `story_<id>` tags. Jobs are not indexed by Algolia and brand-new items lag, so misses fall back to Firebase.
- **Normalized shapes**: `HnItem` and `HnComment` in `types.ts` are identical whichever API served them; HTML is converted in `text.ts`.
- **`_meta`**: `{ source, requests, endpoints, fetched_at, note? }`. Algolia exposes no rate-limit headers, so the request count is the pacing signal. `note` flags truncation, the 1,000-hit cap, and index lag.
- **Errors**: `HnApiError` (status, endpoint label, details, hint), `NotFoundError`, `UsageError`, `ConfigError` — all `toJSON()` to stderr, exit 1. Sibling-consistent: no semantic exit codes.
- **Truncation**: `thread get` keeps the first `--max-comments` in level order (top-level first), so the returned tree is always structurally valid and biased to the highest-signal comments.
- **Pacing**: 250 ms between requests inside loops (`digest`, `feed run`, `--all`); `HN_PACE_MS=0` in tests.
- **Idempotence**: `feed run` dedupes via `seen_ids` in `~/.hn/feeds/<name>.json` (capped at 5,000); `--dry-run` previews. `feed delete` needs `--yes`.
- **Skill install**: Claude Code gets a symlink to the bundled skill (slash-only via `disable-model-invocation: true`, the house convention; `--auto` writes a copy without the flag). Codex and pi get copies with the flag stripped so they auto-trigger; the Codex copy includes `agents/openai.yaml`.

## Development

```bash
npm run dev -- <args>    # tsx src/index.ts
npm run build            # tsup → dist/index.js
npm test                 # vitest run (mocked fetch)
npm run lint             # tsc --noEmit
```

**`dist/index.js` is committed.** `npm install -g github:nachoal/hn` installs without devDependencies, so there is no toolchain to build at install time; `scripts/prepare.mjs` rebuilds when tsup is present (clone) and otherwise uses the committed bundle. Run `npm run build` and commit `dist/index.js` together with any source change.

Config: `~/.hn/config.json` (`paceMs`, `timeoutMs`, `userAgent`); env overrides `HN_CONFIG_DIR`, `HN_PACE_MS`, `HN_TIMEOUT_MS`.

---

# Research — Hacker News API landscape (verified 2026-08-24)

## Firebase v0 — official, read-only, keyless — `https://hacker-news.firebaseio.com/v0/`

| Endpoint | Returns | Limits |
|---|---|---|
| `/topstories.json`, `/newstories.json`, `/beststories.json` | ranked ids (**top includes jobs**) | up to 500 |
| `/askstories.json`, `/showstories.json`, `/jobstories.json` | ranked ids | up to 200 |
| `/item/<id>.json` | `{id, type, by, time, text, url, score, title, kids[], parent, poll, parts[], descendants, deleted, dead}` | one per request; `null` for unknown ids |
| `/user/<id>.json` | `{id, created, karma, about, submitted[]}` | `null` for unknown users |
| `/maxitem.json`, `/updates.json` | largest id; `{items[], profiles[]}` changed recently | polling basis for a future `watch` |

"There is currently no rate limit." No search, no writes. `kids` is HN's ranked display order.

## Algolia HN Search — keyless — `https://hn.algolia.com/api/v1/`

- `GET /search` (relevance, weighted by points) and `GET /search_by_date` (newest first).
- `GET /items/:id` — full nested tree in one call (children are id-sorted, not ranked). Works for comment ids (subtree). 404 for unknown ids.
- `GET /users/:username` — `{username, karma, about}`; returns HTTP **500** for unknown users (so `user get` uses Firebase).
- `query`; `restrictSearchableAttributes=title|url|story_text|comment_text|author` (`url` + `query=domain` = domain search).
- `tags`: comma = AND, parentheses = OR, two groups can be AND-ed: `(story,job,poll),(story_1,story_2)`. Valid: `story comment poll pollopt show_hn ask_hn front_page author_<u> story_<id>`. `front_page` = the *current* front page (~30 items), not history.
- `numericFilters`: `created_at_i`, `points`, `num_comments` with `< <= = > >=`; comma = AND.
- `hitsPerPage` ≤ 1000; **hard cap 1,000 hits per query** (`nbPages` reflects it) — hence date-window slicing in `paginate.ts`.
- Documented budget ~10,000 req/h; no rate-limit headers.
- Story hit: `objectID, title, url, author, points, num_comments, created_at, created_at_i, story_text?, _tags`. Comment hit: `comment_text, story_id, parent_id, story_title, story_url`; comment `points` are always null.
- Freshness lag vs Firebase is small (verified ~1 point on a live story).
- Special characters (`>`, `(`) must be percent-encoded — `enc()` in `clients/algolia.ts`.

## news.ycombinator.com HTML — only path to account/write features (v2)

No JSON. Login `POST /login` (`acct`, `pw`) → `user` cookie. Upvote `GET /vote?id=<id>&how=up&auth=<per-item token>` (token scraped from the item page each time; no success signal). `fave?id&auth`. `/upvoted?id=<me>` and `/hidden` are login-gated; `/favorites?id=<user>` is public. Comments/submit are POST forms with `hmac`/`fnid`. HN rate-limits scrapers aggressively. All deferred to an opt-in v2.

## Adjacent: YC company directory

[yc-oss/api](https://github.com/yc-oss/api) republishes the YC directory daily as static JSON (`companies/all.json`, ~6,200 companies with batch, status, industry, tags, team_size, one_liner). Candidate `hn yc companies` for v1.1.

---

# Roadmap

## v1.0 — SHIPPED (2026-08-24)

feeds, search/domain, thread get/search, item, user get/posts/comments, hiring, launches, digest, feed, status, config, skill install; agent skill for Claude Code / Codex / pi; vitest suite.

Acceptance (all verified live): `hn status` green; `hn top --limit 30` ≤ 2 requests; `hn search -q "claude code" --since 30d --min-points 100` populated; `hn thread get 8863` returns the 32 top-level comments in HN order; `hn hiring --keywords remote` matches; `hn feed run` second run → 0 new; `_meta.requests` correct everywhere.

## v1.1

- `hn user favorites <name>` — public `/favorites?id=` page (HTML scrape, no login).
- `hn watch [--keywords] [--min-points]` — poll `updates.json`, emit NDJSON.
- `hn yc companies --batch S26 --industry …` via yc-oss/api (decided as a v1.1 flag, not v1).
- Safari/Firefox nothing — there are no cookies to extract.

## v2 — opt-in cookie mode

`hn auth cookies import --stdin` (`user=` cookie), `hn me upvoted|hidden|threads`, `hn upvote`, `hn fave`, `hn comment`, `hn submit`. HTML-form scraping with per-item `auth` tokens, `--yes` gates, hard pacing, ToS warning on first use. Only if a real need shows up.

---

# Testing

`tests/` mocks `global.fetch` (see `tests/helpers.ts`: URL-routed stub + `runCli()` that captures stdout). Covers HTML→text, normalization and tree helpers, Algolia URL shaping and batch hydration, the 1,000-hit window slicer, Firebase concurrency, and end-to-end command behavior (feeds, search, domain, thread ordering/truncation, users, hiring, launches, digest, feed idempotence, status). `HN_CONFIG_DIR` points feeds at a temp dir; `HN_PACE_MS=0` removes sleeps.

# References

- [HackerNews/API](https://github.com/HackerNews/API) · [HN Search API](https://hn.algolia.com/api) · [1,000-hit cap (hn-search #230)](https://github.com/algolia/hn-search/issues/230)
- [voska/hn-cli](https://github.com/voska/hn-cli) — closest prior art (Go, Algolia-only) · [devrelopers/hackernews-mcp](https://github.com/devrelopers/hackernews-mcp) · [simonw/llm-hacker-news](https://github.com/simonw/llm-hacker-news)
- [Swizec — reverse-engineering HN writes](https://swizec.com/blog/how-i-reverseengineered-hacker-news) · [yc-oss/api](https://github.com/yc-oss/api)
- Siblings: [`rit`](https://github.com/nachoal/rit) · [`civit`](https://github.com/nachoal/civit) · [`bird`](https://github.com/steipete/bird)
