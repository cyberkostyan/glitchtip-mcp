import fetch from 'node-fetch';
import {
  GlitchTipConfig,
  GlitchTipIssue,
  GlitchTipEvent,
  GlitchTipValidationError,
  GlitchTipApiError,
  GlitchTipConnectionError
} from './types.js';

interface GlitchTipProject {
  id: string;
  slug: string;
  name: string;
  platform: string;
}

export class GlitchTipClient {
  private config: GlitchTipConfig;
  private projectCache: Map<string, string> = new Map(); // slug -> id

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

    // GlitchTip API uses lowercase organization slugs
    this.config.organization = this.config.organization.toLowerCase();

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

  async getProjects(): Promise<GlitchTipProject[]> {
    return this.makeRequest<GlitchTipProject[]>(
      `/organizations/${this.config.organization}/projects/`
    );
  }

  async getProjectId(slug: string): Promise<string | null> {
    // Check cache first
    if (this.projectCache.has(slug)) {
      return this.projectCache.get(slug)!;
    }

    // Fetch projects and populate cache
    const projects = await this.getProjects();
    for (const project of projects) {
      this.projectCache.set(project.slug, project.id);
    }

    return this.projectCache.get(slug) || null;
  }

  async getIssues(query?: string, projectSlug?: string): Promise<GlitchTipIssue[]> {
    if (!this.config.organization) {
      throw new GlitchTipValidationError('Organization is required in config.');
    }

    // Build endpoint with query params
    const params = new URLSearchParams();

    // GlitchTip API uses project ID as query parameter, not in the query string
    if (projectSlug) {
      const projectId = await this.getProjectId(projectSlug);
      if (projectId) {
        params.set('project', projectId);
      }
    }

    // Add search query if provided
    if (query) {
      params.set('query', query);
    }

    let endpoint = `/organizations/${this.config.organization}/issues/`;
    const queryString = params.toString();
    if (queryString) {
      endpoint += `?${queryString}`;
    }

    return this.makeRequest<GlitchTipIssue[]>(endpoint);
  }

  async getEvents(query?: string, projectSlug?: string): Promise<(GlitchTipEvent & { level: string })[]> {
    if (!this.config.organization) {
      throw new GlitchTipValidationError('Organization is required in config.');
    }

    // GlitchTip doesn't have a global events endpoint
    // Get issues filtered by query (server-side), then fetch their latest events
    const issues = await this.getIssues(query, projectSlug);
    const events: (GlitchTipEvent & { level: string })[] = [];

    // Limit to first 10 issues
    const limitedIssues = issues.slice(0, 10);

    for (const issue of limitedIssues) {
      try {
        const event = await this.makeRequest<GlitchTipEvent>(`/issues/${issue.id}/events/latest/`);
        // Add level from issue to event
        events.push({ ...event, level: issue.level });
      } catch (error) {
        // Skip issues that fail to fetch events
        continue;
      }
    }

    return events;
  }

  async getIssueEvents(issueId: string, latest: boolean = false): Promise<GlitchTipEvent | GlitchTipEvent[]> {
    const endpoint = latest
      ? `/issues/${issueId}/events/latest/`
      : `/issues/${issueId}/events/`;

    return this.makeRequest<GlitchTipEvent | GlitchTipEvent[]>(endpoint);
  }

  getIssueUrl(issueId: string): string {
    // Convert API URL to UI URL: https://glitch.swapio.dev/api/0 -> https://glitch.swapio.dev/swap-io/issues/613
    const baseUrl = this.config.baseUrl.replace(/\/api\/0$/, '');
    return `${baseUrl}/${this.config.organization}/issues/${issueId}`;
  }
}
