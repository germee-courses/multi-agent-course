import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

/**
 * fetch_page: download a page and keep only its readable article text, so the answer is
 * synthesised from what the page actually says rather than from a search snippet.
 *
 * A page that cannot be read (403, paywall, not HTML) THROWS with a short reason. The loop
 * records that as a failed trace step (ok:false + error) and carries on with the other
 * pages — one publisher blocking us is not a provider outage.
 */
export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

const TIMEOUT_MS = 10_000;
/** Enough for a long article; more is cost, not grounding. */
const MAX_CHARS = 30_000;
/**
 * JSDOM parses on the event loop, so parallel fetches queue behind each other's parsing:
 * deep runs showed 8–15 fetches all "taking" 6–7 s together. Scripts, styles and SVG are
 * most of a modern page's bytes and Readability reads none of them, so they go first, and
 * anything past 1.5 MB of markup is not an article.
 */
const MAX_HTML_CHARS = 1_500_000;
const NOT_TEXT = /<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi;

export async function fetchPage(url: string, timeoutMs = TIMEOUT_MS): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; LUMINA/0.1; +https://github.com/)',
      accept: 'text/html,application/xhtml+xml'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`${res.status} from publisher`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('html')) throw new Error(`unsupported content-type: ${type || 'unknown'}`);

  const html = (await res.text()).slice(0, MAX_HTML_CHARS).replace(NOT_TEXT, '');
  // Silence the page's own CSS/script errors; they are the publisher's problem, not ours.
  const dom = new JSDOM(html, { url: res.url, virtualConsole: new VirtualConsole() });
  const article = new Readability(dom.window.document).parse();
  const text = (article?.textContent ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (text.length < 200) throw new Error('no readable article text on the page');

  return { url: res.url || url, title: article?.title || url, text: text.slice(0, MAX_CHARS) };
}
