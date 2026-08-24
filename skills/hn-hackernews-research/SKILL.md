---
name: hn-hackernews-research
description: Research Hacker News programmatically with the local `hn` CLI — front page and ranked feeds (top/new/best/ask/show/jobs), full-text search over stories and comments with date ranges and point thresholds, whole comment trees for a thread, everything HN has said about a domain, user profiles/posts/comments, the monthly "Who is hiring?" threads, "Launch HN" posts, multi-keyword digests, and persistent idempotent keyword feeds. Use it whenever a task touches Hacker News, news.ycombinator.com, HN comments or threads, HN sentiment / market / competitor research, "what does HN think about X", HN job threads, or YC launches — even when the user never says "hn". Prefer it over web search or scraping for anything HN-related.
disable-model-invocation: true
---

# hn — Agent-first Hacker News research CLI

`hn` is a local CLI over the two public Hacker News APIs — the official Firebase API (ranked feeds, live items, users) and the Algolia HN Search API (full-text search, date ranges, whole comment trees). No auth, no keys, no scraping. Every command prints one JSON object to stdout; errors are JSON on stderr with exit code 1.

## When this skill is useful

- "What does HN think about X?" / "Is there HN discussion of X?"
- "Summarize this thread: https://news.ycombinator.com/item?id=…"
- "What's on the HN front page / what was big on HN this week?"
- "Has Hacker News covered <site or competitor>?" (domain search)
- "Who is hiring for <stack / remote>?" / "Who wants to be hired?" (monthly threads)
- "Which YC startups launched on HN recently?" (Launch HN)
- "What has <user> posted / commented?"
- "Track mentions of <brand> on HN going forward"
- Any market, competitor, sentiment, or customer-discovery research where HN is a source

If Hacker News is involved at all, use `hn` — do not curl news.ycombinator.com and do not fall back to a generic search engine when `hn` returns structured JSON in one call.

## Before anything else

```bash
hn status
```

Expected: `"ok": true` with latency for both `firebase` and `algolia`. If it fails, the network is the problem — there is nothing to authenticate. If `hn` is not on PATH: `npm install -g github:nachoal/hn`.

## Output contract

Every success is one JSON object. Shapes:

| Command family | Shape |
|---|---|
| `top` `new` `best` `ask` `show` `jobs` | `{ feed, items, count, page, total_available, _meta }` |
| `search`, `domain`, `user posts`, `launches` | `{ items, count, page, nb_hits, nb_pages, _meta }` (`--all` adds `pages_fetched, windows, capped`) |
| `search --comments`, `user comments`, `thread search` | same, but `items` are comments |
| `thread get` | `{ story, comments: [tree], comment_count, returned_count, truncated, _meta }` |
| `item get` | `{ item, _meta }` (live record: `kids`, `parent`, real-time `points`) |
| `user get` | `{ user: { id, karma, created_at, about, submitted_count, … }, _meta }` |
| `hiring` | `{ kind, thread, keywords, matched_count, count, items: [posts], _meta }` |
| `digest` | `{ keywords, buckets: [{ keyword, nb_hits, count, items }], unique_count, _meta }` |
| `feed run` | `{ feed, dry_run, new_items, count, last_run_at, seen_count, _meta }` |

Item fields (identical whichever API served it): `id, type (story|ask|show|job|poll|comment), title, url, domain, author, points, num_comments, created_at, text, hn_url, rank?`. Comments: `id, author, text, created_at, parent_id, story_id, depth, reply_count, replies[], hn_url` (+ `story_title` in search results). HTML is already converted to plain text.

`_meta` tells you what it cost: `{ source: firebase|algolia|mixed, requests, endpoints, fetched_at, note? }`. Read `note` — it flags truncation, the 1,000-hit cap, or index lag.

Errors: `{ error, message|details, hint }` on stderr, exit 1. `NotFoundError` means the id/user does not exist (or is not indexed yet); `HnApiError` with `status_code` 0 is a network problem.

