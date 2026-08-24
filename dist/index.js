#!/usr/bin/env node

// src/cli.ts
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// src/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var VERSION = "1.0.0";
function configDir() {
  return process.env.HN_CONFIG_DIR ?? join(homedir(), ".hn");
}
function configPath() {
  return join(configDir(), "config.json");
}
function feedsDir() {
  return join(configDir(), "feeds");
}
function loadConfig() {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}
function saveConfig(config) {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
}
function envNumber(name) {
  const raw = process.env[name];
  if (raw === void 0 || raw === "") return void 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : void 0;
}
function resolveSettings() {
  const cfg = loadConfig();
  return {
    paceMs: envNumber("HN_PACE_MS") ?? cfg.paceMs ?? 250,
    defaultLimit: cfg.defaultLimit ?? 30,
    timeoutMs: envNumber("HN_TIMEOUT_MS") ?? cfg.timeoutMs ?? 2e4,
    userAgent: cfg.userAgent ?? `hn-cli/${VERSION} (+https://github.com/nachoal/hn)`
  };
}

// src/output.ts
function output(data, pretty) {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  process.stdout.write(json + "\n");
}
function outputError(err, pretty) {
  let payload;
  const maybe = err;
  if (maybe && typeof maybe.toJSON === "function") {
    payload = maybe.toJSON();
  } else if (err instanceof Error) {
    payload = { error: err.name || "Error", message: err.message };
  } else {
    payload = { error: "Error", message: String(err) };
  }
  const json = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  process.stderr.write(json + "\n");
}

// src/commands/config.ts
function registerConfigCommands(yargs2) {
  return yargs2.command(
    "config",
    "Local settings (~/.hn/config.json)",
    (y) => y.command(
      "set",
      "Save settings",
      (y2) => y2.option("pace-ms", { type: "number", describe: "Delay between requests inside loops (digest, feed run, --all). Default 250" }).option("default-limit", { type: "number", describe: "Reserved for future defaults" }).option("timeout-ms", { type: "number", describe: "Per-request timeout. Default 20000" }).option("user-agent", { type: "string", describe: "User-Agent header override" }).example("hn config set --pace-ms 500", "Slow down batch loops").example("hn config set --timeout-ms 40000", "Slow network"),
      async (argv) => {
        const next = {
          ...loadConfig(),
          ...argv.paceMs !== void 0 && { paceMs: argv.paceMs },
          ...argv.defaultLimit !== void 0 && { defaultLimit: argv.defaultLimit },
          ...argv.timeoutMs !== void 0 && { timeoutMs: argv.timeoutMs },
          ...argv.userAgent !== void 0 && { userAgent: argv.userAgent }
        };
        saveConfig(next);
        output({ saved: true, path: configPath(), config: next }, argv.pretty);
      }
    ).command(
      "show",
      "Display the saved config and the effective settings",
      (y2) => y2.example("hn config show", "Effective settings incl. env overrides (HN_CONFIG_DIR, HN_PACE_MS, HN_TIMEOUT_MS)"),
      async (argv) => {
        output({ path: configPath(), config: loadConfig(), effective: resolveSettings() }, argv.pretty);
      }
    ).demandCommand(1, "Specify a subcommand: set, show\n\n  Example: hn config show")
  );
}

// src/clients/algolia.ts
function enc(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
var ALGOLIA_MAX_HITS = 1e3;
var AlgoliaClient = class {
  constructor(http, base = "https://hn.algolia.com/api/v1") {
    this.http = http;
    this.base = base;
  }
  http;
  base;
  buildUrl(q) {
    const endpoint = q.sort === "date" ? "search_by_date" : "search";
    const params = [];
    if (q.query) params.push(`query=${enc(q.query)}`);
    if (q.tags) params.push(`tags=${enc(q.tags)}`);
    if (q.numericFilters && q.numericFilters.length > 0) params.push(`numericFilters=${enc(q.numericFilters.join(","))}`);
    if (q.restrictSearchableAttributes) params.push(`restrictSearchableAttributes=${enc(q.restrictSearchableAttributes)}`);
    const hitsPerPage = Math.min(Math.max(q.hitsPerPage ?? 20, 1), ALGOLIA_MAX_HITS);
    params.push(`hitsPerPage=${hitsPerPage}`);
    params.push(`page=${Math.max(q.page ?? 0, 0)}`);
    return `${this.base}/${endpoint}?${params.join("&")}`;
  }
  async search(q) {
    const label = q.sort === "date" ? "algolia:search_by_date" : "algolia:search";
    const res = await this.http.getJson(this.buildUrl(q), label);
    return res ?? { hits: [], nbHits: 0, nbPages: 0, page: 0, hitsPerPage: q.hitsPerPage ?? 20 };
  }
  /** Full nested tree for a story (or the subtree under a comment) in one request. */
  item(id) {
    return this.http.getJson(`${this.base}/items/${id}`, "algolia:items", { allowNotFound: true });
  }
  /** Algolia returns HTTP 500 for unknown users, so failures are reported as null. */
  async user(name) {
    try {
      return await this.http.getJson(`${this.base}/users/${encodeURIComponent(name)}`, "algolia:users", { allowNotFound: true });
    } catch {
      return null;
    }
  }
  /**
   * Fetch many stories by id in one request per chunk using `tags=(story,job,poll),(story_1,story_2,…)`.
   * The first group keeps comments out (they also carry `story_<id>` tags). Jobs are not indexed by
   * Algolia and brand-new items lag by a minute or so — callers fall back to Firebase for misses.
   */
  async hydrate(ids, chunkSize = 40) {
    const out = /* @__PURE__ */ new Map();
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const res = await this.search({
        tags: `(story,job,poll),(${chunk.map((id) => `story_${id}`).join(",")})`,
        hitsPerPage: chunk.length
      });
      for (const hit of res.hits) out.set(Number(hit.objectID), hit);
    }
    return out;
  }
};

// src/errors.ts
var HnApiError = class extends Error {
  constructor(statusCode, endpoint, details, url) {
    super(`${endpoint} failed (${statusCode || "network"}): ${details}`);
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.details = details;
    this.url = url;
    this.name = "HnApiError";
  }
  statusCode;
  endpoint;
  details;
  url;
  toJSON() {
    let hint;
    if (this.statusCode === 429) hint = "Rate limited by the upstream API. Wait a minute, then retry with a smaller --limit or fewer keywords.";
    else if (this.statusCode >= 500) hint = "Upstream API error. Run `hn status` to check reachability, then retry.";
    else if (this.statusCode === 0) hint = "Network error. Check connectivity, or raise the timeout with `hn config set --timeout-ms 40000`.";
    return {
      error: this.name,
      status_code: this.statusCode,
      endpoint: this.endpoint,
      details: this.details,
      url: this.url,
      hint
    };
  }
};
var NotFoundError = class extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
    this.name = "NotFoundError";
  }
  hint;
  toJSON() {
    return { error: this.name, message: this.message, hint: this.hint };
  }
};
var UsageError = class extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
    this.name = "UsageError";
  }
  hint;
  toJSON() {
    return { error: this.name, message: this.message, hint: this.hint };
  }
};
var ConfigError = class extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
    this.name = "ConfigError";
  }
  hint;
  toJSON() {
    return { error: this.name, message: this.message, hint: this.hint };
  }
};

