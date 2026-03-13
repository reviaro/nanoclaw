import https from 'https';
import fs from 'fs';
import path from 'path';
import { Api, Bot, InlineKeyboard } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts, SessionStatus } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export type TelegramChannelOpts = ChannelOpts;

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // /help — list all available commands
    this.bot.command('help', (ctx) => {
      ctx.reply(
        `*${ASSISTANT_NAME} commands*\n\n` +
        `/ping — check bot is online\n` +
        `/status — session info and active model\n` +
        `/models — view and switch AI model\n` +
        `/new — start a fresh session\n` +
        `/reset — same as /new\n` +
        `/compact — compress context to save tokens\n` +
        `/chatid — show this chat's registration ID`,
        { parse_mode: 'Markdown' },
      );
    });

    // /status — show session, model, uptime
    this.bot.command('status', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const status: SessionStatus | null = this.opts.onGetStatus
        ? this.opts.onGetStatus(chatJid)
        : null;

      if (!status) {
        ctx.reply('This chat is not registered.');
        return;
      }

      const uptime = status.uptimeSeconds;
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const uptimeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

      ctx.reply(
        `*${ASSISTANT_NAME} status*\n\n` +
        `Model: \`${status.model}\`\n` +
        `Session: ${status.hasSession ? '✓ active' : '○ none'}\n` +
        `Uptime: ${uptimeStr}\n` +
        `Group: ${status.groupName}`,
        { parse_mode: 'Markdown' },
      );
    });

    // /new and /reset — clear the current session
    const handleReset = (ctx: any) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (this.opts.onResetSession) {
        this.opts.onResetSession(chatJid);
        ctx.reply('Session cleared. Next message starts a fresh conversation.');
      } else {
        ctx.reply('Reset not available.');
      }
    };
    this.bot.command('new', handleReset);
    this.bot.command('reset', handleReset);

    // /compact — compress context to save tokens
    this.bot.command('compact', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (this.opts.onCompact) {
        this.opts.onCompact(chatJid);
        ctx.reply('Compacting context… I\'ll let you know when done.');
      } else {
        ctx.reply('Compact not available.');
      }
    });

    // /models — view and switch AI model
    this.bot.command('models', (ctx) => {
      const configPath = path.join(process.cwd(), 'model-config.json');
      let config: { active: string; models: Record<string, { description: string }> };
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {
        ctx.reply('Could not read model-config.json');
        return;
      }

      const keyboard = new InlineKeyboard();
      for (const [id, model] of Object.entries(config.models)) {
        const label = id === config.active ? `✓ ${model.description}` : model.description;
        keyboard.text(label, `model:${id}`).row();
      }

      ctx.reply(`*Current model:* ${config.models[config.active]?.description ?? config.active}\n\nSelect a model:`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    });

    // Handle model selection button press
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith('model:')) return;

      const chosen = data.slice('model:'.length);
      const configPath = path.join(process.cwd(), 'model-config.json');
      let config: { active: string; models: Record<string, { description: string }> };
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {
        await ctx.answerCallbackQuery({ text: 'Error reading config' });
        return;
      }

      if (!config.models[chosen]) {
        await ctx.answerCallbackQuery({ text: 'Unknown model' });
        return;
      }

      const previous = config.active;
      config.active = chosen;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

      const description = config.models[chosen].description;
      await ctx.answerCallbackQuery({ text: `Switched to ${description}` });

      // Update the original message to reflect the new active model
      const keyboard = new InlineKeyboard();
      for (const [id, model] of Object.entries(config.models)) {
        const label = id === chosen ? `✓ ${model.description}` : model.description;
        keyboard.text(label, `model:${id}`).row();
      }
      await ctx.editMessageText(
        `*Current model:* ${description}\n\nSelect a model:`,
        { parse_mode: 'Markdown', reply_markup: keyboard },
      );

      logger.info({ from: previous, to: chosen }, 'Model switched via Telegram /models');
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
