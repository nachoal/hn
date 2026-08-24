import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { algoliaPage, installFetch, runCli, type MockReply } from './helpers.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'hn-test-'));
  process.env.HN_CONFIG_DIR = configDir;
  process.env.HN_PACE_MS = '0';
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.HN_CONFIG_DIR;
  delete process.env.HN_PACE_MS;
});

const story = (id: number, extra: Record<string, unknown> = {}) => ({
  objectID: String(id),
  title: `Story ${id}`,
  url: `https://ex${id}.com/p`,
  author: `a${id}`,
  points: id * 10,
  num_comments: id,
  created_at: '2026-08-01T00:00:00Z',
  created_at_i: 1785542400,
  _tags: ['story', `author_a${id}`, `story_${id}`],
  ...extra,
});

describe('ranked feeds', () => {
  it('hn top hydrates via Algolia in one request and falls back to Firebase for misses', async () => {
    const { calls } = installFetch((url): MockReply | undefined => {
      if (url.pathname === '/v0/topstories.json') return { body: [11, 12, 13, 14] };
      if (url.pathname === '/v0/item/13.json') return { body: { id: 13, type: 'job', title: 'Acme (YC S26) is hiring', by: 'acme', time: 1785542400, score: 1 } };
      if (url.pathname.endsWith('/search')) {
        const ids = [...url.searchParams.get('tags')!.matchAll(/story_(\d+)/g)].map((m) => Number(m[1]));
        return { body: algoliaPage(ids.filter((id) => id !== 13).map((id) => story(id))) };
      }
      return undefined;
    });
    const { json } = await runCli(['top', '--limit', '3']);
    expect(json.feed).toBe('top');
    expect(json.count).toBe(3);
    expect(json.total_available).toBe(4);
    expect(json.items.map((i: any) => [i.id, i.rank, i.type])).toEqual([
      [11, 1, 'story'],
      [12, 2, 'story'],
      [13, 3, 'job'],
    ]);
    expect(json._meta.source).toBe('mixed');
    expect(json._meta.requests).toBe(3);
    expect(calls.filter((c) => c.includes('/v0/item/'))).toHaveLength(1);
  });

  it('--no-jobs drops job items and --page offsets rank', async () => {
    installFetch((url) => {
      if (url.pathname === '/v0/topstories.json') return { body: [1, 2, 3, 4] };
      if (url.pathname.endsWith('/search')) {
        const ids = [...url.searchParams.get('tags')!.matchAll(/story_(\d+)/g)].map((m) => Number(m[1]));
        return { body: algoliaPage(ids.map((id) => (id === 4 ? story(id, { _tags: ['job', 'story_4'] }) : story(id)))) };
      }
      return undefined;
    });
    const { json } = await runCli(['top', '--limit', '2', '--page', '2', '--no-jobs']);
    expect(json.items.map((i: any) => [i.id, i.rank])).toEqual([[3, 3]]);
  });
});