// src/http.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var Http = class {
  log = { requests: 0, endpoints: [] };
  timeoutMs;
  userAgent;
  retries;
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 2e4;
    this.userAgent = opts.userAgent ?? "hn-cli (+https://github.com/nachoal/hn)";
    this.retries = opts.retries ?? 2;
  }
  /**
   * GET a JSON document. Returns null on 404 when `allowNotFound` is set (Algolia items),
   * otherwise throws HnApiError. Firebase returns literal `null` bodies for missing items —
   * those come back as null too.
   */
  async getJson(url, label, opts = {}) {
    let attempt = 0;
    while (true) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      this.log.requests++;
      if (!this.log.endpoints.includes(label)) this.log.endpoints.push(label);
      try {
        const res = await fetch(url, {
          headers: { "user-agent": this.userAgent, accept: "application/json" },
          signal: controller.signal
        });
        if (res.status === 404 && opts.allowNotFound) return null;
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if ((res.status >= 500 || res.status === 429) && attempt <= this.retries) {
            await sleep(res.status === 429 ? 1500 * attempt : 400 * attempt);
            continue;
          }
          throw new HnApiError(res.status, label, summarize(body) || res.statusText || "request failed", url);
        }
        const text = await res.text();
        if (text === "" || text === "null") return null;
        return JSON.parse(text);
      } catch (err) {
        if (err instanceof HnApiError) throw err;
        if (attempt <= this.retries) {
          await sleep(400 * attempt);
          continue;
        }
        const message = err?.name === "AbortError" ? `timeout after ${this.timeoutMs}ms` : err.message;
        throw new HnApiError(0, label, `Network error: ${message}`, url);
      } finally {
        clearTimeout(timer);
      }
    }
  }
};
function summarize(body) {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return parsed.error || parsed.message || trimmed.slice(0, 200);
  } catch {
    return trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }
}
async function pMap(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// src/clients/firebase.ts
var FEED_PATHS = {
  top: "topstories",
  new: "newstories",
  best: "beststories",
  ask: "askstories",
  show: "showstories",
  jobs: "jobstories"
};
var FirebaseClient = class {
  constructor(http, base = "https://hacker-news.firebaseio.com/v0") {
    this.http = http;
    this.base = base;
  }
  http;
  base;
  async list(kind) {
    const ids = await this.http.getJson(`${this.base}/${FEED_PATHS[kind]}.json`, `firebase:${FEED_PATHS[kind]}`);
    return Array.isArray(ids) ? ids : [];
  }
  item(id) {
    return this.http.getJson(`${this.base}/item/${id}.json`, "firebase:item");
  }
  items(ids, concurrency = 8) {
    return pMap(ids, concurrency, (id) => this.item(id));
  }
  user(name) {
    return this.http.getJson(`${this.base}/user/${encodeURIComponent(name)}.json`, "firebase:user");
  }
  async updates() {
    const u = await this.http.getJson(`${this.base}/updates.json`, "firebase:updates");
    return u ?? { items: [], profiles: [] };
  }
  async maxitem() {
    const n = await this.http.getJson(`${this.base}/maxitem.json`, "firebase:maxitem");
    return n ?? 0;
  }
};

// src/context.ts
function createContext() {
  const settings = resolveSettings();
  const http = new Http({ timeoutMs: settings.timeoutMs, userAgent: settings.userAgent });
  return { http, firebase: new FirebaseClient(http), algolia: new AlgoliaClient(http), settings };
}
function buildMeta(ctx, note) {
  const labels = ctx.http.log.endpoints;
  const usedAlgolia = labels.some((l) => l.startsWith("algolia"));
  const usedFirebase = labels.some((l) => l.startsWith("firebase"));
  const source = usedAlgolia && usedFirebase ? "mixed" : usedAlgolia ? "algolia" : usedFirebase ? "firebase" : "local";
  const meta = {
    source,
    requests: ctx.http.log.requests,
    endpoints: [...labels],
    fetched_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (note) meta.note = note;
  return meta;
}

// src/text.ts
var NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};
function decodeEntities(input) {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED[lower] ?? match;
  });
}
function htmlToText(html) {
  if (html === null || html === void 0) return null;
  let s = html;
  s = s.replace(/<pre>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code) => {
    return "\n```\n" + decodeEntities(code).replace(/\n+$/, "") + "\n```\n";
  });
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, (_m, code) => "`" + decodeEntities(code) + "`");
  s = s.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const h = decodeEntities(href).trim();
    const t = decodeEntities(text.replace(/<[^>]+>/g, "")).trim();
    if (!t || t === h) return h;
    const stem = t.replace(/\.\.\.$/, "");
    if (h.startsWith(stem) || h.replace(/^https?:\/\//, "").startsWith(stem)) return h;
    return `${t} (${h})`;
  });
  s = s.replace(/<\/p>/gi, "");
  s = s.replace(/<p[^>]*>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(i|em)>/gi, "_");
  s = s.replace(/<\/?(b|strong)>/gi, "**");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// src/normalize.ts
function hnUrl(id) {
  return `https://news.ycombinator.com/item?id=${id}`;
}
function domainOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
function typeFromTags(tags) {
  const t = tags ?? [];
  if (t.includes("comment")) return "comment";
  if (t.includes("job")) return "job";
  if (t.includes("pollopt")) return "pollopt";
  if (t.includes("poll")) return "poll";
  if (t.includes("ask_hn")) return "ask";
  if (t.includes("show_hn")) return "show";
  return "story";
}
function typeFromFirebase(item) {
  switch (item.type) {
    case "job":
      return "job";
    case "poll":
      return "poll";
    case "pollopt":
      return "pollopt";
    case "comment":
      return "comment";
    default: {
      const title = item.title ?? "";
      if (/^Ask HN\b/i.test(title)) return "ask";
      if (/^Show HN\b/i.test(title)) return "show";
      return "story";
    }
  }
}
function isoFromEpoch(seconds) {
  if (seconds === void 0 || seconds === null) return null;
  return new Date(seconds * 1e3).toISOString();
}
function fromAlgoliaHit(hit) {
  const id = Number(hit.objectID);
  const url = hit.url ?? null;
  return {
    id,
    type: typeFromTags(hit._tags),
    title: hit.title ?? null,
    url,
    domain: domainOf(url),
    author: hit.author ?? null,
    points: hit.points ?? null,
    num_comments: hit.num_comments ?? null,
    created_at: hit.created_at ?? isoFromEpoch(hit.created_at_i),
    text: htmlToText(hit.story_text ?? null),
    hn_url: hnUrl(id)
  };
}
function fromFirebaseItem(item) {
  const url = item.url ?? null;
  const out = {
    id: item.id,
    type: typeFromFirebase(item),
    title: item.title ?? null,
    url,
    domain: domainOf(url),
    author: item.by ?? null,
    points: item.score ?? null,
    num_comments: item.descendants ?? null,
    created_at: isoFromEpoch(item.time),
    text: htmlToText(item.text ?? null),
    hn_url: hnUrl(item.id)
  };
  if (item.dead) out.dead = true;
  if (item.deleted) out.deleted = true;
  return out;
}
function commentFromHit(hit) {
  const id = Number(hit.objectID);
  return {
    id,
    type: "comment",
    author: hit.author ?? null,
    text: htmlToText(hit.comment_text ?? null),
    created_at: hit.created_at ?? isoFromEpoch(hit.created_at_i),
    parent_id: hit.parent_id ?? null,
    story_id: hit.story_id ?? null,
    depth: 0,
    hn_url: hnUrl(id),
    story_title: hit.story_title ?? null,
    story_url: hit.story_url ?? null,
    reply_count: 0,
    replies: []
  };
}
function treeFromAlgolia(nodes, depth = 0, maxDepth = 0) {
  const out = [];
  for (const node of nodes) {
    if (node.type !== "comment") continue;
    const children = node.children ?? [];
    const replies = maxDepth > 0 && depth + 1 >= maxDepth ? [] : treeFromAlgolia(children, depth + 1, maxDepth);
    out.push({
      id: node.id,
      type: "comment",
      author: node.author ?? null,
      text: htmlToText(node.text),
      created_at: node.created_at ?? isoFromEpoch(node.created_at_i),
      parent_id: node.parent_id ?? null,
      story_id: node.story_id ?? null,
      depth,
      hn_url: hnUrl(node.id),
      reply_count: children.filter((c) => c.type === "comment").length,
      replies
    });
  }
  return out;
}
function countComments(tree) {
  let n = 0;
  for (const c of tree) n += 1 + countComments(c.replies);
  return n;
}
function flattenComments(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const c of nodes) {
      out.push({ ...c, replies: [] });
      walk(c.replies);
    }
  };
  walk(tree);
  return out;
}
function truncateLevelOrder(tree, max) {
  const total = countComments(tree);
  if (max <= 0 || total <= max) return { comments: tree, truncated: false, returned: total, total };
  const kept = /* @__PURE__ */ new Set();
  const queue = [...tree];
  while (queue.length) {
    const node = queue.shift();
    if (kept.size < max) kept.add(node.id);
    else break;
    queue.push(...node.replies);
  }
  const prune = (nodes) => nodes.filter((n) => kept.has(n.id)).map((n) => ({ ...n, replies: prune(n.replies) }));
  return { comments: prune(tree), truncated: true, returned: kept.size, total };
}
function sortTree(tree, mode) {
  const sorted = [...tree].sort((a, b) => {
    const ta = a.created_at ?? "";
    const tb = b.created_at ?? "";
    return mode === "new" ? tb.localeCompare(ta) : ta.localeCompare(tb);
  });
  return sorted.map((c) => ({ ...c, replies: sortTree(c.replies, mode) }));
}
function reorderByKids(tree, kids) {
  if (!kids || kids.length === 0) return tree;
  const rank = /* @__PURE__ */ new Map();
  kids.forEach((id, i) => rank.set(id, i));
  return [...tree].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}
var SINCE_UNITS = { h: 3600, d: 86400, w: 7 * 86400, m: 30 * 86400, y: 365 * 86400 };
function parseSince(since) {
  const m = /^(\d+)\s*([hdwmy])$/i.exec(since.trim());
  if (!m) {
    throw new UsageError(`Invalid --since value: "${since}"`, "Use a number plus unit: 1h, 24h, 7d, 2w, 30d, 1y");
  }
  return Number(m[1]) * SINCE_UNITS[m[2].toLowerCase()];
}
function parseDate(input, flag = "--after") {
  const trimmed = input.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new UsageError(`Invalid ${flag} date: "${input}"`, "Use YYYY-MM-DD, e.g. --after 2026-01-01");
  }
  return Math.floor(ms / 1e3);
}
function parseItemRef(ref) {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = /(?:[?&]id=|\/items\/|\/item\/)(\d+)/.exec(trimmed);
  if (m) return Number(m[1]);
  throw new UsageError(`Cannot parse item id from "${ref}"`, "Pass a numeric id or a URL like https://news.ycombinator.com/item?id=8863");
}
function splitList(raw) {
  if (raw === void 0) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts.flatMap((p) => p.split(",")).map((s) => s.trim()).filter(Boolean);
}
function matchKeywords(haystack, keywords) {
  const hay = haystack.toLowerCase();
  return keywords.filter((k) => hay.includes(k.toLowerCase()));
}
function nowSeconds() {
  return Math.floor(Date.now() / 1e3);
}

