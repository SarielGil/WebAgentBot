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
    if (this.braveApiKey) {
      try {
        return await this.searchBrave(query);
      } catch (err) {
        logger.error({ err }, 'Brave search failed, falling back to google-it');
      }
    }
    return await this.searchGoogle(query);
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
}
