import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../src/text.js';

describe('htmlToText', () => {
  it('returns null for null input', () => {
    expect(htmlToText(null)).toBeNull();
    expect(htmlToText(undefined)).toBeNull();
  });

  it('collapses HN link markup where the text is a truncated copy of the href', () => {
    const html = 'Snout <a href="https:&#x2F;&#x2F;snout.com&#x2F;" rel="nofollow">https:&#x2F;&#x2F;snout.com&#x2F;</a> | Multiple Engineers';
    expect(htmlToText(html)).toBe('Snout https://snout.com/ | Multiple Engineers');
  });

  it('keeps distinct link text with the href in parentheses', () => {
    expect(htmlToText('See <a href="https://x.dev/a">the docs</a>.')).toBe('See the docs (https://x.dev/a).');
  });

  it('turns <p> separators into paragraphs and decodes entities after stripping tags', () => {
    const html = 'First &quot;para&quot; with &#x27;quotes&#x27;.<p>Second &gt; first &amp; &lt;b&gt;literal&lt;/b&gt;';
    expect(htmlToText(html)).toBe('First "para" with \'quotes\'.\n\nSecond > first & <b>literal</b>');
  });

  it('renders code blocks and inline code as markdown', () => {
    const html = 'Run <code>npm i</code><p><pre><code>const a = 1;\n</code></pre>';
    expect(htmlToText(html)).toBe('Run `npm i`\n\n```\nconst a = 1;\n```');
  });

  it('maps italics and bold to markdown markers and drops unknown tags', () => {
    expect(htmlToText('<i>soft</i> and <b>loud</b> <span>plain</span>')).toBe('_soft_ and **loud** plain');
  });

  it('collapses runs of blank lines', () => {
    expect(htmlToText('a<p><p><p>b')).toBe('a\n\nb');
  });
});

describe('decodeEntities', () => {
  it('handles named, decimal, and hex entities', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#39;&#x27;&#x2F;&nbsp;x')).toBe('&<>"\'\'/ x');
  });

  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&bogus;')).toBe('&bogus;');
  });
});