// src/query.ts
var SEARCH_TYPES = ["story", "ask", "show", "poll", "job", "comment", "all"];
function typeTags(type) {
  switch (type) {
    case "story":
      return ["story"];
    case "ask":
      return ["ask_hn"];
    case "show":
      return ["show_hn"];
    case "poll":
      return ["poll"];
    case "job":
      return ["job"];
    case "comment":
      return ["comment"];
    case "all":
      return [];
  }
}
function joinTags(parts) {
  return parts.length > 0 ? parts.join(",") : void 0;
}
function timeFilters(flags) {
  const filters = [];
  let after;
  let before;
  if (flags.after) after = parseDate(flags.after, "--after");
  else if (flags.since) after = nowSeconds() - parseSince(flags.since);
  if (flags.before) before = parseDate(flags.before, "--before");
  if (after !== void 0) filters.push(`created_at_i>=${after}`);
  if (before !== void 0) filters.push(`created_at_i<${before}`);
  return { filters, after, before };
}
function thresholdFilters(minPoints, minComments) {
  const filters = [];
  if (minPoints !== void 0 && minPoints > 0) filters.push(`points>=${Math.floor(minPoints)}`);
  if (minComments !== void 0 && minComments > 0) filters.push(`num_comments>=${Math.floor(minComments)}`);
  return filters;
}
function clamp(value, min, max, fallback) {
  const n = value === void 0 || Number.isNaN(value) ? fallback : value;
  return Math.min(Math.max(Math.floor(n), min), max);
}
var IN_ATTRIBUTES = {
  title: "title",
  url: "url",
  text: "story_text,comment_text"
};

// src/paginate.ts
var MIN_WINDOW_SECONDS = 60;
var DEFAULT_SPAN_SECONDS = 20 * 365 * 86400;
async function searchAll(client, base, opts) {
  const seen = /* @__PURE__ */ new Map();
  let pagesFetched = 0;
  let windows = 0;
  let capped = false;
  let nbHitsTotal = 0;
  const baseFilters = (base.numericFilters ?? []).filter((f) => !f.startsWith("created_at_i"));
  const fetchWindow = async (lo, hi, depth) => {
    if (pagesFetched >= opts.maxPages) {
      capped = true;
      return;
    }
    const filters = [...baseFilters];
    if (lo !== void 0) filters.push(`created_at_i>=${lo}`);
    if (hi !== void 0) filters.push(`created_at_i<${hi}`);
    const first = await client.search({ ...base, numericFilters: filters, hitsPerPage: opts.hitsPerPage, page: 0 });
    pagesFetched++;
    windows++;
    if (first.nbHits > ALGOLIA_MAX_HITS) {
      const start = lo ?? nowSeconds() - DEFAULT_SPAN_SECONDS;
      const end = hi ?? nowSeconds() + 60;
      if (depth < 30 && end - start > MIN_WINDOW_SECONDS) {
        const mid = Math.floor((start + end) / 2);
        await fetchWindow(mid, end, depth + 1);
        await fetchWindow(start, mid, depth + 1);
        return;
      }
      capped = true;
    }
    nbHitsTotal += first.nbHits;
    for (const hit of first.hits) seen.set(Number(hit.objectID), hit);
    const totalPages = Math.min(first.nbPages, Math.ceil(ALGOLIA_MAX_HITS / opts.hitsPerPage));
    for (let page = 1; page < totalPages; page++) {
      if (pagesFetched >= opts.maxPages) {
        capped = true;
        return;
      }
      if (opts.paceMs > 0) await sleep(opts.paceMs);
      const res = await client.search({ ...base, numericFilters: filters, hitsPerPage: opts.hitsPerPage, page });
      pagesFetched++;
      for (const hit of res.hits) seen.set(Number(hit.objectID), hit);
      if (res.hits.length === 0) break;
    }
  };
  await fetchWindow(opts.after, opts.before, 0);
  const hits = [...seen.values()];
  if (base.sort === "date") hits.sort((a, b) => (b.created_at_i ?? 0) - (a.created_at_i ?? 0));
  else hits.sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
  return { hits, nb_hits: nbHitsTotal, pages_fetched: pagesFetched, windows, capped };
}

// src/commands/search.ts
function hitToEntry(hit) {
  return typeFromTags(hit._tags) === "comment" ? commentFromHit(hit) : fromAlgoliaHit(hit);
}
var CAP_NOTE = "Algolia caps every query at 1,000 hits (nb_pages reflects the cap). Narrow with --since/--after/--before, or use --all to slice by date automatically.";
function normalizeDomain(input) {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").split("/")[0].split("?")[0];
  return d.replace(/^www\./, "");
}
function registerSearchCommands(yargs2) {
  return yargs2.command(
    "search",
    "Full-text search over stories and comments (Algolia)",
    (y) => y.option("q", { type: "string", alias: "query", describe: "Search text (optional when filtering by --author / --since / --min-points)" }).option("type", { type: "string", choices: SEARCH_TYPES, default: "story", describe: "Item type" }).option("comments", { type: "boolean", default: false, describe: "Shorthand for --type comment" }).option("sort", {
      type: "string",
      choices: ["relevance", "date"],
      default: "relevance",
      describe: "relevance = Algolia ranking weighted by points; date = newest first"
    }).option("since", { type: "string", describe: "Relative window: 1h, 24h, 7d, 2w, 30d, 1y" }).option("after", { type: "string", describe: "Created on/after YYYY-MM-DD (UTC); overrides --since" }).option("before", { type: "string", describe: "Created before YYYY-MM-DD (UTC)" }).option("min-points", { type: "number", describe: "Minimum points" }).option("min-comments", { type: "number", describe: "Minimum comment count" }).option("author", { type: "string", describe: "Only items by this username" }).option("in", { type: "string", choices: ["title", "url", "text"], describe: "Match only this field" }).option("limit", { type: "number", default: 20, describe: "Hits per page (max 1000)" }).option("page", { type: "number", default: 1, describe: "Page number, 1-based" }).option("all", { type: "boolean", default: false, describe: "Fetch every page up to --max-pages; slices by date past the 1,000-hit cap" }).option("max-pages", { type: "number", default: 10, describe: "Request budget for --all" }).check((argv) => {
      if (!argv.q && !argv.author && !argv.since && !argv.after && !argv.before && argv.minPoints === void 0) {
        throw new UsageError("Nothing to search for.", 'Give a query (hn search -q "claude code") or a filter (hn search --since 7d --min-points 100)');
      }
      return true;
    }).example('hn search -q "claude code" --since 30d --min-points 50', "Popular recent stories about a topic").example('hn search -q "rate limit" --comments --since 7d --limit 50', "What commenters said this week").example("hn search --since 7d --min-points 200 --sort date", "Big stories this week, no text query").example('hn search -q "postgres" --type ask --after 2026-01-01 --before 2026-07-01', "Ask HN posts in a date range").example('hn search -q "sqlite" --all --max-pages 20 --sort date', "Deep pull, auto-sliced past the 1,000-hit cap"),
    async (argv) => {
      const ctx = createContext();
      const type = argv.comments ? "comment" : argv.type;
      const tags = [...typeTags(type)];
      if (argv.author) tags.push(`author_${argv.author}`);
      const time = timeFilters({ since: argv.since, after: argv.after, before: argv.before });
      const filters = [...time.filters, ...thresholdFilters(argv.minPoints, argv.minComments)];
      const sort = argv.sort;
      const limit = clamp(argv.limit, 1, 1e3, 20);
      const page = clamp(argv.page, 1, 1e5, 1);
      const base = {
        query: argv.q,
        tags: joinTags(tags),
        numericFilters: filters,
        restrictSearchableAttributes: argv.in ? IN_ATTRIBUTES[argv.in] : void 0,
        sort
      };
      if (argv.all) {
        const maxPages = clamp(argv.maxPages, 1, 1e3, 10);
        const result = await searchAll(ctx.algolia, base, {
          maxPages,
          hitsPerPage: limit,
          after: time.after,
          before: time.before,
          paceMs: ctx.settings.paceMs
        });
        const items2 = result.hits.map(hitToEntry);
        output(
          {
            query: base.query ?? null,
            type,
            sort,
            items: items2,
            count: items2.length,
            nb_hits: result.nb_hits,
            pages_fetched: result.pages_fetched,
            windows: result.windows,
            capped: result.capped,
            _meta: buildMeta(ctx, result.capped ? `Stopped at --max-pages ${maxPages}; raise it to pull more.` : void 0)
          },
          argv.pretty
        );
        return;
      }
      const res = await ctx.algolia.search({ ...base, hitsPerPage: limit, page: page - 1 });
      const items = res.hits.map(hitToEntry);
      output(
        {
          query: base.query ?? null,
          type,
          sort,
          items,
          count: items.length,
          page,
          nb_hits: res.nbHits,
          nb_pages: res.nbPages,
          _meta: buildMeta(ctx, res.nbHits > 1e3 ? CAP_NOTE : void 0)
        },
        argv.pretty
      );
    }
  ).command(
    "domain <domain>",
    "Everything HN has submitted from a site (matches the submitted URL)",
    (y) => y.positional("domain", { type: "string", demandOption: true, describe: "e.g. anthropic.com (scheme/path ignored)" }).option("since", { type: "string", describe: "Relative window: 7d, 30d, 1y" }).option("after", { type: "string", describe: "Created on/after YYYY-MM-DD (UTC)" }).option("before", { type: "string", describe: "Created before YYYY-MM-DD (UTC)" }).option("min-points", { type: "number", describe: "Minimum points" }).option("sort", {
      type: "string",
      choices: ["points", "date"],
      default: "points",
      describe: "points = most upvoted first; date = newest first"
    }).option("limit", { type: "number", default: 30, describe: "Hits per page (max 1000)" }).option("page", { type: "number", default: 1, describe: "Page number, 1-based" }).example("hn domain anthropic.com", "Most upvoted submissions from a site").example("hn domain github.com/simonw --since 1y --sort date", "Path is ignored; newest first").example("hn domain example.com | jq '.items[] | {title, points, num_comments, hn_url}'", "Trim to the useful fields"),
    async (argv) => {
      const ctx = createContext();
      const domain = normalizeDomain(argv.domain);
      if (!domain) throw new UsageError("Empty domain.", "Example: hn domain anthropic.com");
      const time = timeFilters({ since: argv.since, after: argv.after, before: argv.before });
      const filters = [...time.filters, ...thresholdFilters(argv.minPoints)];
      const limit = clamp(argv.limit, 1, 1e3, 30);
      const page = clamp(argv.page, 1, 1e5, 1);
      const res = await ctx.algolia.search({
        query: domain,
        restrictSearchableAttributes: "url",
        tags: "story",
        numericFilters: filters,
        sort: argv.sort === "date" ? "date" : "relevance",
        hitsPerPage: limit,
        page: page - 1
      });
      const items = res.hits.map(fromAlgoliaHit).filter((item) => item.domain !== null && (item.domain === domain || item.domain.endsWith(`.${domain}`)));
      output(
        {
          domain,
          items,
          count: items.length,
          page,
          nb_hits: res.nbHits,
          nb_pages: res.nbPages,
          _meta: buildMeta(ctx, "nb_hits counts URL text matches before the exact-domain filter; count is what survived.")
        },
        argv.pretty
      );
    }
  );
}

