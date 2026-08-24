const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED[lower] ?? match;
  });
}

/**
 * Convert HN's small HTML dialect (<p>, <a>, <i>, <b>, <code>, <pre>, entities) to readable
 * plain text with light markdown. HN emits `<p>` as a paragraph *separator* with no closing
 * tag, links whose visible text is a truncated copy of the href, and `&#x2F;`-escaped slashes.
 */
export function htmlToText(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null;
  let s = html;
  s = s.replace(/<pre>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code: string) => {
    return '\n```\n' + decodeEntities(code).replace(/\n+$/, '') + '\n```\n';
  });
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, (_m, code: string) => '`' + decodeEntities(code) + '`');
  s = s.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const h = decodeEntities(href).trim();
    const t = decodeEntities(text.replace(/<[^>]+>/g, '')).trim();
    if (!t || t === h) return h;
    const stem = t.replace(/\.\.\.$/, '');
    if (h.startsWith(stem) || h.replace(/^https?:\/\//, '').startsWith(stem)) return h;
    return `${t} (${h})`;
  });
  s = s.replace(/<\/p>/gi, '');
  s = s.replace(/<p[^>]*>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(i|em)>/gi, '_');
  s = s.replace(/<\/?(b|strong)>/gi, '**');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
