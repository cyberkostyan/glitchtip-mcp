#!/usr/bin/env node

import 'dotenv/config';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GlitchTipClient } from "./client.js";

const server = new McpServer({
  name: "glitchtip-mcp",
  version: "1.0.0"
});

function getGlitchTipClient(): GlitchTipClient | null {
  try {
    return new GlitchTipClient({
      baseUrl: process.env.GLITCHTIP_BASE_URL || 'https://app.glitchtip.com',
      token: process.env.GLITCHTIP_TOKEN,
      sessionId: process.env.GLITCHTIP_SESSION_ID,
      organization: process.env.GLITCHTIP_ORGANIZATION!
    });
  } catch (error) {
    return null;
  }
}

function getValidationError(): string {
  if (!process.env.GLITCHTIP_TOKEN && !process.env.GLITCHTIP_SESSION_ID) {
    return 'Either token or session ID is required';
  }
  if (!process.env.GLITCHTIP_ORGANIZATION) {
    return 'Organization is required';
  }
  return 'Configuration error';
}

server.resource(
  "issues",
  new ResourceTemplate("glitchtip://issues", {
    list: () => ({
      resources: [{
        uri: "glitchtip://issues",
        mimeType: "application/json",
        name: "GlitchTip Issues",
        description: "All unresolved issues from GlitchTip error monitoring"
      }]
    })
  }),
  async (uri) => {
    const client = getGlitchTipClient();
    if (!client) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: getValidationError()
        }]
      };
    }
    try {
      const issues = await client.getIssues('is:unresolved');
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(issues, null, 2)
        }]
      };
    } catch (error) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: error instanceof Error ? error.message : 'Error fetching issues'
        }]
      };
    }
  }
);

server.tool(
  "glitchtip_issues",
  "Get issues (grouped errors) from GlitchTip with optional project and tag filtering. Use glitchtip_events for individual error occurrences.",
  {
    project: z.string().optional().describe("Filter issues by project slug (e.g. 'parlay-api', 'frontend'). Use this to show only errors from a specific project."),
    status: z.enum(['resolved', 'unresolved', 'all']).optional().describe("Filter issues by status: 'resolved', 'unresolved', or 'all' (default: 'unresolved')"),
    query: z.string().optional().describe("Search with tag filters, e.g. 'walletAddress:0x123...' to find issues for a specific wallet. Returns only issues that have matching tags.")
  },
  async ({ project, status = 'unresolved', query }) => {
    const client = getGlitchTipClient();
    if (!client) {
      return {
        content: [{
          type: "text",
          text: getValidationError()
        }]
      };
    }
    try {
      // Build query string
      let q = status === 'all' ? '' : `is:${status}`;
      if (project) {
        q = q ? `${q} project:${project}` : `project:${project}`;
      }
      if (query) {
        q = q ? `${q} ${query}` : query;
      }
      const issues = await client.getIssues(q || undefined);
      if (issues.length === 0) {
        return {
          content: [{
            type: "text",
            text: query
              ? `No issues found matching query: ${query}`
              : `No ${status} issues found`
          }]
        };
      }
      // Add URL to each issue
      const issuesWithUrl = issues.map(issue => ({
        ...issue,
        url: client.getIssueUrl(issue.id)
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify(issuesWithUrl, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : 'Error fetching issues'
        }]
      };
    }
  }
);

server.tool(
  "glitchtip_events",
  "Search events (all error occurrences) with optional project and tag filtering. Returns summary info - use glitchtip_latest_event for full details.",
  {
    project: z.string().optional().describe("Filter events by project slug (e.g. 'parlay-api', 'frontend'). Use this to show only errors from a specific project."),
    query: z.string().optional().describe("Search query with tag filters, e.g. 'walletAddress:0x123...' to find events for a specific wallet")
  },
  async ({ project, query }) => {
    const client = getGlitchTipClient();
    if (!client) {
      return {
        content: [{
          type: "text",
          text: getValidationError()
        }]
      };
    }
    try {
      // Build query with project filter
      let q = project ? `project:${project}` : '';
      if (query) {
        q = q ? `${q} ${query}` : query;
      }
      const events = await client.getEvents(q || undefined);
      if (events.length === 0) {
        return {
          content: [{
            type: "text",
            text: query
              ? `No events found matching query: ${query}`
              : 'No events found'
          }]
        };
      }
      // Return summary without large entries/breadcrumbs to keep response small
      const summary = events.map(e => ({
        eventID: e.eventID,
        groupID: e.groupID,
        title: e.title,
        message: e.message,
        level: e.level,  // "error" or "info"
        type: e.type,
        dateCreated: e.dateCreated,
        culprit: e.culprit,
        tags: e.tags,
        metadata: e.metadata,
        url: client.getIssueUrl(e.groupID)
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify(summary, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : 'Error fetching events'
        }]
      };
    }
  }
);

server.tool(
  "glitchtip_latest_event",
  "Get the latest event for a specific issue",
  {
    issueId: z.string().describe("The issue ID to get the latest event for")
  },
  async ({ issueId }) => {
    const client = getGlitchTipClient();
    if (!client) {
      return {
        content: [{
          type: "text",
          text: getValidationError()
        }]
      };
    }
    try {
      const event = await client.getIssueEvents(issueId, true);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(event, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : 'Error fetching latest event'
        }]
      };
    }
  }
);

server.prompt(
  "recent_errors",
  "Get overview of recent production errors with analysis and prioritization",
  async () => {
    const client = getGlitchTipClient();
    if (!client) {
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: getValidationError()
          }
        }]
      };
    }
    try {
      const issues = await client.getIssues('is:unresolved');
      const prompt = `Analyze these GlitchTip errors and provide:
1. Summary of error frequency and severity
2. Most critical issues (by count and impact)
3. Common patterns or trends
4. Recommended prioritization

Issues data:
${JSON.stringify(issues, null, 2)}`;

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: prompt
          }
        }]
      };
    } catch (error) {
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: error instanceof Error ? error.message : 'Error fetching issues'
          }
        }]
      };
    }
  }
);

server.prompt(
  "debug_issue",
  "Deep-dive into a specific error with full context and suggest fixes",
  {
    issueId: z.string().describe("The issue ID to debug")
  },
  async ({ issueId }) => {
    const client = getGlitchTipClient();
    if (!client) {
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: getValidationError()
          }
        }]
      };
    }
    try {
      const event = await client.getIssueEvents(issueId, true);
      const prompt = `Debug this GlitchTip error and provide:
1. Root cause analysis
2. Stack trace interpretation
3. Potential fixes with code examples
4. Prevention strategies

Error details:
${JSON.stringify(event, null, 2)}`;

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: prompt
          }
        }]
      };
    } catch (error) {
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: error instanceof Error ? error.message : 'Error fetching event'
          }
        }]
      };
    }
  }
);

const main = async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