Use `--pretty` only when showing output to the user; omit it when piping.

## Command cheat sheet

```bash
# Ranked feeds (Firebase ranking, 1-2 requests per page)
hn top|new|best|ask|show|jobs [--limit 30] [--page 1] [--live] [--no-jobs]

# Search — the workhorse (Algolia)
hn search -q "<text>" [--type story|ask|show|poll|job|comment|all] [--comments]
          [--sort relevance|date] [--since 7d | --after YYYY-MM-DD] [--before YYYY-MM-DD]
          [--min-points N] [--min-comments N] [--author <user>] [--in title|url|text]
          [--limit 20] [--page 1] [--all --max-pages 10]
hn domain <example.com> [--since 1y] [--sort points|date] [--min-points N]

# Threads and items
hn thread get <id|url> [--max-comments 200] [--depth N] [--sort top|new|old] [--flat]
hn thread search <id> -q "<text>"
hn item get <id>                                # live record, any type

# Users
hn user get <name> | posts <name> [--type] [--since] [--sort date|points] | comments <name> [-q] [--since]

# HN-specific research
hn hiring [--kind hiring|wants-to-be-hired|freelancer] [--month YYYY-MM] [--keywords "a,b"] [--match any|all] [--limit 100] [--list]
hn launches [--since 30d] [--batch S26] [--min-points N] [--sort date|points]
hn digest --keywords "a,b,c" [--type] [--since 7d] [--min-points N] [--sort relevance|date]
hn feed create <name> --keywords "…" [--type all] [--since 7d] [--min-points N]
hn feed run <name> [--dry-run] | list | delete <name> --yes

# Diagnostics
hn status | hn config show | hn <command> --help
```

`--since` accepts `1h 24h 7d 2w 30d 1y`. `--after/--before` take `YYYY-MM-DD` (UTC) and `--after` overrides `--since`.

## Choosing the right command

| User intent | Command |
|---|---|
| "What's on the front page?" | `hn top --limit 30` |
| "What was big this week?" | `hn search --since 7d --min-points 200 --sort date` (no `-q` needed) |
| "What does HN think about X?" | `hn search -q "X" --since 1y --min-points 20` → top hits by `num_comments` → `hn thread get <id> --max-comments 100` |
| "Summarize <HN URL>" | `hn thread get <url> --max-comments 150` |
| "Only top-level comments" | `hn thread get <id> --depth 1` |
| "What are commenters saying about X?" | `hn search -q "X" --comments --since 30d --limit 50` |
| "Has HN covered acme.com?" | `hn domain acme.com --since 2y` |
| "Ask HN about X" / "Show HN X" | `hn search -q "X" --type ask` / `--type show` |
| "Who is hiring for Rust, remote?" | `hn hiring --keywords "rust,remote" --match all` |
| "Candidates who know Rails" | `hn hiring --kind wants-to-be-hired --keywords rails` |
| "YC launches this month" | `hn launches --since 30d` |
| "Compare mentions of A vs B" | `hn digest --keywords "A,B" --since 30d` |
| "What has <user> posted?" | `hn user posts <user> --limit 50`; `hn user comments <user> --limit 100` |
| "Track <brand> mentions" | `hn feed create brand --keywords "brand" --type all` once, then `hn feed run brand` on a schedule |
| "Exact live score of a story" | `hn item get <id>` |

## Piping patterns (jq)

