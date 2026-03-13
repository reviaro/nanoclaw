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
import { gunzip } from 'zlib';
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
  bearerAuth?: boolean; // If true, use Authorization: Bearer <key> instead of x-api-key
}

interface ModelConfig {
  active: string;
  models: Record<string, ModelEntry>;
}

const MODEL_CONFIG_PATH = path.join(process.cwd(), 'model-config.json');

function readModelConfig(): ModelConfig | null {
  try {
    return JSON.parse(
      fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8'),
    ) as ModelConfig;
  } catch {
    return null;
  }
}

function writeModelConfig(config: ModelConfig): void {
  fs.writeFileSync(
    MODEL_CONFIG_PATH,
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );
}

function resolveCredentials(): {
  upstreamUrl: URL;
  authMode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
  modelOverride?: string;
  bearerAuth?: boolean;
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
    'OPENROUTER_API_KEY',
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
        bearerAuth: activeModel.bearerAuth,
      };
    } else {
      return {
        upstreamUrl: resolvedUrl,
        authMode: 'oauth',
        oauthToken:
          secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN,
        modelOverride: activeModel.model,
      };
    }
  }

  // Fallback: original behaviour (reads ANTHROPIC_BASE_URL from .env)
  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  return {
    upstreamUrl: new URL(
      secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ),
    authMode,
    apiKey: secrets.ANTHROPIC_API_KEY,
    oauthToken: secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN,
  };
}

/**
 * Convert a buffered Anthropic-format JSON response to properly-ordered SSE.
 * Used for bearerAuth providers (e.g. OpenRouter) whose streaming SSE can
 * have interleaved content blocks that confuse the Claude Code SDK.
 */