// src/commands/digest.ts
function registerDigestCommands(yargs2) {
  return yargs2.command(
    "digest",
    "Scan several keywords in one call \u2014 one ranked bucket per keyword",
    (y) => y.option("keywords", { type: "string", demandOption: true, describe: "Comma-separated keywords or phrases" }).option("type", { type: "string", choices: SEARCH_TYPES, default: "story", describe: "Item type" }).option("since", { type: "string", default: "7d", describe: "Relative window: 24h, 7d, 30d" }).option("after", { type: "string", describe: "Created on/after YYYY-MM-DD (UTC); overrides --since" }).option("before", { type: "string", describe: "Created before YYYY-MM-DD (UTC)" }).option("min-points", { type: "number", default: 0, describe: "Minimum points" }).option("sort", { type: "string", choices: ["relevance", "date"], default: "relevance" }).option("in", { type: "string", choices: ["title", "url", "text"], describe: "Match only this field" }).option("limit", { type: "number", default: 50, describe: "Hits per keyword (max 1000)" }).example('hn digest --keywords "claude code,cursor,codex" --since 7d --min-points 20', "Compare three products this week").example('hn digest --keywords "postgres,sqlite" --type comment --since 30d', "What commenters say").example(`hn digest --keywords "a,b" | jq '.buckets[] | {keyword, count}'`, "Just the counts"),
    async (argv) => {
      const ctx = createContext();
      const keywords = splitList(argv.keywords);
      if (keywords.length === 0) throw new UsageError("No keywords given.", 'Example: hn digest --keywords "claude code,cursor" --since 7d');
      const type = argv.type;
      const time = timeFilters({ since: argv.since, after: argv.after, before: argv.before });
      const filters = [...time.filters, ...thresholdFilters(argv.minPoints)];
      const limit = clamp(argv.limit, 1, 1e3, 50);
      const sort = argv.sort;
      const seen = /* @__PURE__ */ new Set();
      const buckets = [];
      for (const [i, keyword] of keywords.entries()) {
        if (i > 0 && ctx.settings.paceMs > 0) await sleep(ctx.settings.paceMs);
        const res = await ctx.algolia.search({
          query: keyword,
          tags: joinTags(typeTags(type)),
          numericFilters: filters,
          restrictSearchableAttributes: argv.in ? IN_ATTRIBUTES[argv.in] : void 0,
          sort,
          hitsPerPage: limit
        });
        const items = res.hits.map(hitToEntry);
        for (const item of items) seen.add(item.id);
        buckets.push({ keyword, nb_hits: res.nbHits, count: items.length, items });
      }
      output(
        {
          query_time: (/* @__PURE__ */ new Date()).toISOString(),
          type,
          since: argv.after ? null : argv.since,
          sort,
          keywords,
          buckets,
          unique_count: seen.size,
          _meta: buildMeta(ctx)
        },
        argv.pretty
      );
    }
  );
}

