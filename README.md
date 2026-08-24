# hn

Agent-first CLI for Hacker News research. One command per question, JSON out, no auth.

```bash
hn top --limit 5 | jq -r '.items[] | "\(.rank). \(.title) [\(.points)]"'
hn search -q "local llm" --since 30d --min-points 50
hn thread get https://news.ycombinator.com/item?id=8863 --max-comments 100
hn domain anthropic.com --since 1y
hn hiring --keywords "remote,rust" --match all
hn launches --since 60d --batch S26
```

Built for AI agents and shell pipelines: every input is a flag, every output is one JSON object on stdout, errors are JSON on stderr with exit code 1, and every subcommand's `--help` has real examples. Sibling of [`bird`](https://github.com/steipete/bird) (X), [`rit`](https://github.com/nachoal/rit) (Reddit) and [`civit`](https://github.com/nachoal/civit) (Civitai).

## Why

Hacker News has two public, keyless APIs and neither is enough on its own. The [official Firebase API](https://github.com/HackerNews/API) has the real ranking and live scores but no search and one request per item; the [Algolia HN Search API](https://hn.algolia.com/api) has full-text search, exact date ranges and whole comment trees in one call, but lags a little and knows nothing about ranking or jobs. `hn` uses each for what it is good at — and hydrates a whole page of front-page ids with a single Algolia request instead of thirty Firebase ones.

## Install

Node 20+.

```bash
npm install -g https://github.com/nachoal/hn/releases/latest/download/hn.tgz
hn status                             # both APIs reachable?
```

That is the packed npm tarball from the latest [release](https://github.com/nachoal/hn/releases) — prebuilt, no toolchain needed. (Plain `npm install -g github:nachoal/hn` is unreliable: npm's global installer mishandles GitHub specs on some setups; as a *project* dependency, `npm install github:nachoal/hn` works fine.)

From a clone (what `install_global.sh` does: `npm install`, build, `npm link`, create `~/.hn/`):

```bash
git clone https://github.com/nachoal/hn && cd hn && ./install_global.sh
```

## Agent skill (Claude Code, Codex, pi)

The repo ships a skill — `hn-hackernews-research` — that teaches an agent when to reach for `hn`, the output contract, and research recipes. Install it into any of the three harnesses:

```bash
hn skill install --all              # Claude Code + Codex + pi
hn skill install --claude --auto    # Claude Code, auto-triggered on HN-related tasks
hn skill status                     # where it is installed, and whether copies are current
```

| Harness | Location | Invoke |
|---|---|---|
| Claude Code | `~/.claude/skills/hn-hackernews-research` (symlink) | `/hn-hackernews-research` — slash-only by default; `--auto` installs a copy that Claude can trigger on its own |
| Codex CLI | `$CODEX_HOME/skills/hn-hackernews-research` (copy) | `$hn-hackernews-research`, or automatically |
| pi | `~/.pi/agent/skills/hn-hackernews-research` (copy) | `/skill:hn-hackernews-research`, or automatically |
| Any [Agent Skills](https://agentskills.io) harness | `~/.agents/skills/…` via `--agents` | per harness |

Manual alternative: `ln -s "$(hn skill path)" ~/.claude/skills/hn-hackernews-research`.

## Commands

```
hn top|new|best|ask|show|jobs [--limit 30] [--page 1] [--live] [--no-jobs]

hn search -q "<text>" [--type story|ask|show|poll|job|comment|all] [--comments]
          [--sort relevance|date] [--since 7d | --after YYYY-MM-DD] [--before YYYY-MM-DD]
          [--min-points N] [--min-comments N] [--author <user>] [--in title|url|text]
          [--limit 20] [--page 1] [--all --max-pages 10]
hn domain <example.com> [--since 1y] [--sort points|date] [--min-points N]

hn thread get <id|url> [--max-comments 200] [--depth N] [--sort top|new|old] [--flat]
hn thread search <id> -q "<text>"
hn item get <id>                     # live record, any type (real-time score, kids, parent)

hn user get <name>
hn user posts <name> [--type] [--since] [--sort date|points]
hn user comments <name> [-q] [--since]

hn hiring [--kind hiring|wants-to-be-hired|freelancer] [--month YYYY-MM] [--keywords "a,b"] [--match any|all] [--limit 100] [--list]
hn launches [--since 30d] [--batch S26] [--min-points N] [--sort date|points]
hn digest --keywords "a,b,c" [--type] [--since 7d] [--min-points N] [--sort relevance|date]
hn feed create <name> --keywords "…" [--type all] [--since 7d] [--min-points N]
hn feed run <name> [--dry-run] | feed list | feed delete <name> --yes

hn status | hn config show|set | hn skill install|status|path
```

`--since` takes `1h 24h 7d 2w 30d 1y`; `--after`/`--before` take `YYYY-MM-DD` (UTC). Add `--pretty` to any command for indented output.

## Examples

```bash
# What was big this week (no text query needed)
hn search --since 7d --min-points 200 --sort date --limit 50 | jq -r '.items[] | "\(.points)\t\(.title)"'

# What commenters said about something, last month
hn search -q "rate limit" --comments --since 30d --limit 50 | jq -r '.items[] | "\(.author): \(.text[0:200])"'

# Thread summary input: story + top-level comments in HN's own order
hn thread get 8863 --depth 1 --flat | jq -r '.comments[] | "\(.author): \(.text)"'

# Everything HN has submitted from a site, most upvoted first
hn domain simonwillison.net --since 1y | jq '.items[] | {title, points, num_comments, hn_url}'

# Remote Rust jobs in this month's "Who is hiring?"
hn hiring --keywords "remote,rust" --match all --limit 0 | jq -r '.items[] | .text[0:300] + "\n---"'

# Track brand mentions; re-runs return only unseen items
hn feed create brand --keywords "acme,acme.com" --type all
hn feed run brand

# Historical pull past Algolia's 1,000-hit cap (auto-slices by date)
hn search -q "sqlite" --after 2025-01-01 --before 2026-01-01 --all --max-pages 40 --sort date
```

## Output

Items look the same whichever API served them:

```json
{
  "id": 49420873, "type": "story", "title": "…", "url": "https://…", "domain": "example.com",
  "author": "someone", "points": 505, "num_comments": 335, "created_at": "2026-08-24T18:01:02Z",
  "text": null, "hn_url": "https://news.ycombinator.com/item?id=49420873", "rank": 2
}
```

`type` is `story | ask | show | job | poll | comment`. Comments carry `text` (HTML already converted to plain text), `parent_id`, `story_id`, `depth`, `reply_count`, `replies[]`. Listings are `{ items, count, page, nb_hits, nb_pages, _meta }`; `thread get` is `{ story, comments, comment_count, returned_count, truncated, _meta }`.

Every response ends with `_meta`:

```json
{ "source": "mixed", "requests": 2, "endpoints": ["firebase:topstories", "algolia:search"], "fetched_at": "…", "note": "…" }
```

Errors go to stderr as `{ "error", "message" | "details", "hint" }` with exit code 1.

## Limits worth knowing

- Algolia caps every query at **1,000 hits**; `nb_pages` reflects the cap. Narrow the window or use `--all`, which slices the date range automatically (bounded by `--max-pages`, reported as `capped`).
- Algolia documents ~10,000 requests/hour and exposes no rate-limit headers; `_meta.requests` is your counter. Loops pace at 250 ms (`hn config set --pace-ms`).
- Comment points are always `null` (HN hides them). `thread get --sort top` uses HN's own ranking for top-level comments instead.
- Jobs and items younger than about a minute are not in the search index; `hn top`/`hn jobs` fetch them from Firebase automatically and `hn item get` always reads the live record.
- No login: nothing account-specific (upvoted, favorites, hidden) and no writes. See the roadmap.

## Development

```bash
npm install
npm run dev -- top --limit 3    # tsx, no build
npm test                        # vitest, mocked fetch — no network
npm run lint                    # tsc --noEmit
npm run build                   # tsup → dist/index.js
```

Design notes, the API research behind it, and the roadmap live in [CLAUDE.md](./CLAUDE.md) and [research/](./research/).

## Roadmap

- **v1.1** — `user favorites` (public page, no login), `watch` (Firebase `updates.json` → NDJSON stream), optional YC company directory via [yc-oss/api](https://github.com/yc-oss/api).
- **v2** — opt-in cookie mode for account features and light writes (upvoted list, favorite, upvote, comment).

## License

MIT