function anthropicJsonToSSE(json: Record<string, unknown>): string {
  const lines: string[] = [];
  const emit = (event: string, data: unknown) => {
    lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push('');
  };

  const usage = (json['usage'] as Record<string, unknown> | undefined) ?? {};
  emit('message_start', {
    type: 'message_start',
    message: {
      id: json['id'] ?? '',
      type: 'message',
      role: 'assistant',
      content: [],
      model: json['model'] ?? '',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage['input_tokens'] ?? 0, output_tokens: 0 },
    },
  });

  const contents = (json['content'] as Array<Record<string, unknown>>) ?? [];
  contents.forEach((block, index) => {
    const type = block['type'] as string;
    if (type === 'text') {
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block['text'] ?? '' },
      });
      emit('content_block_stop', { type: 'content_block_stop', index });
    } else if (type === 'thinking') {
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      });
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block['thinking'] ?? '' },
      });
      emit('content_block_stop', { type: 'content_block_stop', index });
    }
    // redacted_thinking and other non-standard types are skipped
  });

  emit('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: json['stop_reason'] ?? 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: usage['output_tokens'] ?? 0 },
  });
  emit('message_stop', { type: 'message_stop' });

  return lines.join('\n') + '\n';
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Log the starting model
  const initialConfig = readModelConfig();
  logger.info(
    { model: initialConfig?.active ?? 'claude (fallback)' },
    'Credential proxy model',
  );

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // ── OAuth token exchange for api-key providers ─────────────────────────
      // Claude Code always does an OAuth exchange first. For non-Anthropic
      // api-key providers the exchange URL doesn't exist, so we return a
      // synthetic response so Claude Code can proceed to /v1/messages.
      if (
        req.method === 'POST' &&
        req.url === '/api/oauth/claude_cli/create_api_key'
      ) {
        const { authMode } = resolveCredentials();
        if (authMode === 'api-key') {
          // Drain request body then return a fake API key
          req.resume();
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ api_key: 'proxy-managed-do-not-use' }),
            );
          });
          return;
        }
      }

      // ── Model switch endpoint ──────────────────────────────────────────────
      if (req.method === 'POST' && req.url === '/model-switch') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(
              Buffer.concat(chunks).toString('utf-8'),
            ) as { model?: string };
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
              res.end(
                JSON.stringify({
                  error: `Unknown model. Available: ${available.join(', ')}`,
                }),
              );
              return;
            }

            const previous = modelConfig.active;
            modelConfig.active = requested;
            writeModelConfig(modelConfig);

            logger.info({ from: previous, to: requested }, 'Model switched');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                previous,
                active: requested,
                description: modelConfig.models[requested].description,
              }),
            );
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
        res.end(
          JSON.stringify({
            active,
            description: model?.description ?? 'unknown',
            available: modelConfig
              ? Object.entries(modelConfig.models).map(([k, v]) => ({
                  id: k,
                  description: v.description,
                }))
              : [],
          }),
        );
        return;
      }

      // ── Proxy all other requests to the upstream API ───────────────────────
      logger.debug({ method: req.method, url: req.url }, 'Proxy request received');
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);

        // Resolve credentials fresh on every request (hot-reload)
        const {
          upstreamUrl,
          authMode,
          apiKey,
          oauthToken,
          modelOverride,
          bearerAuth,
        } = resolveCredentials();
        const isHttps = upstreamUrl.protocol === 'https:';
        const makeRequest = isHttps ? httpsRequest : httpRequest;

        // Rewrite model field in request body if the active model specifies an override.
        // Claude Code always sends a Claude model name; non-Anthropic providers need
        // their own model ID (e.g. OpenRouter's "openrouter/hunter-alpha").
        // For bearerAuth providers, also strip `stream: true` — their streaming SSE
        // format can be non-compliant (interleaved content blocks). We buffer the
        // JSON response and re-emit it as properly-ordered Anthropic SSE instead.
        let stripStream = false;
        if (req.method === 'POST' && body.length > 0) {
          const ct = (req.headers['content-type'] ?? '') as string;
          if (ct.includes('application/json')) {
            try {
              const parsed = JSON.parse(body.toString('utf-8')) as Record<
                string,
                unknown
              >;
              if (modelOverride && 'model' in parsed) {
                parsed['model'] = modelOverride;
              }
              if (bearerAuth && parsed['stream'] === true) {
                delete parsed['stream'];
                stripStream = true;
              }
              body = Buffer.from(JSON.stringify(parsed), 'utf-8');
            } catch {
              // Not valid JSON — forward as-is
            }
          }
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
            // If we stripped stream, accept JSON instead of SSE
            accept: stripStream ? 'application/json' : (req.headers['accept'] as string | undefined) ?? '*/*',
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // Always strip both auth headers first to avoid sending container's placeholder
          delete headers['x-api-key'];
          delete headers['authorization'];
          if (bearerAuth) {
            headers['authorization'] = `Bearer ${apiKey}`;
          } else {
            headers['x-api-key'] = apiKey;
          }
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // Prepend the upstream base path (e.g. "/anthropic" for MiniMax,
        // "/api" for OpenRouter) to the incoming request path.
        const basePathPrefix = upstreamUrl.pathname.replace(/\/$/, '');
        const forwardPath = basePathPrefix + (req.url || '/');

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: forwardPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            if (!stripStream) {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
              return;
            }

            // Buffer the JSON response and re-emit as Anthropic-compliant SSE
            const respChunks: Buffer[] = [];
            upRes.on('data', (c: Buffer) => respChunks.push(c));
            upRes.on('end', () => {
              const raw = Buffer.concat(respChunks);
              const encoding = upRes.headers['content-encoding'] ?? '';
              const decode = (buf: Buffer, cb: (s: string) => void) => {
                if (encoding === 'gzip' || encoding === 'br' || buf[0] === 0x1f) {
                  gunzip(buf, (err, result) => cb(err ? buf.toString('utf-8') : result.toString('utf-8')));
                } else {
                  cb(buf.toString('utf-8'));
                }
              };
              decode(raw, (text) => {
              try {
                const json = JSON.parse(text) as Record<string, unknown>;

                if (upRes.statusCode !== 200 || json['error']) {
                  // Pass errors through as-is
                  res.writeHead(upRes.statusCode!, {
                    'content-type': 'application/json',
                  });
                  res.end(JSON.stringify(json));
                  return;
                }

                const sse = anthropicJsonToSSE(json);
                res.writeHead(200, {
                  'content-type': 'text/event-stream',
                  'cache-control': 'no-cache',
                  connection: 'keep-alive',
                });
                res.end(sse);
              } catch (err) {
                logger.error({ err }, 'Failed to convert response to SSE');
                if (!res.headersSent) {
                  res.writeHead(502);
                  res.end('Bad Gateway');
                }
              }
              }); // decode callback
            });
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