// src/commands/feed.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync, unlinkSync, writeFileSync as writeFileSync2 } from "fs";
import { join as join2 } from "path";
var NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
function feedPath(name) {
  return join2(feedsDir(), `${name}.json`);
}
function assertName(name) {
  if (!NAME_RE.test(name)) throw new UsageError(`Invalid feed name "${name}"`, "Use letters, digits, dots, dashes, underscores (max 64 chars).");
}
function loadFeed(name) {
  const p = feedPath(name);
  if (!existsSync2(p)) return null;
  try {
    return JSON.parse(readFileSync2(p, "utf-8"));
  } catch {
    return null;
  }
}
function saveFeed(feed) {
  const dir = feedsDir();
  if (!existsSync2(dir)) mkdirSync2(dir, { recursive: true });
  writeFileSync2(feedPath(feed.name), JSON.stringify(feed, null, 2) + "\n");
}
function points(entry) {
  return "points" in entry && typeof entry.points === "number" ? entry.points : 0;
}
function registerFeedCommands(yargs2) {
  return yargs2.command(
    "feed",
    "Persistent keyword feeds \u2014 idempotent re-runs return only unseen items",
    (y) => y.command(
      "create <name>",
      "Create a named feed",
      (y2) => y2.positional("name", { type: "string", demandOption: true, describe: "Feed name (filesystem-safe)" }).option("keywords", { type: "string", demandOption: true, describe: "Comma-separated keywords or phrases" }).option("type", { type: "string", choices: SEARCH_TYPES, default: "story", describe: "Item type" }).option("since", { type: "string", default: "7d", describe: "Look-back window per run: 24h, 7d, 30d" }).option("min-points", { type: "number", default: 0, describe: "Minimum points" }).option("limit", { type: "number", default: 50, describe: "Hits per keyword per run (max 1000)" }).example('hn feed create brand --keywords "acme,acme.com" --type all --since 7d', "Track brand mentions in stories and comments").example('hn feed create ai-agents --keywords "ai agents,agentic" --min-points 20', "Popular stories only"),
      async (argv) => {
        const name = argv.name;
        assertName(name);
        if (loadFeed(name)) throw new UsageError(`Feed "${name}" already exists.`, `Run it: hn feed run ${name} \u2014 or delete it: hn feed delete ${name} --yes`);
        const keywords = splitList(argv.keywords);
        if (keywords.length === 0) throw new UsageError("No keywords given.", 'Example: --keywords "acme,acme.com"');
        parseSince(argv.since);
        const feed = {
          name,
          keywords,
          type: argv.type,
          since: argv.since,
          min_points: argv.minPoints ?? 0,
          limit: clamp(argv.limit, 1, 1e3, 50),
          created_at: (/* @__PURE__ */ new Date()).toISOString(),
          last_run_at: null,
          seen_ids: []
        };
        saveFeed(feed);
        output({ created: true, feed, path: feedPath(name) }, argv.pretty);
      }
    ).command(
      "list",
      "List saved feeds",
      (y2) => y2.example("hn feed list", "Show all feeds"),
      async (argv) => {
        const dir = feedsDir();
        const feeds = existsSync2(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => loadFeed(f.replace(/\.json$/, ""))).filter((f) => f !== null).map((f) => ({ ...f, seen_count: f.seen_ids.length, seen_ids: void 0 })) : [];
        output({ feeds, count: feeds.length, dir }, argv.pretty);
      }
    ).command(
      "run <name>",
      "Fetch matches and return only items not seen on previous runs",
      (y2) => y2.positional("name", { type: "string", demandOption: true }).option("dry-run", { type: "boolean", default: false, describe: "Preview without marking items as seen" }).example("hn feed run brand", "New matches since the last run").example("hn feed run brand --dry-run", "Preview, nothing marked seen"),
      async (argv) => {
        const name = argv.name;
        const feed = loadFeed(name);
        if (!feed) throw new NotFoundError(`Feed not found: ${name}`, 'List feeds: hn feed list \u2014 create one: hn feed create <name> --keywords "..."');
        const ctx = createContext();
        const seen = new Set(feed.seen_ids);
        const fresh = /* @__PURE__ */ new Map();
        const filters = [`created_at_i>=${nowSeconds() - parseSince(feed.since)}`, ...thresholdFilters(feed.min_points)];
        for (const [i, keyword] of feed.keywords.entries()) {
          if (i > 0 && ctx.settings.paceMs > 0) await sleep(ctx.settings.paceMs);
          const res = await ctx.algolia.search({
            query: keyword,
            tags: joinTags(typeTags(feed.type)),
            numericFilters: filters,
            sort: "date",
            hitsPerPage: feed.limit
          });
          for (const hit of res.hits) {
            const entry = hitToEntry(hit);
            if (!seen.has(entry.id) && !fresh.has(entry.id)) fresh.set(entry.id, entry);
          }
        }
        const newItems = [...fresh.values()].sort((a, b) => points(b) - points(a));
        if (!argv.dryRun) {
          feed.seen_ids = [...seen, ...newItems.map((i) => i.id)].slice(-5e3);
          feed.last_run_at = (/* @__PURE__ */ new Date()).toISOString();
          saveFeed(feed);
        }
        output(
          {
            feed: feed.name,
            dry_run: argv.dryRun,
            new_items: newItems,
            count: newItems.length,
            last_run_at: feed.last_run_at,
            seen_count: feed.seen_ids.length,
            _meta: buildMeta(ctx)
          },
          argv.pretty
        );
      }
    ).command(
      "delete <name>",
      "Delete a feed (requires --yes)",
      (y2) => y2.positional("name", { type: "string", demandOption: true }).option("yes", { type: "boolean", default: false, describe: "Confirm deletion" }).example("hn feed delete brand --yes", "Delete without prompting"),
      async (argv) => {
        const name = argv.name;
        if (!argv.yes) throw new UsageError(`Refusing to delete feed "${name}" without --yes.`, `Run: hn feed delete ${name} --yes`);
        const p = feedPath(name);
        if (!existsSync2(p)) throw new NotFoundError(`Feed not found: ${name}`, "List feeds: hn feed list");
        unlinkSync(p);
        output({ deleted: true, feed: name }, argv.pretty);
      }
    ).demandCommand(1, 'Specify a subcommand: create, list, run, delete\n\n  Example: hn feed create brand --keywords "acme"')
  );
}

// src/hydrate.ts
async function hydrateIds(ctx, ids, opts = {}) {
  const offset = opts.rankOffset ?? 0;
  if (ids.length === 0) return [];
  if (opts.live) {
    const raws = await ctx.firebase.items(ids);
    const items = raws.map((raw, i) => raw && !raw.deleted ? { ...fromFirebaseItem(raw), rank: offset + i + 1 } : null);
    return items.filter((x) => x !== null);
  }
  const hits = await ctx.algolia.hydrate(ids);
  const missing = ids.filter((id) => !hits.has(id));
  const fallback = /* @__PURE__ */ new Map();
  if (missing.length > 0) {
    const raws = await ctx.firebase.items(missing);
    for (const raw of raws) if (raw && !raw.deleted) fallback.set(raw.id, fromFirebaseItem(raw));
  }
  const out = [];
  ids.forEach((id, i) => {
    const hit = hits.get(id);
    const item = hit ? fromAlgoliaHit(hit) : fallback.get(id);
    if (item) out.push({ ...item, rank: offset + i + 1 });
  });
  return out;
}

// src/commands/feeds.ts
var FEEDS = [
  { kind: "top", describe: "Front page \u2014 top stories in HN rank order (rank 1-30 is the front page)", max: 500, hasJobs: true },
  { kind: "new", describe: "Newest submissions", max: 500, hasJobs: true },
  { kind: "best", describe: "Best recent stories by votes", max: 500, hasJobs: false },
  { kind: "ask", describe: "Ask HN, ranked", max: 200, hasJobs: false },
  { kind: "show", describe: "Show HN, ranked", max: 200, hasJobs: false },
  { kind: "jobs", describe: "Job postings (YC companies)", max: 200, hasJobs: false, liveOnly: true }
];
var HYDRATE_NOTE = "points/num_comments come from the Algolia index (lags live values by a minute or so); add --live for real-time numbers.";
function registerRankedFeedCommands(yargs2) {
  for (const feed of FEEDS) {
    yargs2 = yargs2.command(
      feed.kind,
      feed.describe,
      (y) => {
        let b = y.option("limit", { type: "number", default: 30, describe: `Items per page (max ${feed.max})` }).option("page", { type: "number", default: 1, describe: "Page number, 1-based" }).option("live", {
          type: "boolean",
          default: false,
          describe: "Hydrate every item from Firebase (real-time scores; one request per item instead of one per page)"
        });
        if (feed.hasJobs) {
          b = b.option("jobs", { type: "boolean", default: true, describe: "Include job postings (use --no-jobs to drop them)" });
        }
        return b.example(`hn ${feed.kind}`, `First ${feed.kind} page, 30 items, 1-2 requests`).example(`hn ${feed.kind} --limit 50 --page 2`, "Items 51-100").example(`hn ${feed.kind} --live | jq '.items[] | {rank, title, points}'`, "Real-time numbers, trimmed with jq");
      },
      async (argv) => {
        const ctx = createContext();
        const limit = clamp(argv.limit, 1, feed.max, 30);
        const page = clamp(argv.page, 1, 1e3, 1);
        const ids = await ctx.firebase.list(feed.kind);
        const start = (page - 1) * limit;
        const slice = ids.slice(start, start + limit);
        const live = argv.live || feed.liveOnly === true;
        let items = await hydrateIds(ctx, slice, { live, rankOffset: start });
        if (feed.hasJobs && argv.jobs === false) items = items.filter((i) => i.type !== "job");
        output(
          {
            feed: feed.kind,
            items,
            count: items.length,
            page,
            total_available: ids.length,
            _meta: buildMeta(ctx, live ? void 0 : HYDRATE_NOTE)
          },
          argv.pretty
        );
      }
    );
  }
  return yargs2;
}

// src/commands/hiring.ts
var KINDS = {
  hiring: /who is hiring/i,
  "wants-to-be-hired": /who wants to be hired/i,
  freelancer: /freelancer/i
};
var MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function monthFromTitle(title) {
  const m = /\(([A-Za-z]+)\s+(\d{4})\)/.exec(title ?? "");
  if (!m) return null;
  const idx = MONTHS.indexOf(m[1].toLowerCase());
  if (idx < 0) return null;
  return `${m[2]}-${String(idx + 1).padStart(2, "0")}`;
}
function registerHiringCommands(yargs2) {
  return yargs2.command(
    "hiring",
    'Read the monthly "Who is hiring?" threads (jobs, job seekers, freelancers)',
    (y) => y.option("kind", { type: "string", choices: Object.keys(KINDS), default: "hiring", describe: "Which monthly thread" }).option("month", { type: "string", describe: "YYYY-MM; default = latest thread" }).option("keywords", { type: "string", describe: "Comma-separated, case-insensitive filter over each post" }).option("match", { type: "string", choices: ["any", "all"], default: "any", describe: "A post must contain any / all keywords" }).option("limit", { type: "number", default: 100, describe: "Max posts returned; 0 = all" }).option("list", { type: "boolean", default: false, describe: "List available threads instead of reading one" }).example('hn hiring --keywords "remote,typescript"', "Remote TypeScript jobs in the latest thread").example('hn hiring --kind wants-to-be-hired --keywords "rails,senior" --match all', "Candidates matching all keywords").example('hn hiring --month 2026-07 --keywords "ai" --limit 0', "Every AI post from July 2026").example("hn hiring --list", "Which months are available"),
    async (argv) => {
      const ctx = createContext();
      const kind = argv.kind;
      const res = await ctx.algolia.search({ tags: "story,author_whoishiring", sort: "date", hitsPerPage: 120 });
      const threads = res.hits.filter((h) => KINDS[kind].test(h.title ?? "")).map((h) => ({ ...fromAlgoliaHit(h), month: monthFromTitle(h.title) }));
      if (argv.list) {
        output({ kind, threads, count: threads.length, _meta: buildMeta(ctx) }, argv.pretty);
        return;
      }
      const month = argv.month;
      const thread = month ? threads.find((t) => t.month === month) : threads[0];
      if (!thread) {
        throw new NotFoundError(`No "${kind}" thread found${month ? ` for ${month}` : ""}`, "Run `hn hiring --list` to see the available months.");
      }
      const node = await ctx.algolia.item(thread.id);
      const topLevel = treeFromAlgolia(node?.children ?? [], 0, 1);
      const keywords = splitList(argv.keywords);
      let posts = topLevel.filter((c) => c.text && c.text.trim().length > 0);
      if (keywords.length > 0) {
        posts = posts.filter((c) => {
          const hits = matchKeywords(c.text, keywords);
          return argv.match === "all" ? hits.length === keywords.length : hits.length > 0;
        });
      }
      const matched = posts.length;
      const limit = clamp(argv.limit, 0, 1e5, 100);
      if (limit > 0) posts = posts.slice(0, limit);
      const items = posts.map((c) => ({
        ...c,
        replies: [],
        matched_keywords: keywords.length > 0 ? matchKeywords(c.text, keywords) : void 0
      }));
      output(
        {
          kind,
          thread: {
            id: thread.id,
            title: thread.title,
            month: thread.month,
            created_at: thread.created_at,
            hn_url: thread.hn_url,
            top_level_posts: topLevel.length
          },
          keywords,
          match: argv.match,
          matched_count: matched,
          count: items.length,
          items,
          _meta: buildMeta(ctx)
        },
        argv.pretty
      );
    }
  );
}

