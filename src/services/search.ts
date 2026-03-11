import axios from 'axios';
import googleIt from 'google-it';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

export class SearchService {
  private braveApiKey?: string;

  constructor() {
    const envs = readEnvFile(['BRAVE_API_KEY']);
    this.braveApiKey = envs.BRAVE_API_KEY || process.env.BRAVE_API_KEY;
  }

  async search(query: string): Promise<SearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    let results: SearchResult[] = [];
    if (this.braveApiKey) {
      try {
        logger.info({ query: normalizedQuery }, 'Using Brave Search provider');
        results = await this.searchBrave(normalizedQuery);
      } catch (err) {
        logger.error({ err }, 'Brave search failed, falling back to google-it');
      }
    }
    if (results.length === 0) {
      logger.warn({ query: normalizedQuery }, 'Using google-it fallback search provider');
      results = await this.searchGoogle(normalizedQuery);
    }
    return this.rankAndFilter(results, normalizedQuery);
  }

  private async searchBrave(query: string): Promise<SearchResult[]> {
    const response = await axios.get(
      'https://api.search.brave.com/res/v1/web/search',
      {
        params: { q: query },
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.braveApiKey,
        },
      },
    );

    return response.data.web.results.map((r: any) => ({
      title: r.title,
      link: r.url,
      snippet: r.description,
    }));
  }

  private async searchGoogle(query: string): Promise<SearchResult[]> {
    const results = await googleIt({ query, 'no-display': true, limit: 5 });
    return results.map((r: any) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    }));
  }

  private rankAndFilter(results: SearchResult[], query: string): SearchResult[] {
    const inspirationIntent =
      /\b(inspiration|inspire|ideas?|examples?|reference|references|moodboard|style|competitors?|similar)\b/i.test(
        query,
      );
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
      .filter((t) => t.length > 1)
      .filter(
        (t) =>
          !new Set([
            'the',
            'and',
            'for',
            'with',
            'from',
            'that',
            'this',
            'what',
            'when',
            'where',
            'about',
            'into',
            'your',
            'best',
            'site',
            'website',
            'web',
            'brand',
            'term',
            'find',
            'look',
          ]).has(t),
      );
    const primaryTerm = queryTerms.sort((a, b) => b.length - a.length)[0] || '';

    const seenLinks = new Set<string>();
    const scored: Array<{ score: number; item: SearchResult }> = [];

    for (const raw of results) {
      const title = this.cleanText(raw.title);
      const snippet = this.cleanText(raw.snippet);
      const link = (raw.link || '').trim();
      if (!title || !link || seenLinks.has(link)) continue;
      seenLinks.add(link);

      const haystack = `${title} ${snippet}`.toLowerCase();
      let score = 0;
      let matchedTerms = 0;
      for (const term of queryTerms) {
        const titleHit = title.toLowerCase().includes(term);
        const bodyHit = haystack.includes(term) || link.toLowerCase().includes(term);
        if (titleHit) score += 3;
        if (bodyHit) score += 1;
        if (titleHit || bodyHit) matchedTerms++;
      }
      if (/wikipedia\.org\/wiki\/category:/i.test(link)) score -= 3;
      if (/tripadvisor\.|pinterest\.|directory|list of/i.test(haystack)) score -= 2;
      if (snippet.length < 40) score -= 1;
      if (primaryTerm && !haystack.includes(primaryTerm) && !link.toLowerCase().includes(primaryTerm)) {
        score -= 4;
      }

      // For non-inspiration searches, require direct mention of user term/brand.
      if (!inspirationIntent && matchedTerms === 0) {
        continue;
      }

      scored.push({ score, item: { title, link, snippet } });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item)
      .slice(0, 8);
  }

  private cleanText(input: string): string {
    return (input || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