```bash
# Titles + points from the front page
hn top | jq -r '.items[] | "\(.rank). \(.title) [\(.points)] \(.hn_url)"'

# Most-discussed matches, then pull the top 3 threads
hn search -q "local llm" --since 90d --limit 50 \
  | jq -r '.items | sort_by(-.num_comments) | .[:3] | .[].id' \
  | while read id; do hn thread get "$id" --max-comments 60 --flat; done

# Top-level comments of a thread as "author: text"
hn thread get 8863 --depth 1 --flat | jq -r '.comments[] | "\(.author): \(.text // "" | .[0:300])"'

# One line per launch
hn launches --since 60d | jq -r '.items[] | "\(.company) (\(.batch)) — \(.tagline) [\(.points) pts]"'

# Hiring posts that mention both keywords, first 300 chars each
hn hiring --keywords "remote,python" --match all | jq -r '.items[] | .text[0:300] + "\n---"'

# Digest counts only
hn digest --keywords "cursor,claude code,codex" --since 7d | jq '.buckets[] | {keyword, nb_hits, count}'
```

## Workflows

### "What does HN think about X?"

1. `hn search -q "X" --since 1y --min-points 20 --limit 50` — the index ranks by relevance weighted with points.
2. Pick 3-5 hits with the highest `num_comments` (engagement beats points for opinions).
3. `hn thread get <id> --max-comments 100` per hit. Top-level comments carry most of the signal; recurse into `replies` only for load-bearing threads.
4. Report with `hn_url` citations. Label findings as HN community opinion, not fact.

### Thread summarization

`hn thread get <url> --max-comments 150` returns `story.text` (for Ask/Show/text posts) and the comment tree already in HN's own display order for top-level comments. If `truncated` is true and the user wants everything, re-run with `--max-comments 0` (large threads are hundreds of KB — prefer `--flat` and jq to trim).

### Monitoring

```bash
hn feed create brand --keywords "acme,acme.com" --type all --since 7d
hn feed run brand          # later, on a schedule — returns only unseen items
```

State lives in `~/.hn/feeds/<name>.json` (`seen_ids`); re-running is safe and idempotent. `--dry-run` previews without marking anything seen.

More recipes (person deep-dive, competitor scan, hiring market read, launch tracking, historical pulls) are in `references/workflows.md` — read it when the task is one of those.

## Pacing and limits

- Firebase has no documented rate limit; Algolia allows ~10,000 requests/hour and exposes no rate-limit headers — `_meta.requests` is your counter. Ordinary research uses 1-5 requests per command.
- Algolia caps every query at **1,000 hits**. `nb_pages` reflects the cap. Narrow with `--since/--after/--before` or use `--all`, which slices the date range automatically (bounded by `--max-pages`; `capped: true` means the budget ran out).
- Loops (`digest`, `feed run`, `--all`) pace themselves at 250 ms per request (`hn config set --pace-ms`). Don't wrap `hn` in a tight polling loop; for monitoring use `feed run` on a schedule.
- Prefer `hn top` (one Algolia batch request per page) over `--live` (one Firebase request per item) unless real-time scores matter.

## Common gotchas

- **`front_page`-style history does not exist.** `hn top` is the front page *now*. For "what was on the front page last week", use `hn search --since 7d --min-points 100 --sort date` or `hn best`.
- **Points on comments are always null** (HN hides them); `thread get --sort top` uses HN's own ranking for top-level comments instead.
- **Jobs are not in the search index**: `hn jobs` and `hn top` fetch them from Firebase automatically; `hn search --type job` only finds older, indexed job posts.
- **Brand-new items** (< ~1 minute) and deleted/dead items are missing from Algolia; `hn item get <id>` reads the live record.
- **IDs vs URLs**: every `<id>` argument accepts a numeric id or a `news.ycombinator.com/item?id=…` URL.
- **`--type ask`/`show`** rely on the "Ask HN:" / "Show HN:" title prefix as tagged by Algolia.
- **Usernames are case-sensitive.**

## Help discovery

```bash
hn --help                 # all commands
hn search --help          # flags + concrete examples for one command
hn thread get --help      # nested subcommands
```

Every subcommand has real examples in its help output. Trust those over memory.

## Additional references

- `references/workflows.md` — longer end-to-end research recipes with jq
- Project README and CLAUDE.md in the `hn` repository (https://github.com/nachoal/hn) — API notes, design, roadmap
