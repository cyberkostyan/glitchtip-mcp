import fetch from 'node-fetch';
import {
  GlitchTipConfig,
  GlitchTipIssue,
  GlitchTipEvent,
  GlitchTipValidationError,
  GlitchTipApiError,
  GlitchTipConnectionError
} from './types.js';

export class GlitchTipClient {
  private config: GlitchTipConfig;

  constructor(config: GlitchTipConfig) {
    this.config = config;
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.baseUrl) {
      throw new GlitchTipValidationError('Base URL is required');
    }
    if (!this.config.token && !this.config.sessionId) {
      throw new GlitchTipValidationError('Either token or session ID is required');
    }
    if (!this.config.organization) {
      throw new GlitchTipValidationError('Organization is required');
    }

    if (!this.config.baseUrl.endsWith('/api/0')) {
      this.config.baseUrl = this.config.baseUrl.endsWith('/')
        ? `${this.config.baseUrl}api/0`
        : `${this.config.baseUrl}/api/0`;
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    } else if (this.config.sessionId) {
      headers['Cookie'] = `sessionid=${this.config.sessionId}`;
    }

    return headers;
  }

  private async makeRequest<T>(endpoint: string): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new GlitchTipApiError('Authentication failed. Check your token or session ID.', response.status);
        }
        if (response.status === 403) {
          throw new GlitchTipApiError('Access forbidden. Check your permissions.', response.status);
        }
        if (response.status === 404) {
          throw new GlitchTipApiError('Resource not found.', response.status);
        }
        throw new GlitchTipApiError(`HTTP ${response.status}: ${response.statusText}`, response.status);
      }

      return await response.json() as T;
    } catch (error) {
      if (error instanceof GlitchTipApiError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new GlitchTipConnectionError(`Failed to connect to GlitchTip: ${message}`);
    }
  }

  async getIssues(query?: string): Promise<GlitchTipIssue[]> {
    if (!this.config.organization) {
      throw new GlitchTipValidationError('Organization is required in config.');
    }

    // Parse tag filters from query (e.g., "walletAddress:0x123")
    let tagFilters: Record<string, string> = {};
    let apiQuery = query || '';

    if (query) {
      // Extract tag:value patterns
      const tagPattern = /(\w+):([^\s]+)/g;
      let match;
      const nonTagParts: string[] = [];
      let lastIndex = 0;

      while ((match = tagPattern.exec(query)) !== null) {
        const [fullMatch, key, value] = match;
        // Check if it's a GlitchTip native query (is:resolved, etc.)
        if (key === 'is') {
          nonTagParts.push(fullMatch);
        } else {
          // It's a tag filter
          tagFilters[key] = value;
        }
        lastIndex = match.index + fullMatch.length;
      }

      // Keep only native GlitchTip queries for API
      apiQuery = nonTagParts.join(' ').trim();
    }

    let endpoint = `/organizations/${this.config.organization}/issues/`;
    if (apiQuery) {
      endpoint += `?query=${encodeURIComponent(apiQuery)}`;
    }

    const issues = await this.makeRequest<GlitchTipIssue[]>(endpoint);

    // Filter by tags on client side if tag filters specified
    if (Object.keys(tagFilters).length > 0) {
      return issues.filter(issue => {
        // Check if issue has matching tags
        const tags = issue.tags || [];
        return Object.entries(tagFilters).every(([key, value]) => {
          const tag = tags.find(t => t.key === key);
          return tag && tag.value === value;
        });
      });
    }

    return issues;
  }

  async getEvents(query?: string): Promise<GlitchTipEvent[]> {
    if (!this.config.organization) {
      throw new GlitchTipValidationError('Organization is required in config.');
    }

    // Parse tag filters from query
    let tagFilters: Record<string, string> = {};

    if (query) {
      const tagPattern = /(\w+):([^\s]+)/g;
      let match;
      while ((match = tagPattern.exec(query)) !== null) {
        const [, key, value] = match;
        if (key !== 'is') {
          tagFilters[key] = value;
        }
      }
    }

    // Get events from all projects
    const endpoint = `/organizations/${this.config.organization}/events/`;
    const events = await this.makeRequest<GlitchTipEvent[]>(endpoint);

    // Filter by tags on client side
    if (Object.keys(tagFilters).length > 0) {
      return events.filter(event => {
        const tags = event.tags || [];
        return Object.entries(tagFilters).every(([key, value]) => {
          const tag = tags.find(t => t.key === key);
          return tag && tag.value === value;
        });
      });
    }

    return events;
  }

  async getIssueEvents(issueId: string, latest: boolean = false): Promise<GlitchTipEvent | GlitchTipEvent[]> {
    const endpoint = latest
      ? `/issues/${issueId}/events/latest/`
      : `/issues/${issueId}/events/`;

    return this.makeRequest<GlitchTipEvent | GlitchTipEvent[]>(endpoint);
  }
}
