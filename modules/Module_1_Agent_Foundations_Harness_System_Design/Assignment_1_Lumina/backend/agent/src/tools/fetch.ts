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

export async function fetchPage(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; LUMINA/0.1; +https://github.com/)',
      accept: 'text/html,application/xhtml+xml'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${res.status} from publisher`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('html')) throw new Error(`unsupported content-type: ${type || 'unknown'}`);

  const html = await res.text();
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
