/**
 * OpenViking context retrieval for NanoClaw
 *
 * Queries the OpenViking REST API before each agent session to inject
 * relevant context into the group workspace.
 * Failures are non-fatal — OpenViking is an enhancement, not a requirement.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

const OPENVIKING_URL = process.env.OPENVIKING_URL || 'http://127.0.0.1:1933';
const OPENVIKING_ENABLED = process.env.OPENVIKING_ENABLED !== 'false';
const OPENVIKING_LIMIT = parseInt(process.env.OPENVIKING_LIMIT || '5');
const OPENVIKING_CONTENT_LINES = parseInt(
  process.env.OPENVIKING_CONTENT_LINES || '60',
);
const OPENVIKING_TIMEOUT_MS = 6000;

export const CONTEXT_FILENAME = 'openviking-context.md';

interface SearchItem {
  context_type: string;
  uri: string;
  level: number;
  score: number;
  abstract?: string;
  overview?: string;
}

interface FindResponse {
  status: string;
  result?: {
    memories?: SearchItem[];
    resources?: SearchItem[];
    skills?: SearchItem[];
    total?: number;
  };
}

interface ContentResponse {
  status: string;
  result?: string;
}

async function fetchContent(uri: string): Promise<string | null> {
  try {
    const url = `${OPENVIKING_URL}/api/v1/content/read?uri=${encodeURIComponent(uri)}&limit=${OPENVIKING_CONTENT_LINES}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ContentResponse;
    return typeof data?.result === 'string' ? data.result : null;
  } catch {
    return null;
  }
}

export async function fetchAndWriteContext(
  groupFolder: string,
  query: string,
): Promise<void> {
  if (!OPENVIKING_ENABLED) return;

  const groupDir = resolveGroupFolderPath(groupFolder);
  const contextFile = path.join(groupDir, CONTEXT_FILENAME);

  try {
    const response = await fetch(`${OPENVIKING_URL}/api/v1/search/find`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        limit: OPENVIKING_LIMIT,
      }),
      signal: AbortSignal.timeout(OPENVIKING_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.debug(
        { status: response.status },
        'OpenViking search returned non-OK, skipping context',
      );
      return;
    }

    const data = (await response.json()) as FindResponse;
    const result = data?.result;
    if (!result || result.total === 0) {
      if (fs.existsSync(contextFile)) fs.unlinkSync(contextFile);
      return;
    }

    // Merge all item types, sort by score descending, take top N
    const allItems: SearchItem[] = [
      ...(result.resources ?? []),
      ...(result.memories ?? []),
      ...(result.skills ?? []),
    ].sort((a, b) => b.score - a.score);

    if (allItems.length === 0) {
      if (fs.existsSync(contextFile)) fs.unlinkSync(contextFile);
      return;
    }

    const sections: string[] = [];

    for (const item of allItems) {
      const scoreLabel = `${(item.score * 100).toFixed(0)}%`;
      let body = '';

      // Try fetching full content first, fall back to overview or abstract
      const content = await fetchContent(item.uri);
      if (content && content.trim()) {
        body = content.trim();
      } else if (item.overview) {
        body = item.overview.trim();
      } else if (item.abstract) {
        body = item.abstract.trim();
      } else {
        continue; // Skip items with no usable content
      }

      sections.push(
        `### [${item.context_type}] ${item.uri} (relevance: ${scoreLabel})\n\n${body}`,
      );
    }

    if (sections.length === 0) {
      if (fs.existsSync(contextFile)) fs.unlinkSync(contextFile);
      return;
    }

    const content = [
      `# OpenViking Context`,
      `*Retrieved for: "${query.slice(0, 120)}"*`,
      '',
      ...sections,
    ].join('\n\n');

    fs.writeFileSync(contextFile, content, 'utf-8');
    logger.debug(
      { group: groupFolder, items: sections.length },
      'OpenViking context written',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    if (!isTimeout) {
      logger.debug(
        { err: message },
        'OpenViking context fetch skipped (server may not be running)',
      );
    }
    if (fs.existsSync(contextFile)) fs.unlinkSync(contextFile);
  }
}