// src/commands/item.ts
function registerItemCommands(yargs2) {
  return yargs2.command(
    "item",
    "One item straight from the official API (live, any type)",
    (y) => y.command(
      "get <id>",
      "Live record for a story, comment, job, or poll \u2014 real-time score, kids, parent",
      (y2) => y2.positional("id", { type: "string", demandOption: true, describe: "Item id or news.ycombinator.com URL" }).option("raw", { type: "boolean", default: false, describe: "Also include the untouched Firebase JSON" }).example("hn item get 8863", "Live story record").example("hn item get 9224 --raw", "A comment, with the raw payload"),
      async (argv) => {
        const ctx = createContext();
        const id = parseItemRef(argv.id);
        const raw = await ctx.firebase.item(id);
        if (!raw) {
          throw new NotFoundError(`Item ${id} does not exist`, "Firebase returned null \u2014 the id is above maxitem or was never created. `hn status` shows the current maxitem.");
        }
        const item = {
          ...fromFirebaseItem(raw),
          kids: raw.kids ?? [],
          parent: raw.parent ?? null,
          poll: raw.poll ?? null,
          parts: raw.parts ?? []
        };
        output({ item, raw: argv.raw ? raw : void 0, _meta: buildMeta(ctx) }, argv.pretty);
      }
    ).demandCommand(1, "Specify a subcommand: get\n\n  Example: hn item get 8863")
  );
}

// src/commands/launches.ts
var LAUNCH_RE = /^Launch HN:\s*(.+?)\s*\(\s*YC\s+([A-Z]+\s?\d{2})\s*\)\s*(?:[–—:-]\s*)?(.*)$/i;
function parseLaunchTitle(title) {
  const m = LAUNCH_RE.exec(title ?? "");
  if (!m) return null;
  return { company: m[1].trim(), batch: m[2].replace(/\s+/g, "").toUpperCase(), tagline: m[3]?.trim() || null };
}
function registerLaunchCommands(yargs2) {
  return yargs2.command(
    "launches",
    '"Launch HN" posts \u2014 YC startups launching on Hacker News',
    (y) => y.option("since", { type: "string", default: "30d", describe: "Relative window: 7d, 30d, 1y" }).option("after", { type: "string", describe: "Created on/after YYYY-MM-DD (UTC); overrides --since" }).option("before", { type: "string", describe: "Created before YYYY-MM-DD (UTC)" }).option("batch", { type: "string", describe: "YC batch filter, e.g. S26, W26, F25" }).option("min-points", { type: "number", describe: "Minimum points" }).option("sort", { type: "string", choices: ["date", "points"], default: "date", describe: "date = newest first; points = most upvoted first" }).option("limit", { type: "number", default: 50, describe: "Hits per page (max 1000)" }).option("page", { type: "number", default: 1, describe: "Page number, 1-based" }).example("hn launches", "Launches in the last 30 days").example("hn launches --since 1y --batch S26 --sort points", "Best-received S26 launches").example(`hn launches | jq -r '.items[] | "\\(.company) \u2014 \\(.tagline) [\\(.points)]"'`, "One line per launch"),
    async (argv) => {
      const ctx = createContext();
      const time = timeFilters({ since: argv.since, after: argv.after, before: argv.before });
      const limit = clamp(argv.limit, 1, 1e3, 50);
      const page = clamp(argv.page, 1, 1e5, 1);
      const batch = argv.batch ? argv.batch.replace(/\s+/g, "").toUpperCase() : void 0;
      const res = await ctx.algolia.search({
        // The batch token in the query makes Algolia rank that batch first; the exact filter below does the rest.
        query: batch ? `Launch HN ${batch}` : "Launch HN",
        restrictSearchableAttributes: "title",
        tags: "story",
        numericFilters: [...time.filters, ...thresholdFilters(argv.minPoints)],
        sort: argv.sort === "points" ? "relevance" : "date",
        hitsPerPage: limit,
        page: page - 1
      });
      const items = res.hits.map((hit) => {
        const item = fromAlgoliaHit(hit);
        const parts = parseLaunchTitle(item.title);
        return parts ? { ...item, ...parts } : null;
      }).filter((x) => x !== null).filter((x) => !batch || x.batch === batch);
      output(
        {
          since: argv.after ? null : argv.since,
          batch: batch ?? null,
          items,
          count: items.length,
          page,
          nb_hits: res.nbHits,
          nb_pages: res.nbPages,
          _meta: buildMeta(ctx, 'nb_hits counts title matches for "Launch HN" before parsing; count is what parsed as a launch.')
        },
        argv.pretty
      );
    }
  );
}

