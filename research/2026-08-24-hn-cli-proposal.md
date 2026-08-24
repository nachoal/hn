# `hn` — Agent-first Hacker News CLI: proposal

**Status: IMPLEMENTED as v1.0 the same day (see [CLAUDE.md](../CLAUDE.md) for what shipped).** Written 2026-08-24 as the pre-build proposal; kept as the research record. Decisions taken: name `hn`, build rather than adopt, sibling-consistent exit code 1, `hiring`/`launches`/`domain` kept in v1, YC directory deferred to v1.1. Sibling of [`rit`](https://github.com/nachoal/rit) (Reddit), [`civit`](https://github.com/nachoal/civit) (Civitai) and [`bird`](https://github.com/steipete/bird) (X). Every API claim below was verified live with `curl` on 2026-08-24.

## 1. TL;DR

- **Nothing exists in this workspace** (`projects/clis/` has no `hn`/`yc`; no `hn*` binary on PATH; no Firebase/Algolia usage anywhere).
- **Out there**, the closest thing is [voska/hn-cli](https://github.com/voska/hn-cli) (Go, Algolia-only, `--json`, v0.2.1 on 2026-08-08, 5 stars). It covers `search / front / read / user`. It does **not** cover ranked feeds beyond the front page, digests, persistent feeds with dedupe, domain search, Who-is-hiring / Launch-HN helpers, or any account features — and its JSON contract is different from `rit`/`civit`, so the skill recipes and `jq` muscle memory wouldn't transfer.
- **Recommendation: build `hn` in the `rit`/`civit` mold.** It is the *cheapest* of the three by far: two public, documented, keyless APIs (Firebase v0 + Algolia), no cookies, no reverse-engineering, no rate-limit anxiety. v1 is a one-session job (~2–3 h) plus ~1 h for the skill.
- Cookie mode (upvotes, favorites-as-me, commenting, submitting) is the only thing that needs `news.ycombinator.com` HTML scraping. Park it as an opt-in v2; reads cover ~95 % of research value.

## 2. Is there one already?

### In the workspace — no

| Check | Result |
|---|---|
| `projects/clis/*` | 24 CLIs; none HN/YC related |
| Binaries on PATH (`hn`, `hncli`, `haxor-news`, `hnterm`, …) | none; only `bird` (Homebrew), `rit`, `civit` (npm-linked) |
| `npm -g`, `brew`, `uv tool`, `pipx`, `~/.cargo/bin`, `~/go/bin` | nothing HN-related |
| Skills | `bird`, `rit-reddit-research`, `civit-civitai-research` only |

### Out there — survey

| Tool | Kind | Backed by | Agent-friendly? | Verdict |
|---|---|---|---|---|
| [voska/hn-cli](https://github.com/voska/hn-cli) | Go CLI, binary **`hn`**, `brew install voska/tap/hn` | Algolia only | Yes — `--json`, stderr-only progress, exit codes `0/1/3(empty)/5(not found)/8(retryable)` | Closest prior art. `search` (`--comments --sort date --after --min-points -n`), `front`, `read <id> --expand`, `user`, `status`, `version`. No auth, no persistence, no digest/feed, no `new/best/ask/show/jobs`. MIT, 12 commits. Crib its `status` command. |
| [devrelopers/hackernews-mcp](https://github.com/devrelopers/hackernews-mcp) | Rust MCP server | Firebase + Algolia | MCP, not CLI | `get_stories(top/new/best/ask/show/job)`, `get_item(max_depth, max_comments)`, `get_user`, `search`. Politeness cap ~10 in-flight. Good reference for comment-tree truncation defaults. |
| [sam3690/Hackernews_mcp](https://github.com/sam3690/Hackernews_mcp), [akarnik23/mcp-hackernews](https://glama.ai/mcp/servers/akarnik23/mcp-hackernews), Apify MCPs | Node MCPs / paid actors | Algolia | MCP | Same surface, less polish. Skip. |
| [simonw/llm-hacker-news](https://github.com/simonw/llm-hacker-news) | `llm` fragment plugin (`llm -f hn:ID 'summarize'`) + [hn-summary.sh](https://til.simonwillison.net/llms/claude-hacker-news-themes) | Algolia `items/:id` | Yes, but `llm`-shaped | Precedent for "thread → LLM summary". Our `hn thread get` should emit something equally summarizer-ready. |
| [donnemartin/haxor-news](https://github.com/donnemartin/haxor-news) | Python interactive CLI | Firebase | No (interactive) | Classic human browser, effectively unmaintained. |
| hnterm (ggerganov), hackernews-TUI (aome510) | TUIs | Firebase | No | Human browsing only. |
| [hnrss.org](https://hnrss.org/) | RSS / Atom / JSON Feed | **Algolia underneath** (`x-algolia-url` response header proves it) | Semi | `q`, `points`, `comments`, `count≤100`, `search_attrs=url`. Redundant once we hit Algolia directly; cache 600 s. Skip. |
| Apify HN scrapers | Paid | HTML/Algolia | n/a | Skip. |

Nothing is a drop-in for the `rit`/`civit` workflow (consistent `resource verb`, `_meta`, `digest`, `feed run` dedupe, skill with recipes).

## 3. API landscape (verified 2026-08-24)

### 3.1 Firebase v0 — official, read-only, keyless — `https://hacker-news.firebaseio.com/v0/`

| Endpoint | Returns | Limits |
|---|---|---|
| `/topstories.json` | ranked IDs (**includes jobs**) | up to 500 |
| `/newstories.json`, `/beststories.json` | ranked IDs | up to 500 |
| `/askstories.json`, `/showstories.json`, `/jobstories.json` | ranked IDs | up to 200 |
| `/item/<id>.json` | `{id, type(job\|story\|comment\|poll\|pollopt), by, time, text, url, score, title, kids[], parent, poll, parts[], descendants, deleted, dead}` | 1 item per request, no batch |
| `/user/<id>.json` | `{id, created, karma, about, submitted[]}` | — |
| `/maxitem.json` | largest item id (49 424 880 today) | — |
| `/updates.json` | `{items[], profiles[]}` changed recently | polling basis for `watch` |

"There is currently no rate limit." No search, no writes. Real-time scores.

### 3.2 Algolia HN Search — keyless — `https://hn.algolia.com/api/v1/`

| Endpoint | Notes |
|---|---|
| `GET /search?…` | relevance-ranked |
| `GET /search_by_date?…` | newest first |
| `GET /items/:id` | **full nested comment tree in one call** (`children[]` recursive; 8863 → 32 children verified) |
| `GET /users/:username` | `{username, karma, about}` |

Parameters (all verified):

- `query` — full text. `restrictSearchableAttributes=title|url|story_text|comment_text|author` narrows it. `restrictSearchableAttributes=url` + `query=anthropic.com` = **domain search** (795 hits).
- `tags` — comma = AND, parentheses = OR: `tags=story,(story_1,story_2)`. Valid: `story`, `comment`, `poll`, `pollopt`, `show_hn`, `ask_hn`, `front_page`, `author_<user>`, `story_<id>`.
- `numericFilters` — `created_at_i`, `points`, `num_comments` with `< <= = > >=`; comma = AND. Exact date windows work (`created_at_i>A,created_at_i<B`).
- `page`, `hitsPerPage` (≤1000).
- Hit shape (story): `objectID, title, url, author, points, num_comments, created_at, created_at_i, story_text?, _tags, _highlightResult`. Comment: `comment_text, story_id, parent_id, story_title, story_url`. Envelope: `hits, nbHits, nbPages, page, hitsPerPage, exhaustiveNbHits, processingTimeMS`.

Limits and gotchas:

- **Hard cap: 1000 hits per query** (`hitsPerPage=1000` → `nbPages=1`; page 11 at 100/page → 0 hits; [hn-search#230](https://github.com/algolia/hn-search/issues/230)). Deep pulls must slice by `created_at_i` windows.
- Documented **10 000 req/h**; **no rate-limit headers** are exposed (verified) — pace locally.
- **`front_page` tag = the *current* front page only** (~30 items), not history. Don't use it for "what was on the front page last week"; use `--min-points` on a date window instead.
- Freshness lag vs Firebase is tiny (live `506/336` vs Algolia `505/335` on the same story).
- **Batch hydration trick**: `tags=story,(story_a,story_b,…)` with 30 top-story IDs returned **29/30 in one call**; the miss (too-fresh/job item) falls back to Firebase. That makes `hn top` 1–2 requests instead of 31.
- `>` and `(` must be percent-encoded in URLs (a raw `>` gets an HTML 400).
- Research sugar that works today: `tags=story,author_whoishiring` → all 508 "Who is hiring / wants to be hired" threads (Aug 2026: `49156683` / `49156682`); `query="Launch HN"&restrictSearchableAttributes=title` → 1 168 YC launch posts.

### 3.3 news.ycombinator.com HTML — the only path to account/write features

- No JSON at all (`/item.json?id=…` → 404).
- Login: `POST /login` with `acct`, `pw` (+ `creating` for signup) → `user=<name>&<token>` cookie.
- Upvote: `GET /vote?id=<id>&how=up&auth=<per-item token>&goto=…` — the token must be scraped from the item page each time; the server gives **no success signal** ([Swizec's write-up](https://swizec.com/blog/how-i-reverseengineered-hacker-news)). Favorite: `fave?id=<id>&auth=<token>` (the link, with token, is rendered even for anonymous visitors — verified).
- `/upvoted?id=<me>` and `/hidden` are login-gated ("Please log in." verified). `/favorites?id=<user>` is **public** (200, verified) — a legit v1.1 read without auth.
- Comment/submit are POST forms with `hmac`/`fnid` hidden fields.
- HN rate-limits and bans IPs for scraping bursts; keep HTML fetches rare and paced. Treat all of this as opt-in v2.

### 3.4 Adjacent: YC company directory

[yc-oss/api](https://github.com/yc-oss/api) republishes the YC directory daily as static JSON: `https://yc-oss.github.io/api/companies/all.json` → **6 191 companies** with `name, slug, website, one_liner, long_description, batch, status, industry, subindustry, tags, team_size, all_locations, launched_at, top_company, isHiring, nonprofit` (`meta.json` shows `last_updated: 2026-08-24`). Cheap to add as `hn yc companies --batch S26 --industry …` later; out of scope for v1.

## 4. Proposed design

### 4.1 Identity

- **Name**: `hn`. Two letters, obvious, fits `bird`/`rit`/`civit`. Collisions: voska's Homebrew tap installs a binary named `hn` (only matters if both are installed); npm `hn` is a Drupal package (irrelevant while npm-linked, as `rit`/`civit` are; `hnit`, `hnr`, `hn-research` are free if we ever publish).
- **Location**: `projects/clis/hn/` (own git repo → `github.com/nachoal/hn`, like the siblings).
- **Skill**: `skills/hn-hackernews-research/` (+ `references/workflows.md`), `disable-model-invocation: true`, symlinked into `~/.claude/skills/` and committed there as a symlink (mode 120000, exactly like `rit-reddit-research`).
- **Stack**: identical scaffold — TypeScript ESM, yargs 17, tsup (`node22`, shebang banner), vitest, `install_global.sh` → `npm link`, config in `~/.hn/{config.json,feeds/}`.

### 4.2 Architecture

```
src/
├── index.ts            # entry, error handler (copied from rit)
├── cli.ts              # yargs tree; global --pretty only (no auth flags in v1)
├── client-factory.ts   # getClients() → { firebase, algolia }
├── clients/
│   ├── firebase.ts     # ranked ID lists, live item/user, updates, maxitem
│   └── algolia.ts      # search, search_by_date, items/:id, users, batch hydrate
├── normalize.ts        # Firebase item | Algolia hit → HnItem; HTML → text
├── window.ts           # created_at_i window slicing for --all (1000-hit cap)
├── config.ts           # ~/.hn/config.json (pace_ms, default_limit), feedsDir()
├── output.ts           # JSON stdout / errors stderr (copied)
├── errors.ts           # HnApiError, NotFoundError, ConfigError
├── types.ts            # HnItem, HnComment, ListResult, Meta, FeedFile
└── commands/
    ├── feeds.ts        # top new best ask show jobs
    ├── search.ts       # search, domain
    ├── thread.ts       # thread get, thread search
    ├── item.ts         # item get
    ├── user.ts         # user get|posts|comments|favorites
    ├── hiring.ts       # hiring
    ├── launches.ts     # launches
    ├── digest.ts       # multi-keyword scan (buckets per keyword)
    ├── feed.ts         # persistent feeds (copied from rit, minus client differences)
    ├── watch.ts        # v1.1
    ├── status.ts       # API health + latency + maxitem
    └── config.ts
```

### 4.3 Which API for what

| Need | Source | Why |
|---|---|---|
| Ranked lists (top/new/best/ask/show/jobs) | Firebase `*stories.json` | only source of HN's real ranking |
| Hydrating a page of IDs | Algolia OR-tag batch (`tags=story,(story_a,…)`), Firebase fallback for misses | 1–2 calls instead of 30 (verified 29/30) |
| Search, filters, exact date ranges | Algolia | only search; exact windows (rit never had this) |
| Thread tree | Algolia `items/:id` | whole tree in one call vs one Firebase call per comment |
| Live score / comment count | Firebase item | real time; `--live` flag on listings |
| User profile | Firebase user + Algolia users | Firebase has `created` + `submitted[]` |
| A user's posts/comments | Algolia `author_<u>` tag | sortable, paginated, date-filterable |
| Favorites (any user) | HTML `/favorites?id=` (public) | no API exists — v1.1 |
| Upvoted/hidden/vote/comment/submit | HTML + `user` cookie | v2, opt-in |

### 4.4 Command tree (v1)

```
hn <resource> <verb> [flags]        global: --pretty --help --version

# Ranked feeds — Firebase IDs → one Algolia hydrate call (--live re-hydrates via Firebase)
hn top   [--limit 30] [--page 1] [--live] [--no-jobs]
hn new   [--limit 30] [--page 1] [--live]
hn best  [--limit 30] [--page 1] [--live]
hn ask   [--limit 30] [--live]
hn show  [--limit 30] [--live]
hn jobs  [--limit 30] [--live]

# Search — Algolia, the workhorse
hn search -q "<query>" [--comments] [--sort relevance|date]
          [--since 1h|24h|7d|30d|1y] [--after YYYY-MM-DD] [--before YYYY-MM-DD]
          [--min-points N] [--min-comments N]
          [--type story|ask|show|poll|job|comment] [--author <u>] [--in title|url|text]
          [--limit 20] [--page 0] [--all --max-pages N]
hn domain <example.com> [--since 1y] [--min-points N]          # sugar: search --in url

# Threads / items
hn thread get <id|url> [--depth N] [--max-comments 200] [--sort top|new] [--flat]   # Algolia items/:id
hn thread search <id> -q "<query>" [--limit 50]                  # comments inside one story
hn item get <id>                                                 # raw Firebase item, live

# Users
hn user get <username>                                           # karma, about, created, counts
hn user posts <username>    [--since] [--limit] [--sort]
hn user comments <username> [--since] [--limit] [--sort]
hn user favorites <username> [--comments]                        # v1.1 (public HTML page)

# HN-specific research sugar (1–2 calls each)
hn hiring   [--month 2026-08] [--keywords "remote,ai"] [--wants-to-be-hired] [--freelancer] [--limit]
hn launches [--since 30d] [--batch S26] [--min-points N] [--limit]     # "Launch HN:" posts
hn digest --keywords "a,b,c" [--type story|ask|show|comment] [--since 7d] [--min-points N] [--limit-per-keyword 50]
hn feed create <name> --keywords "..." [--type] [--since] [--min-points]
hn feed list | run <name> [--dry-run] | delete <name> --yes
hn watch [--interval 30] [--keywords "..."] [--min-points N]     # v1.1: updates.json poller → NDJSON

# Diagnostics
hn status                                                        # both APIs: reachable, latency, maxitem
hn config show | set --pace-ms 250 --default-limit 30
```

Sibling parity: `--pretty`, `--limit`, `--since` (same `1h|24h|7d|30d|1y` vocabulary as `rit digest`), `--yes` for deletes, `--dry-run` for `feed run`, `--all --max-pages` like `bird`. Every subcommand ships 2–3 `.example()`s and actionable `.check()` errors, per the agentic-cli-guidelines skill.

### 4.5 Output contract

Normalized item (both sources map into the same shape):

```json
{
  "id": 49420873, "type": "story", "title": "…", "url": "https://…", "domain": "example.com",
  "author": "u", "points": 505, "num_comments": 335, "created_at": "2026-08-24T18:01:02Z",
  "text": null, "hn_url": "https://news.ycombinator.com/item?id=49420873", "rank": 2, "dead": false
}
```

`type` is derived: `ask` (Ask HN / `ask_hn` tag), `show`, `job`, `poll`, `story`, `comment`. Comment: `{ id, type: "comment", author, text, created_at, parent_id, story_id, story_title, depth, replies: [] }`. HTML in `text` is converted to plain text/markdown (`<p>`, `<a>`, `<code>`, `<pre>`, entities).

| Command family | Shape |
|---|---|
| Listings (`top…`, `search`, `domain`, `user posts/comments`, `launches`) | `{ items, count, page, nb_hits?, nb_pages?, _meta }` |
| `thread get` | `{ story, comments: [tree], comment_count, truncated, _meta }` |
| `hiring` | `{ thread: {id, title, created_at}, matched_count, items: [comments], _meta }` |
| `digest` | `{ query_time, since, buckets: [{ keyword, matched_count, items }], _meta }` |
| `feed run` | `{ feed, dry_run, new_items, count, last_run_at, _meta }` |
| `status` | `{ firebase: {ok, latency_ms, maxitem}, algolia: {ok, latency_ms}, _meta }` |

`_meta`: `{ source: "firebase" | "algolia" | "mixed" | "html", endpoints: [...], requests: N, fetched_at }`. Algolia exposes no rate-limit headers, so `_meta.requests` (calls made by this invocation) replaces `_meta.rate_limit` as the pacing signal.

Errors: JSON to **stderr**, `{ error, status_code, endpoint, details, hint }`, exit code 1 — the `rit`/`civit` convention. (voska uses semantic exit codes `3/5/8`; see decision 3.)

### 4.6 Pacing and limits

- 250 ms between calls inside loops (`digest`, `feed run`, `--all`, fallbacks), same as `civit`.
- `--all` slices by `created_at_i` windows (halve the window until `nbHits < 1000`), capped by `--max-pages`; log dropped ranges to `_meta` rather than truncating silently.
- `thread get` defaults to `--max-comments 200` with `truncated: true`; a 2 000-comment Ask HN is a multi-MB payload otherwise.
- Documented Algolia budget: 10 000 req/h. Even the heaviest `digest` uses < 20.

### 4.7 Skill — `hn-hackernews-research`

Same skeleton as `rit-reddit-research`: when to use → check `hn status` → output contract → cheat sheet → intent→command table → jq patterns → workflows → pacing. Recipes that HN uniquely enables:

1. "What does HN think about X" — `search -q X --since 1y --min-points 20` → top 5 by `num_comments` → `thread get --max-comments 100`.
2. "Summarize this thread" — `thread get <url> --sort top` → feed `story.text` + top-level comments to the summarizer (Simon Willison's theme-extraction prompt as the reference).
3. "Has HN covered this site / competitor?" — `hn domain competitor.com --since 2y`.
4. "Who is hiring for <stack> / remote?" — `hn hiring --keywords "…"`; "who wants to be hired" for talent scans.
5. "What did YC launch this month?" — `hn launches --since 30d --min-points 30`.
6. Brand/keyword monitoring — `feed create brand --keywords "…" --type story,comment` then `feed run` on a schedule.
7. Person deep-dive — `user get` + `user posts/comments --since 1y` + jq for domains/themes.
8. "What's trending right now?" — `hn top --limit 30`, `hn best`.

## 5. Roadmap

| Version | Scope | Notes |
|---|---|---|
| **v1** | feeds, search/domain, thread get/search, item, user get/posts/comments, hiring, launches, digest, feed, status, config; README + CLAUDE.md in sibling format; skill | No auth at all. Vitest for URL shaping + normalization (cheap here; the siblings planned tests but never wired them). |
| **v1.1** | `user favorites` (public HTML), `watch` (updates.json → NDJSON), `--all` window slicing, optional `hn yc companies` (yc-oss/api) | All still keyless. |
| **v2 (opt-in)** | `auth cookies import --stdin` (`user=` cookie), `me upvoted\|hidden\|threads`, `upvote`, `fave`, `comment`, `submit` | HTML-form scraping with per-item `auth` tokens, `--yes` gates, hard pacing, ToS/ban warning on first use. Defer until a concrete need. |

## 6. Build plan and effort

1. Copy the `rit` scaffold; delete `cookies/`, `clients/public.ts`, OAuth config; keep `output.ts`, `errors.ts` shape, `feed.ts`, `install_global.sh`, `tsup.config.ts`.
2. `clients/firebase.ts` (6 list endpoints + item/user/updates/maxitem) and `clients/algolia.ts` (search, search_by_date, items, users, `hydrate(ids)`), with a shared `fetchJson` that percent-encodes filters and records `_meta.requests`.
3. `normalize.ts` + HTML→text; `types.ts`.
4. Commands in the order: `status` → feeds → `search`/`domain` → `thread` → `user` → `hiring`/`launches` → `digest` → `feed`.
5. README, CLAUDE.md (architecture + this research + roadmap), `research/hn-api-notes.md` (this file's §3, trimmed), skill + symlink + skills-repo commit.
6. Acceptance: `hn status` green; `hn top --limit 30` ≤ 2 requests; `hn search -q "claude code" --since 30d --min-points 100` populated; `hn thread get 8863` returns 32 top-level comments; `hn hiring --month 2026-08 --keywords remote` returns matches; `hn feed run x` second run → 0 new; `_meta.requests` correct on every command.

Estimate: **v1 ≈ 2–3 h** of focused work, **skill ≈ 1 h**.

## 7. Decisions to confirm before implementing

1. **Name** — `hn` (recommended) vs `hnr`/`ycn`. Only real tradeoff: coexistence with voska's `brew` binary if ever installed.
2. **Build vs adopt voska/hn-cli** — recommend build (gaps in §1; contract mismatch with siblings). Adopt only if the goal shrinks to "search + read a thread".
3. **Exit codes** — sibling-consistent `1` for every error (recommended) vs voska-style `3/5/8` semantic codes.
4. **Sugar commands in v1** — keep `hiring`, `launches`, `domain` in v1 (recommended; they are the HN-specific value and each is a thin wrapper) or demote to skill recipes.
5. **YC directory** — `hn yc companies …` in v1.1, or a separate tiny `yc` CLI later. Recommend v1.1 flag, not v1.
6. **Skill name** — `hn-hackernews-research` (matches `rit-reddit-research` / `civit-civitai-research`).

## 8. References

- [HackerNews/API](https://github.com/HackerNews/API) — official Firebase v0 docs
- [HN Search API (Algolia)](https://hn.algolia.com/api) · [1000-hit cap issue #230](https://github.com/algolia/hn-search/issues/230) · [Practical guide (agent37)](https://www.agent37.com/blog/hacker-news-api) · [Cotera guide](https://cotera.co/articles/hacker-news-api-guide)
- [hnrss.org](https://hnrss.org/) — Algolia-backed RSS/JSON Feed
- [voska/hn-cli](https://github.com/voska/hn-cli) · [devrelopers/hackernews-mcp](https://github.com/devrelopers/hackernews-mcp) · [simonw/llm-hacker-news](https://github.com/simonw/llm-hacker-news) · [Simon Willison — HN themes with Claude](https://til.simonwillison.net/llms/claude-hacker-news-themes) · [donnemartin/haxor-news](https://github.com/donnemartin/haxor-news)
- [Swizec — How I reverse-engineered Hacker News](https://swizec.com/blog/how-i-reverseengineered-hacker-news) · [Gist: scraping personal upvotes](https://gist.github.com/VehpuS/d70dc3669d96da953c7a4f9f6665e83d) — write/account mechanics
- [yc-oss/api](https://github.com/yc-oss/api) — YC company directory JSON
- Siblings: [`rit`](https://github.com/nachoal/rit) · [`civit`](https://github.com/nachoal/civit) · [`bird`](https://github.com/steipete/bird)