describe('search', () => {
  it('builds the expected Algolia query and normalizes hits', async () => {
    const { calls } = installFetch((url) => (url.pathname.endsWith('/search') ? { body: algoliaPage([story(5)], 1) } : undefined));
    const { json } = await runCli(['search', '-q', 'claude code', '--since', '7d', '--min-points', '10', '--author', 'pg', '--in', 'title']);
    const u = new URL(calls[0]!);
    expect(u.searchParams.get('query')).toBe('claude code');
    expect(u.searchParams.get('tags')).toBe('story,author_pg');
    expect(u.searchParams.get('numericFilters')).toMatch(/^created_at_i>=\d+,points>=10$/);
    expect(u.searchParams.get('restrictSearchableAttributes')).toBe('title');
    expect(json.items[0]).toMatchObject({ id: 5, domain: 'ex5.com', points: 50, type: 'story' });
    expect(json.nb_hits).toBe(1);
    expect(json.page).toBe(1);
  });

  it('--comments returns comment entries with story context', async () => {
    installFetch((url) =>
      url.pathname.endsWith('/search_by_date')
        ? {
            body: algoliaPage([
              { objectID: '99', author: 'c', comment_text: 'hi <i>there</i>', created_at: '2026-08-02T00:00:00Z', story_id: 5, parent_id: 5, story_title: 'Story 5', _tags: ['comment', 'story_5'] },
            ]),
          }
        : undefined,
    );
    const { json } = await runCli(['search', '-q', 'hi', '--comments', '--sort', 'date']);
    expect(json.type).toBe('comment');
    expect(json.items[0]).toMatchObject({ id: 99, type: 'comment', text: 'hi _there_', story_id: 5, story_title: 'Story 5' });
  });

  it('rejects an empty search with a usage error', async () => {
    installFetch(() => undefined);
    await expect(runCli(['search'])).rejects.toMatchObject({ name: 'UsageError' });
  });

  it('domain filters to exact domain matches', async () => {
    installFetch((url) =>
      url.pathname.endsWith('/search')
        ? { body: algoliaPage([story(1, { url: 'https://www.acme.com/x' }), story(2, { url: 'https://acme.com.evil.net/y' }), story(3, { url: 'https://blog.acme.com/z' })], 3) }
        : undefined,
    );
    const { json } = await runCli(['domain', 'https://acme.com/whatever']);
    expect(json.domain).toBe('acme.com');
    expect(json.items.map((i: any) => i.id)).toEqual([1, 3]);
    expect(json.nb_hits).toBe(3);
    expect(json.count).toBe(2);
  });
});

