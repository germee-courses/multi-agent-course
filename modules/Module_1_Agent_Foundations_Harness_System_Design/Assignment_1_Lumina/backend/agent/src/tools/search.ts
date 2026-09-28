import { env, secrets } from '../env.js';

/**
 * web_search, behind one interface so SEARCH_PROVIDER=tavily|serpapi swaps the provider
 * with no code change.
 *
 * Fail loud: a provider that errors THROWS. Zero results is a normal, successful answer
 * ([]), and it must stay distinguishable from "the provider is down" — returning [] from
 * a catch block is exactly how a broken search becomes "I couldn't find anything".
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class ProviderError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider}: ${detail}`);
    this.name = 'ProviderError';
  }
}

const TIMEOUT_MS = 10_000;

export async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  return env.searchProvider === 'serpapi' ? serpapi(query, maxResults) : tavily(query, maxResults);
}

async function tavily(query: string, maxResults: number): Promise<SearchResult[]> {
  if (!secrets.tavily) throw new ProviderError('tavily', 'TAVILY_API_KEY is not set');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.tavily}` },
    body: JSON.stringify({ query, max_results: maxResults }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new ProviderError('tavily', `${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (body.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title || r.url!, url: r.url!, snippet: r.content ?? '' }));
}

async function serpapi(query: string, maxResults: number): Promise<SearchResult[]> {
  if (!secrets.serpapi) throw new ProviderError('serpapi', 'SERPAPI_API_KEY is not set');
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(maxResults));
  url.searchParams.set('api_key', secrets.serpapi);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new ProviderError('serpapi', `${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    error?: string;
    organic_results?: { title?: string; link?: string; snippet?: string }[];
  };
  // SerpApi reports some failures (bad key, quota) as a 200 with an `error` field.
  // "Google hasn't returned any results" is the one error that really means zero results.
  if (body.error && !/hasn't returned any results/i.test(body.error)) {
    throw new ProviderError('serpapi', body.error);
  }
  return (body.organic_results ?? [])
    .filter((r) => r.link)
    .slice(0, maxResults)
    .map((r) => ({ title: r.title || r.link!, url: r.link!, snippet: r.snippet ?? '' }));
}
