# hn workflows — end-to-end research recipes

Longer patterns for when the cheat sheet in SKILL.md is not enough. Every command emits JSON; pipe through `jq`.

## 1. "What does HN think about X?" (opinion read)

```bash
# Candidate threads: relevance-ranked, popular, last year
hn search -q "<topic>" --since 1y --min-points 20 --limit 50 > /tmp/hits.json

# Rank by engagement and keep the top 5
jq '.items | sort_by(-.num_comments) | .[:5] | .[] | {id, title, points, num_comments, hn_url}' /tmp/hits.json

# Pull each thread, top-level comments first (level-order truncation)
for id in $(jq -r '.items | sort_by(-.num_comments) | .[:5] | .[].id' /tmp/hits.json); do
  hn thread get "$id" --max-comments 80 --flat > "/tmp/thread-$id.json"
done

# Author + first 300 chars of every kept comment
jq -r '.comments[] | "\(.author) [d\(.depth)]: \(.text // "" | .[0:300])"' /tmp/thread-*.json
```

Read `story.text` for Ask/Show posts. Summarize: main positions, strongest objections, notable dissent, anything from people claiming first-hand experience. Cite `hn_url`s.

## 2. Thread deep-dive / summary

```bash
hn thread get <url> --max-comments 200 > /tmp/t.json
jq '{title: .story.title, url: .story.url, points: .story.points, total_comments: .comment_count, truncated}' /tmp/t.json

# Top-level comments in HN's display order
jq -r '.comments[] | "• \(.author) (\(.reply_count) replies): \(.text // "" | .[0:400])"' /tmp/t.json

# Dig into one sub-thread (its id) when a top-level comment is load-bearing
hn thread get <comment-id> --flat | jq -r '.comments[] | "\("  " * .depth)\(.author): \(.text[0:200])"'
```

`thread get` accepts a comment id and returns that subtree — useful for long threads where one branch matters.

## 3. Competitor / brand check

```bash
# Submissions from their site, most upvoted first
hn domain competitor.com --since 2y --limit 50 | jq '.items[] | {title, points, num_comments, created_at, hn_url}'

# Mentions in stories AND comments last 90 days
hn search -q "competitor" --type all --since 90d --limit 100 \
  | jq '.items[] | {type, title: (.title // .story_title), points, hn_url}'

# Ongoing: only new mentions each run
hn feed create competitor --keywords "competitor,competitor.com" --type all --since 7d
hn feed run competitor
```

## 4. Hiring market read

```bash
# Which threads exist
hn hiring --list | jq '.threads[] | {month, title, num_comments}'

# Jobs mentioning any keyword (default kind: "Who is hiring?")
hn hiring --keywords "remote,rust" | jq '{matched_count, sample: [.items[:3][].text[0:200]]}'

# Jobs that mention ALL keywords, every match
hn hiring --keywords "remote,typescript,senior" --match all --limit 0 > /tmp/jobs.json
jq -r '.items[] | .text[0:500] + "\n" + .hn_url + "\n---"' /tmp/jobs.json

# Candidate side
hn hiring --kind wants-to-be-hired --keywords "rails,remote" --match all

# Compare demand across months for a skill
for m in 2026-06 2026-07 2026-08; do
  printf "%s " "$m"; hn hiring --month "$m" --keywords "rust" --limit 0 | jq '.matched_count'
done
```

The first line of a hiring post is conventionally `Company | Role | Location | Remote/Onsite | Salary`. Parse it from `.text` with `split("\n")[0]`.

## 5. YC launch tracking

```bash
hn launches --since 90d --sort points | jq -r '.items[] | "\(.points)\t\(.company)\t\(.batch)\t\(.tagline)\t\(.hn_url)"'

# One batch only
hn launches --since 1y --batch S26 --limit 200 | jq '{count, top: [.items | sort_by(-.points) | .[:5][] | {company, points, num_comments}]}'

# Reactions to one launch
hn thread get <id> --max-comments 60 --flat | jq -r '.comments[] | "\(.author): \(.text[0:250])"'
```

## 6. Person deep-dive

```bash
hn user get <name> | jq '.user | {karma, created_at, submitted_count, about}'
hn user posts <name> --limit 100 --sort points | jq '.items[] | {title, points, num_comments, domain, created_at}'
hn user comments <name> --limit 200 > /tmp/comments.json

# Which stories they engage with most
jq -r '.items[].story_title' /tmp/comments.json | sort | uniq -c | sort -rn | head -20

# Comments mentioning a topic
hn user comments <name> -q "<topic>" --since 1y | jq -r '.items[] | "\(.created_at) \(.story_title): \(.text[0:200])"'
```

## 7. Historical / bulk pulls

Algolia caps a single query at 1,000 hits. `--all` slices the date range automatically:

```bash
# Every story mentioning "sqlite" in 2025, newest first, up to 40 requests
hn search -q "sqlite" --after 2025-01-01 --before 2026-01-01 --sort date --all --max-pages 40 --limit 200 > /tmp/sqlite-2025.json
jq '{count, nb_hits, pages_fetched, windows, capped}' /tmp/sqlite-2025.json
```

`capped: true` means `--max-pages` ran out before the range was exhausted — raise it or narrow the window. For counts alone, one request is enough: `nb_hits` is exact even when hits are capped.

## 8. "What was big this week?" (no query)

```bash
hn search --since 7d --min-points 200 --sort date --limit 100 | jq -r '.items[] | "\(.points)\t\(.num_comments)\t\(.title)"' | sort -rn | head -30
hn best --limit 50 | jq -r '.items[] | "\(.points)\t\(.title)"'
```

`hn best` is HN's own "best" ranking (recent, highest-voted). The search form lets you control the window and threshold precisely.