// src/skill-install.ts
import { cpSync, existsSync as existsSync3, lstatSync, mkdirSync as mkdirSync3, readFileSync as readFileSync3, realpathSync, rmSync, symlinkSync, writeFileSync as writeFileSync3 } from "fs";
import { homedir as homedir2 } from "os";
import { dirname, join as join3 } from "path";
import { fileURLToPath } from "url";
var SKILL_NAME = "hn-hackernews-research";
var TARGETS = ["claude", "codex", "pi", "agents"];
var TARGET_LABELS = {
  claude: "Claude Code (~/.claude/skills)",
  codex: "Codex CLI ($CODEX_HOME/skills, default ~/.codex/skills)",
  pi: "pi coding agent (~/.pi/agent/skills)",
  agents: "Cross-harness Agent Skills dir (~/.agents/skills \u2014 read by Codex and pi)"
};
function targetDir(target) {
  switch (target) {
    case "claude":
      return join3(homedir2(), ".claude", "skills");
    case "codex":
      return join3(process.env.CODEX_HOME ?? join3(homedir2(), ".codex"), "skills");
    case "pi":
      return join3(homedir2(), ".pi", "agent", "skills");
    case "agents":
      return join3(homedir2(), ".agents", "skills");
  }
}
function packageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync3(join3(dir, "package.json")) && existsSync3(join3(dir, "skills", SKILL_NAME, "SKILL.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError("Cannot locate the bundled skill directory.", "Reinstall: `npm install -g github:nachoal/hn`, or run ./install_global.sh from a clone.");
}
function skillSourceDir() {
  return join3(packageRoot(), "skills", SKILL_NAME);
}
var FLAG_LINE = /^disable-model-invocation:.*\r?\n/m;
function stripSlashOnly(skillMd) {
  return skillMd.replace(FLAG_LINE, "");
}
function hasSlashOnlyFlag(skillMd) {
  return /^disable-model-invocation:\s*true\s*$/m.test(skillMd);
}
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function present(p) {
  return existsSync3(p) || isSymlink(p);
}
function sameRealPath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
function invokeHint(target, slashOnly) {
  switch (target) {
    case "claude":
      return slashOnly ? `/${SKILL_NAME} (slash-only; auto-trigger is off)` : `/${SKILL_NAME} or automatically when the task mentions Hacker News`;
    case "codex":
    case "agents":
      return `$${SKILL_NAME} or automatically`;
    case "pi":
      return slashOnly ? `/skill:${SKILL_NAME} (slash-only)` : `/skill:${SKILL_NAME} or automatically`;
  }
}
function installSkill(target, opts) {
  const src = skillSourceDir();
  const dest = join3(targetDir(target), SKILL_NAME);
  const sourceMd = readFileSync3(join3(src, "SKILL.md"), "utf-8");
  if (present(dest)) {
    if (opts.mode === "symlink" && isSymlink(dest) && sameRealPath(dest, src)) {
      const slashOnly2 = hasSlashOnlyFlag(sourceMd);
      return { target, path: dest, mode: "symlink", changed: false, slash_only: slashOnly2, invoke: invokeHint(target, slashOnly2), note: "already installed" };
    }
    if (!opts.force) {
      throw new ConfigError(`${dest} already exists.`, "Re-run with --force to replace it, or remove it first.");
    }
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync3(dirname(dest), { recursive: true });
  if (opts.mode === "symlink") {
    symlinkSync(src, dest, "dir");
    const slashOnly2 = hasSlashOnlyFlag(sourceMd);
    return { target, path: dest, mode: "symlink", changed: true, slash_only: slashOnly2, invoke: invokeHint(target, slashOnly2) };
  }
  cpSync(src, dest, { recursive: true });
  const md = join3(dest, "SKILL.md");
  const content = opts.slashOnly ? sourceMd : stripSlashOnly(sourceMd);
  writeFileSync3(md, content);
  const slashOnly = hasSlashOnlyFlag(content);
  return { target, path: dest, mode: "copy", changed: true, slash_only: slashOnly, invoke: invokeHint(target, slashOnly) };
}
function skillStatus(target) {
  const src = skillSourceDir();
  const dest = join3(targetDir(target), SKILL_NAME);
  if (!present(dest)) return { target, path: dest, installed: false, mode: null, up_to_date: null, slash_only: null };
  if (isSymlink(dest)) {
    const ok = sameRealPath(dest, src);
    let slashOnly = null;
    try {
      slashOnly = hasSlashOnlyFlag(readFileSync3(join3(dest, "SKILL.md"), "utf-8"));
    } catch {
      slashOnly = null;
    }
    return { target, path: dest, installed: true, mode: "symlink", up_to_date: ok, slash_only: slashOnly };
  }
  let installedMd = "";
  try {
    installedMd = readFileSync3(join3(dest, "SKILL.md"), "utf-8");
  } catch {
    return { target, path: dest, installed: true, mode: "copy", up_to_date: false, slash_only: null };
  }
  const sourceMd = readFileSync3(join3(src, "SKILL.md"), "utf-8");
  return {
    target,
    path: dest,
    installed: true,
    mode: "copy",
    up_to_date: stripSlashOnly(installedMd) === stripSlashOnly(sourceMd),
    slash_only: hasSlashOnlyFlag(installedMd)
  };
}

// src/commands/skill.ts
function registerSkillCommands(yargs2) {
  return yargs2.command(
    "skill",
    `Install the bundled "${SKILL_NAME}" skill into Claude Code, Codex, or pi`,
    (y) => y.command(
      "install",
      "Install the skill (symlink for Claude Code, adapted copies for Codex / pi)",
      (y2) => y2.option("claude", { type: "boolean", default: false, describe: TARGET_LABELS.claude }).option("codex", { type: "boolean", default: false, describe: TARGET_LABELS.codex }).option("pi", { type: "boolean", default: false, describe: TARGET_LABELS.pi }).option("agents", { type: "boolean", default: false, describe: TARGET_LABELS.agents }).option("all", { type: "boolean", default: false, describe: "Claude Code + Codex + pi" }).option("copy", { type: "boolean", default: false, describe: "Claude Code: copy instead of symlinking" }).option("auto", {
        type: "boolean",
        default: false,
        describe: "Claude Code: let Claude trigger the skill automatically (copies without `disable-model-invocation`)"
      }).option("force", { type: "boolean", default: false, describe: "Replace an existing install" }).example("hn skill install --all", "Claude Code (symlink, slash-only) + Codex + pi (copies, auto-trigger)").example("hn skill install --claude --auto", "Claude Code with automatic triggering").example("hn skill install --codex --force", "Refresh the Codex copy after an update"),
      async (argv) => {
        const targets = [];
        if (argv.all) targets.push("claude", "codex", "pi");
        for (const t of TARGETS) if (argv[t] && !targets.includes(t)) targets.push(t);
        if (targets.length === 0) {
          throw new UsageError("No target selected.", "Pass --claude, --codex, --pi, --agents, or --all. Example: hn skill install --all");
        }
        const results = [];
        for (const target of targets) {
          const claudeCopy = target === "claude" && (argv.copy || argv.auto);
          const mode = target === "claude" && !claudeCopy ? "symlink" : "copy";
          const slashOnly = target === "claude" && !argv.auto;
          results.push(installSkill(target, { mode, slashOnly, force: argv.force }));
        }
        output({ skill: SKILL_NAME, source: skillSourceDir(), installed: results }, argv.pretty);
      }
    ).command(
      "status",
      "Where the skill is installed and whether the copies are current",
      (y2) => y2.example("hn skill status", "Check all harnesses"),
      async (argv) => {
        output({ skill: SKILL_NAME, source: skillSourceDir(), targets: TARGETS.map(skillStatus) }, argv.pretty);
      }
    ).command(
      "path",
      "Print the bundled skill directory (for manual symlinks)",
      (y2) => y2.example('ln -s "$(hn skill path)" ~/.claude/skills/hn-hackernews-research', "Manual install"),
      async () => {
        process.stdout.write(skillSourceDir() + "\n");
      }
    ).demandCommand(1, "Specify a subcommand: install, status, path\n\n  Example: hn skill install --all")
  );
}

// src/commands/status.ts
async function timed(fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message };
  }
}
function registerStatusCommands(yargs2) {
  return yargs2.command(
    "status",
    "Check both upstream APIs: reachability, latency, current max item id",
    (y) => y.example("hn status", "Exit code 1 if either API is unreachable"),
    async (argv) => {
      const ctx = createContext();
      const [firebase, algolia] = await Promise.all([
        timed(() => ctx.firebase.maxitem()),
        timed(() => ctx.algolia.search({ tags: "story", hitsPerPage: 1 }))
      ]);
      const ok = firebase.ok && algolia.ok;
      output(
        {
          ok,
          version: VERSION,
          firebase: firebase.ok ? { ok: true, latency_ms: firebase.ms, maxitem: firebase.value } : { ok: false, latency_ms: firebase.ms, error: firebase.error },
          algolia: algolia.ok ? { ok: true, latency_ms: algolia.ms, indexed_stories: algolia.value.nbHits } : { ok: false, latency_ms: algolia.ms, error: algolia.error },
          config_dir: configDir(),
          _meta: buildMeta(ctx)
        },
        argv.pretty
      );
      if (!ok) process.exitCode = 1;
    }
  );
}

