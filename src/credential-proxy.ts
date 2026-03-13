/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Model switching:
 *   POST /model-switch  {"model": "<name>"}  — switches active model live,
 *   no restart required. Config persisted to model-config.json.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

interface ModelEntry {
  description: string;
  baseUrl: string;
  authMode: AuthMode;
  envKey: string;
  model?: string; // If set, overrides the model field in proxied request bodies
}

interface ModelConfig {
  active: string;
  models: Record<string, ModelEntry>;
}

const MODEL_CONFIG_PATH = path.join(process.cwd(), 'model-config.json');

function readModelConfig(): ModelConfig | null {
  try {
    return JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8')) as ModelConfig;
  } catch {
    return null;
  }
}

function writeModelConfig(config: ModelConfig): void {
  fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function resolveCredentials(): {
  upstreamUrl: URL;
  authMode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
  modelOverride?: string;
} {
  const modelConfig = readModelConfig();
  const activeKey = modelConfig?.active ?? 'claude';
  const activeModel = modelConfig?.models[activeKey];

  // Load all possible secret keys from .env
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'MINIMAX_API_KEY',
  ]);

  // If model-config.json is present and has a valid active model, use it
  if (activeModel) {
    const resolvedUrl = new URL(activeModel.baseUrl);
    const resolvedApiKey = secrets[activeModel.envKey];

    if (activeModel.authMode === 'api-key') {
      return {
        upstreamUrl: resolvedUrl,
        authMode: 'api-key',
        apiKey: resolvedApiKey,
        modelOverride: activeModel.model,
      };
    } else {
      return {
        upstreamUrl: resolvedUrl,
        authMode: 'oauth',
        oauthToken: secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN,
        modelOverride: activeModel.model,
      };
    }
  }

  // Fallback: original behaviour (reads ANTHROPIC_BASE_URL from .env)
  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  return {
    upstreamUrl: new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
    authMode,
    apiKey: secrets.ANTHROPIC_API_KEY,
    oauthToken: secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN,
  };
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Log the starting model
  const initialConfig = readModelConfig();
  logger.info({ model: initialConfig?.active ?? 'claude (fallback)' }, 'Credential proxy model');

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // ── Model switch endpoint ──────────────────────────────────────────────
      if (req.method === 'POST' && req.url === '/model-switch') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { model?: string };
            const modelConfig = readModelConfig();

            if (!modelConfig) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'model-config.json not found' }));
              return;
            }

            const requested = body.model?.trim();
            if (!requested || !modelConfig.models[requested]) {
              const available = Object.keys(modelConfig.models);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Unknown model. Available: ${available.join(', ')}` }));
              return;
            }

            const previous = modelConfig.active;
            modelConfig.active = requested;
            writeModelConfig(modelConfig);

            logger.info({ from: previous, to: requested }, 'Model switched');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              previous,
              active: requested,
              description: modelConfig.models[requested].description,
            }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          }
        });
        return;
      }

      // ── Model status endpoint ──────────────────────────────────────────────
      if (req.method === 'GET' && req.url === '/model-status') {
        const modelConfig = readModelConfig();
        const active = modelConfig?.active ?? 'unknown';
        const model = modelConfig?.models[active];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          active,
          description: model?.description ?? 'unknown',
          available: modelConfig ? Object.entries(modelConfig.models).map(([k, v]) => ({
            id: k,
            description: v.description,
          })) : [],
        }));
        return;
      }

      // ── Proxy all other requests to the upstream API ───────────────────────
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);

        // Resolve credentials fresh on every request (hot-reload)
        const { upstreamUrl, authMode, apiKey, oauthToken, modelOverride } = resolveCredentials();
        const isHttps = upstreamUrl.protocol === 'https:';
        const makeRequest = isHttps ? httpsRequest : httpRequest;

        // Rewrite model field in request body if the active model specifies an override.
        // Claude Code always sends a Claude model name; non-Anthropic providers need
        // their own model ID (e.g. OpenRouter's "google/gemini-3-flash-preview").
        if (modelOverride && req.method === 'POST' && body.length > 0) {
          const ct = (req.headers['content-type'] ?? '') as string;
          if (ct.includes('application/json')) {
            try {
              const parsed = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
              if ('model' in parsed) {
                parsed['model'] = modelOverride;
                body = Buffer.from(JSON.stringify(parsed), 'utf-8');
              }
            } catch {
              // Not valid JSON — forward as-is
            }
          }
        }

        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = apiKey;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const modelConfig = readModelConfig();
  const active = modelConfig?.active;
  const model = active ? modelConfig?.models[active] : undefined;
  if (model) return model.authMode;
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