describe('thread get', () => {
  const tree = {
    id: 100,
    type: 'story',
    author: 'op',
    title: 'Ask HN: Test?',
    url: null,
    text: '<p>body</p>',
    points: 40,
    parent_id: null,
    story_id: 100,
    created_at: '2026-08-01T00:00:00Z',
    children: [201, 202, 203].map((id) => ({
      id,
      type: 'comment',
      author: `u${id}`,
      title: null,
      url: null,
      text: `c${id}`,
      points: null,
      parent_id: 100,
      story_id: 100,
      created_at: `2026-08-01T00:0${id - 200}:00Z`,
      children: id === 201 ? [{ id: 301, type: 'comment', author: 'x', title: null, url: null, text: 'r', points: null, parent_id: 201, story_id: 100, created_at: '2026-08-01T01:00:00Z', children: [] }] : [],
    })),
  };

  it('orders top-level comments by Firebase kids, enriches live numbers, truncates level-order', async () => {
    installFetch((url) => {
      if (url.pathname === '/api/v1/items/100') return { body: tree };
      if (url.pathname === '/v0/item/100.json') return { body: { id: 100, type: 'story', score: 42, descendants: 4, kids: [203, 201, 202] } };
      return undefined;
    });
    const { json } = await runCli(['thread', 'get', 'https://news.ycombinator.com/item?id=100', '--max-comments', '2']);
    expect(json.story).toMatchObject({ id: 100, type: 'ask', points: 42, num_comments: 4, text: 'body' });
    expect(json.comments.map((c: any) => c.id)).toEqual([203, 201]);
    expect(json.comments[1].replies).toEqual([]);
    expect(json.comments[1].reply_count).toBe(1);
    expect(json).toMatchObject({ comment_count: 4, returned_count: 2, truncated: true });
    expect(json._meta.source).toBe('mixed');
  });

  it('--sort new skips Firebase and --flat flattens', async () => {
    const { calls } = installFetch((url) => (url.pathname === '/api/v1/items/100' ? { body: tree } : undefined));
    const { json } = await runCli(['thread', 'get', '100', '--sort', 'new', '--flat']);
    expect(calls).toHaveLength(1);
    expect(json.comments.map((c: any) => c.id)).toEqual([203, 202, 201, 301]);
    expect(json.comments[3].depth).toBe(1);
    expect(json.story.num_comments).toBe(4);
  });

  it('reports NotFoundError for unindexed items', async () => {
    installFetch((url) => (url.pathname === '/v0/item/5.json' ? { text: 'null' } : undefined));
    await expect(runCli(['thread', 'get', '5'])).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});

describe('users and items', () => {
  it('user get maps the Firebase profile', async () => {
    installFetch((url) => (url.pathname === '/v0/user/pg.json' ? { body: { id: 'pg', created: 1160418092, karma: 5, about: 'Bug &amp; fixer.', submitted: [3, 2, 1] } } : undefined));
    const { json } = await runCli(['user', 'get', 'pg']);
    expect(json.user).toMatchObject({ id: 'pg', karma: 5, about: 'Bug & fixer.', submitted_count: 3, latest_submitted_ids: [3, 2, 1] });
  });

  it('user get rejects unknown users', async () => {
    installFetch((url) => (url.pathname.startsWith('/v0/user/') ? { text: 'null' } : undefined));
    await expect(runCli(['user', 'get', 'nobody'])).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('user posts uses author tags and the date endpoint by default', async () => {
    const { calls } = installFetch((url) => (url.pathname.endsWith('/search_by_date') ? { body: algoliaPage([story(9)]) } : undefined));
    const { json } = await runCli(['user', 'posts', 'pg', '--type', 'ask']);
    expect(new URL(calls[0]!).searchParams.get('tags')).toBe('ask_hn,author_pg');
    expect(json.items[0].id).toBe(9);
  });

  it('item get returns the live record with kids', async () => {
    installFetch((url) => (url.pathname === '/v0/item/8863.json' ? { body: { id: 8863, type: 'story', by: 'dhouston', score: 104, descendants: 71, kids: [9224, 8917], title: 'My YC app' } } : undefined));
    const { json } = await runCli(['item', 'get', '8863']);
    expect(json.item).toMatchObject({ id: 8863, points: 104, num_comments: 71, kids: [9224, 8917], parent: null });
  });
});

describe('hiring and launches', () => {
  it('hiring picks the latest thread of the kind and keyword-filters top-level posts', async () => {
    installFetch((url) => {
      if (url.pathname.endsWith('/search_by_date')) {
        return {
          body: algoliaPage([
            story(500, { title: 'Ask HN: Who wants to be hired? (August 2026)', author: 'whoishiring' }),
            story(501, { title: 'Ask HN: Who is hiring? (August 2026)', author: 'whoishiring' }),
            story(400, { title: 'Ask HN: Who is hiring? (July 2026)', author: 'whoishiring' }),
          ]),
        };
      }
      if (url.pathname === '/api/v1/items/501') {
        return {
          body: {
            id: 501,
            type: 'story',
            title: 'Ask HN: Who is hiring? (August 2026)',
            author: 'whoishiring',
            url: null,
            text: null,
            points: 300,
            parent_id: null,
            story_id: 501,
            created_at: '2026-08-03T00:00:00Z',
            children: [
              { id: 1, type: 'comment', author: 'a', title: null, url: null, text: 'Acme | Remote | Rust engineer', points: null, parent_id: 501, story_id: 501, created_at: '2026-08-03T01:00:00Z', children: [{ id: 2, type: 'comment', author: 'b', title: null, url: null, text: 'nested remote rust', points: null, parent_id: 1, story_id: 501, created_at: '2026-08-03T02:00:00Z', children: [] }] },
              { id: 3, type: 'comment', author: 'c', title: null, url: null, text: 'Beta | Onsite NYC | Go', points: null, parent_id: 501, story_id: 501, created_at: '2026-08-03T01:00:00Z', children: [] },
              { id: 4, type: 'comment', author: 'd', title: null, url: null, text: null, points: null, parent_id: 501, story_id: 501, created_at: '2026-08-03T01:00:00Z', children: [] },
            ],
          },
        };
      }
      return undefined;
    });
    const { json } = await runCli(['hiring', '--keywords', 'remote,rust', '--match', 'all']);
    expect(json.thread).toMatchObject({ id: 501, month: '2026-08', top_level_posts: 3 });
    expect(json.matched_count).toBe(1);
    expect(json.items[0]).toMatchObject({ id: 1, matched_keywords: ['remote', 'rust'], reply_count: 1, replies: [] });
  });

  it('hiring --month selects an older thread and --list lists', async () => {
    installFetch((url) =>
      url.pathname.endsWith('/search_by_date')
        ? { body: algoliaPage([story(501, { title: 'Ask HN: Who is hiring? (August 2026)' }), story(400, { title: 'Ask HN: Who is hiring? (July 2026)' })]) }
        : url.pathname === '/api/v1/items/400'
          ? { body: { id: 400, type: 'story', title: 'x', author: 'w', url: null, text: null, points: 1, parent_id: null, story_id: 400, created_at: '2026-07-01T00:00:00Z', children: [] } }
          : undefined,
    );
    const list = await runCli(['hiring', '--list']);
    expect(list.json.threads.map((t: any) => t.month)).toEqual(['2026-08', '2026-07']);
    const { json } = await runCli(['hiring', '--month', '2026-07']);
    expect(json.thread.id).toBe(400);
    expect(json.count).toBe(0);
  });

  it('launches parses company/batch/tagline and filters by batch', async () => {
    installFetch((url) =>
      url.pathname.endsWith('/search_by_date')
        ? {
            body: algoliaPage([
              story(1, { title: 'Launch HN: OneCLI (YC S26) – OSS sandboxed agent harness' }),
              story(2, { title: 'Launch HN: Old (YC W24) – Something' }),
              story(3, { title: 'Show HN: Not a launch' }),
            ]),
          }
        : undefined,
    );
    const { json } = await runCli(['launches', '--batch', 's26']);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({ company: 'OneCLI', batch: 'S26', tagline: 'OSS sandboxed agent harness' });
    expect(json.batch).toBe('S26');
  });
});

describe('digest and feeds', () => {
  it('digest returns one bucket per keyword', async () => {
    installFetch((url) => {
      const q = url.searchParams.get('query');
      return url.pathname.endsWith('/search') ? { body: algoliaPage(q === 'a' ? [story(1), story(2)] : [story(2)], q === 'a' ? 2 : 1) } : undefined;
    });
    const { json } = await runCli(['digest', '--keywords', 'a, b']);
    expect(json.buckets.map((b: any) => [b.keyword, b.count])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(json.unique_count).toBe(2);
  });

  it('feed create/run/run is idempotent and delete needs --yes', async () => {
    installFetch((url) => (url.pathname.endsWith('/search_by_date') ? { body: algoliaPage([story(1), story(2)]) } : undefined));
    const created = await runCli(['feed', 'create', 'brand', '--keywords', 'acme']);
    expect(created.json.created).toBe(true);

    const first = await runCli(['feed', 'run', 'brand']);
    expect(first.json.count).toBe(2);
    expect(first.json.new_items.map((i: any) => i.id)).toEqual([2, 1]);

    const second = await runCli(['feed', 'run', 'brand']);
    expect(second.json.count).toBe(0);
    expect(second.json.seen_count).toBe(2);

    const listed = await runCli(['feed', 'list']);
    expect(listed.json.feeds[0]).toMatchObject({ name: 'brand', seen_count: 2 });

    await expect(runCli(['feed', 'delete', 'brand'])).rejects.toMatchObject({ name: 'UsageError' });
    const deleted = await runCli(['feed', 'delete', 'brand', '--yes']);
    expect(deleted.json.deleted).toBe(true);
  });

  it('feed run --dry-run does not mark items seen', async () => {
    installFetch((url) => (url.pathname.endsWith('/search_by_date') ? { body: algoliaPage([story(1)]) } : undefined));
    await runCli(['feed', 'create', 'x', '--keywords', 'a']);
    const dry = await runCli(['feed', 'run', 'x', '--dry-run']);
    expect(dry.json).toMatchObject({ dry_run: true, count: 1, seen_count: 0 });
    const real = await runCli(['feed', 'run', 'x']);
    expect(real.json.count).toBe(1);
  });
});

describe('status and skill', () => {
  it('status reports both APIs', async () => {
    installFetch((url) => (url.pathname === '/v0/maxitem.json' ? { body: 123 } : url.pathname.endsWith('/search') ? { body: algoliaPage([story(1)], 500) } : undefined));
    const { json } = await runCli(['status']);
    expect(json.ok).toBe(true);
    expect(json.firebase.maxitem).toBe(123);
    expect(json.algolia.indexed_stories).toBe(500);
  });

  it('skill path resolves the bundled skill directory', async () => {
    const { stdout, json } = await runCli(['skill', 'path']);
    expect(json).toBeNull();
    expect(stdout.trim().endsWith('/skills/hn-hackernews-research')).toBe(true);
  });
});