// src/commands/thread.ts
function storyFromNode(node) {
  const title = node.title ?? "";
  let type = "story";
  if (node.type === "poll") type = "poll";
  else if (node.type === "job") type = "job";
  else if (/^Ask HN\b/i.test(title)) type = "ask";
  else if (/^Show HN\b/i.test(title)) type = "show";
  return {
    id: node.id,
    type,
    title: node.title ?? null,
    url: node.url ?? null,
    domain: domainOf(node.url),
    author: node.author ?? null,
    points: node.points ?? null,
    num_comments: null,
    created_at: node.created_at ?? null,
    text: htmlToText(node.text),
    hn_url: hnUrl(node.id)
  };
}
function registerThreadCommands(yargs2) {
  return yargs2.command(
    "thread",
    "Story + full comment tree, or search inside one thread",
    (y) => y.command(
      "get <id>",
      "Fetch a story (or a comment subtree) with nested comments \u2014 one Algolia request",
      (y2) => y2.positional("id", { type: "string", demandOption: true, describe: "Item id or news.ycombinator.com URL" }).option("max-comments", { type: "number", default: 200, describe: "Cap on comments returned, level-order (top-level first); 0 = all" }).option("depth", { type: "number", default: 0, describe: "Max nesting depth; 0 = unlimited" }).option("sort", {
        type: "string",
        choices: ["top", "new", "old"],
        default: "top",
        describe: "top = HN's own ranking for top-level comments (one extra Firebase call); new/old = by time at every level"
      }).option("flat", { type: "boolean", default: false, describe: "Flat list with depth instead of nested replies" }).example("hn thread get 8863", "Story + top 200 comments in HN order").example("hn thread get https://news.ycombinator.com/item?id=8863 --max-comments 50 --flat", "Compact, summarizer-friendly").example(`hn thread get 8863 --depth 1 | jq -r '.comments[] | "\\(.author): \\(.text[0:200])"'`, "Top-level comments only"),
      async (argv) => {
        const ctx = createContext();
        const id = parseItemRef(argv.id);
        const wantLive = argv.sort === "top";
        const [node, live] = await Promise.all([ctx.algolia.item(id), wantLive ? ctx.firebase.item(id) : Promise.resolve(null)]);
        if (!node) {
          throw new NotFoundError(
            `Item ${id} is not in the HN search index`,
            "Deleted/dead items and items younger than ~1 minute are not indexed. `hn item get <id>` reads the live record."
          );
        }
        const maxDepth = clamp(argv.depth, 0, 100, 0);
        let tree = treeFromAlgolia(node.children ?? [], 0, maxDepth);
        if (argv.sort === "top") tree = reorderByKids(tree, live?.kids);
        else tree = sortTree(tree, argv.sort);
        const { comments, truncated, returned, total } = truncateLevelOrder(tree, clamp(argv.maxComments, 0, 1e5, 200));
        const finalComments = argv.flat ? flattenComments(comments) : comments;
        const payload = {};
        if (node.type === "comment") {
          const root = commentFromHit({
            objectID: String(node.id),
            author: node.author,
            comment_text: node.text,
            created_at: node.created_at,
            created_at_i: node.created_at_i,
            parent_id: node.parent_id,
            story_id: node.story_id
          });
          root.reply_count = (node.children ?? []).length;
          payload.comment = root;
        } else {
          const story = storyFromNode(node);
          if (live) {
            if (live.score !== void 0) story.points = live.score;
            if (live.descendants !== void 0) story.num_comments = live.descendants;
            if (live.dead) story.dead = true;
            if (live.deleted) story.deleted = true;
          }
          if (story.num_comments === null) story.num_comments = total;
          payload.story = story;
        }
        payload.comments = finalComments;
        payload.comment_count = total;
        payload.returned_count = returned;
        payload.truncated = truncated;
        payload._meta = buildMeta(ctx, truncated ? `Showing ${returned} of ${total} comments; raise --max-comments (0 = all).` : void 0);
        output(payload, argv.pretty);
      }
    ).command(
      "search <id>",
      "Search the comments of one story",
      (y2) => y2.positional("id", { type: "string", demandOption: true, describe: "Story id or URL" }).option("q", { type: "string", alias: "query", demandOption: true, describe: "Search text" }).option("sort", { type: "string", choices: ["relevance", "date"], default: "relevance" }).option("limit", { type: "number", default: 50, describe: "Hits per page (max 1000)" }).option("page", { type: "number", default: 1, describe: "Page number, 1-based" }).example('hn thread search 49156683 -q "remote"', "Comments mentioning a word inside one thread"),
      async (argv) => {
        const ctx = createContext();
        const id = parseItemRef(argv.id);
        const limit = clamp(argv.limit, 1, 1e3, 50);
        const page = clamp(argv.page, 1, 1e5, 1);
        const res = await ctx.algolia.search({
          query: argv.q,
          tags: `comment,story_${id}`,
          sort: argv.sort,
          hitsPerPage: limit,
          page: page - 1
        });
        const items = res.hits.map(commentFromHit);
        output(
          { story_id: id, query: argv.q, items, count: items.length, page, nb_hits: res.nbHits, nb_pages: res.nbPages, _meta: buildMeta(ctx) },
          argv.pretty
        );
      }
    ).demandCommand(1, "Specify a subcommand: get, search\n\n  Example: hn thread get 8863")
  );
}

// src/commands/user.ts
var POST_TYPES = ["story", "ask", "show", "poll", "job", "all"];
function registerUserCommands(yargs2) {
  return yargs2.command(
    "user",
    "HN users: profile, submissions, comments",
    (y) => y.command(
      "get <username>",
      "Profile: karma, about, account age, submission count (official API)",
      (y2) => y2.positional("username", { type: "string", demandOption: true, describe: "HN username (case-sensitive)" }).example("hn user get pg", "Profile for a user"),
      async (argv) => {
        const ctx = createContext();
        const name = argv.username.trim();
        const u = await ctx.firebase.user(name);
        if (!u) throw new NotFoundError(`No HN user "${name}"`, "Usernames are case-sensitive.");
        const submitted = u.submitted ?? [];
        output(
          {
            user: {
              id: u.id,
              karma: u.karma,
              created_at: new Date(u.created * 1e3).toISOString(),
              about: htmlToText(u.about ?? null),
              submitted_count: submitted.length,
              latest_submitted_ids: submitted.slice(0, 10),
              hn_url: `https://news.ycombinator.com/user?id=${encodeURIComponent(u.id)}`
            },
            _meta: buildMeta(ctx)
          },
          argv.pretty
        );
      }
    ).command(
      "posts <username>",
      "Stories / Ask / Show / polls submitted by a user",
      (y2) => y2.positional("username", { type: "string", demandOption: true }).option("type", { type: "string", choices: POST_TYPES, default: "story", describe: "Item type" }).option("since", { type: "string", describe: "Relative window: 7d, 30d, 1y" }).option("after", { type: "string", describe: "Created on/after YYYY-MM-DD (UTC)" }).option("before", { type: "string", describe: "Created before YYYY-MM-DD (UTC)" }).option("min-points", { type: "number", describe: "Minimum points" }).option("sort", { type: "string", choices: ["date", "points"], default: "date", describe: "date = newest first; points = most upvoted first" }).option("limit", { type: "number", default: 30, describe: "Hits per page (max 1000)" }).option("page", { type: "number", default: 1, describe: "Page number, 1-based" }).example("hn user posts pg --limit 50", "Latest 50 submissions").example("hn user posts dang --sort points --since 1y", "Top submissions of the last year"),
      async (argv) => {
        const ctx = createContext();
        const name = argv.username.trim();
        const tags = [...typeTags(argv.type), `author_${name}`];
        const time = timeFilters({ since: argv.since, after: argv.after, before: argv.before });
        const limit = clamp(argv.limit, 1, 1e3, 30);
        const page = clamp(argv.page, 1, 1e5, 1);
        const res = await ctx.algolia.search({
          tags: joinTags(tags),
          numericFilters: [...time.filters, ...thresholdFilters(argv.minPoints)],
          sort: argv.sort === "points" ? "relevance" : "date",
          hitsPerPage: limit,
          page: page - 1
        });
        const items = res.hits.map(fromAlgoliaHit);
        output({ username: name, items, count: items.length, page, nb_hits: res.nbHits, nb_pages: res.nbPages, _meta: buildMeta(ctx) }, argv.pretty);
      }
    ).command(
      "comments <username>",
      "Comments by a user, newest first",
      (y2) => y2.positional("username", { type: "string", demandOption: true }).option("q", { type: "string", alias: "query", describe: "Optional text filter" }).option("since", { type: "string", describe: "Relative window: 7d, 30d, 1y" }).option("after", { type: "string", describe: "Created on/after YYYY-MM-DD (UTC)" }).option("before", { type: "string", describe: "Created before YYYY-MM-DD (UTC)" }).option("limit", { type: "number", default: 50, describe: "Hits per page (max 1000)" }).option("page", { type: "number", default: 1, describe: "Page number, 1-based" }).example("hn user comments dang --limit 100", "Latest 100 comments").example('hn user comments pg -q "startup" --since 1y', "Comments mentioning a word"),
      async (argv) => {
        const ctx = createContext();
        const name = argv.username.trim();
        const time = timeFilters({ since: argv.since, after: argv.after, before: argv.before });
        const limit = clamp(argv.limit, 1, 1e3, 50);
        const page = clamp(argv.page, 1, 1e5, 1);
        const res = await ctx.algolia.search({
          query: argv.q,
          tags: `comment,author_${name}`,
          numericFilters: time.filters,
          sort: "date",
          hitsPerPage: limit,
          page: page - 1
        });
        const items = res.hits.map(commentFromHit);
        output({ username: name, items, count: items.length, page, nb_hits: res.nbHits, nb_pages: res.nbPages, _meta: buildMeta(ctx) }, argv.pretty);
      }
    ).demandCommand(1, "Specify a subcommand: get, posts, comments\n\n  Example: hn user get pg")
  );
}

// src/cli.ts
function buildCli(argv) {
  let cli = yargs(hideBin(argv)).scriptName("hn").usage("$0 <command> [flags]\n\nAgent-first Hacker News CLI. JSON on stdout, errors on stderr, no auth.").option("pretty", { type: "boolean", default: false, describe: "Pretty-print JSON output", global: true }).strict().demandCommand(1, "Specify a command. Run hn --help to see available commands.").recommendCommands().version(VERSION).help().wrap(Math.min(100, yargs().terminalWidth())).fail((msg, err, instance) => {
    if (err) throw err;
    if (/Specify a command/.test(msg)) instance.showHelp((s) => process.stderr.write(s + "\n\n"));
    process.stderr.write(JSON.stringify({ error: "UsageError", message: msg, hint: "Run `hn --help` or `hn <command> --help` for flags and examples." }) + "\n");
    process.exit(1);
  });
  cli = registerRankedFeedCommands(cli);
  cli = registerSearchCommands(cli);
  cli = registerThreadCommands(cli);
  cli = registerItemCommands(cli);
  cli = registerUserCommands(cli);
  cli = registerHiringCommands(cli);
  cli = registerLaunchCommands(cli);
  cli = registerDigestCommands(cli);
  cli = registerFeedCommands(cli);
  cli = registerStatusCommands(cli);
  cli = registerConfigCommands(cli);
  cli = registerSkillCommands(cli);
  return cli;
}

// src/index.ts
async function main() {
  try {
    await buildCli(process.argv).parseAsync();
  } catch (err) {
    outputError(err, process.argv.includes("--pretty"));
    process.exit(1);
  }
}
main();
