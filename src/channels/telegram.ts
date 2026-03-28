import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MessageOptions,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  assistantName?: string;
  triggerPattern?: RegExp;
}

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

/**
 * Extract the numeric Telegram chat ID from a JID.
 * Handles:
 *   tg:{chatId}                    → chatId
 *   tg:{tenantId}:{chatId}         → chatId
 *   tg:{chatId}:topic:{topicId}    → chatId
 */
export function parseTelegramChatId(jid: string): string {
  const stripped = jid.replace(/^tg:/, '');
  // Topic format: {chatId}:topic:{topicId} — chatId is before ":topic:"
  if (stripped.includes(':topic:')) {
    return stripped.split(':topic:')[0];
  }
  // Tenant format: {tenantId}:{chatId} — chatId is after the first ":"
  const colonIdx = stripped.indexOf(':');
  if (colonIdx !== -1) {
    return stripped.slice(colonIdx + 1);
  }
  // Plain: just the chatId
  return stripped;
}

/**
 * Extract the topic ID from a JID, if present.
 * Returns undefined for non-topic JIDs.
 */
export function parseTelegramTopicId(jid: string): number | undefined {
  const match = jid.match(/:topic:(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

// ---------------------------------------------------------------------------
// File download helpers
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'pdf',
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

/** Strip directory components and dangerous characters from a filename. */
function sanitizeFilename(name: string): string {
  // Remove any path separators, null bytes, and leading dots
  return path
    .basename(name)
    .replace(/[^\w.\-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200);
}

/** Return the lowercased extension without the leading dot, or '' if none. */
function getExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

/**
 * Download a file from Telegram and save it to the group's attachments folder.
 *
 * Returns the relative path `attachments/{filename}` on success, or null on
 * any failure (size limit exceeded, disallowed extension, network error, etc.).
 *
 * IMPORTANT: The download URL contains the bot token — it is NEVER logged.
 */
async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  groupFolder: string,
  msgId: string,
  originalFilename: string,
): Promise<string | null> {
  try {
    // 1. Ask Telegram for file metadata (path + size)
    const metaUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const meta = await new Promise<any>((resolve, reject) => {
      https
        .get(metaUrl, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        })
        .on('error', reject);
    });

    if (!meta.ok || !meta.result?.file_path) {
      logger.warn(
        { fileId, error: meta.description },
        'Telegram getFile failed',
      );
      return null;
    }

    const filePath: string = meta.result.file_path;
    const fileSize: number | undefined = meta.result.file_size;

    // 2. Enforce size limit
    if (fileSize !== undefined && fileSize > MAX_FILE_SIZE) {
      logger.warn(
        { fileId, fileSize },
        'Telegram file exceeds 20 MB limit, skipping download',
      );
      return null;
    }

    // 3. Enforce extension allowlist using the Telegram file_path (most reliable)
    const ext = getExtension(filePath) || getExtension(originalFilename);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      logger.warn({ fileId, ext }, 'Telegram file extension not allowed');
      return null;
    }

    // 4. Build destination path
    const sanitizedName = sanitizeFilename(originalFilename);
    const destFilename = `${msgId}-${sanitizedName}`;
    const attachmentsDir = path.join(GROUPS_DIR, groupFolder, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const destPath = path.join(attachmentsDir, destFilename);

    // 5. Download — URL contains the bot token, never log it
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      https
        .get(downloadUrl, (res) => {
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
          res.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        })
        .on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
    });

    // Verify downloaded file size (file_size from Telegram metadata is optional)
    const stat = fs.statSync(destPath);
    if (stat.size > MAX_FILE_SIZE) {
      logger.warn({ fileId, size: stat.size }, 'Downloaded file exceeds size limit');
      fs.unlinkSync(destPath);
      return null;
    }

    return `attachments/${destFilename}`;
  } catch (err) {
    logger.warn(
      { fileId, err: (err as Error).message },
      'Failed to download Telegram file',
    );
    return null;
  }
}

export class TelegramChannel implements Channel {
  name: string;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private managedJids = new Set<string>();
  private tenantId: string | null = null;

  constructor(
    botToken: string,
    opts: TelegramChannelOpts,
    instanceName?: string,
    tenantId?: string,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.name = instanceName ?? 'telegram';
    this.tenantId = tenantId ?? null;
  }

  /**
   * Construct a JID for a Telegram chat.
   * DMs with tenantId: tg:{tenantId}:{chatId}
   * Group topics: tg:{chatId}:topic:{topicId}
   * Groups (no topic) and non-tenant: tg:{chatId}
   */
  private buildJid(chatId: number, chatType: string, topicId?: number): string {
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    if (isGroup && topicId) {
      return `tg:${chatId}:topic:${topicId}`;
    }
    if (this.tenantId && !isGroup) {
      return `tg:${this.tenantId}:${chatId}`;
    }
    return `tg:${chatId}`;
  }

  private get assistantName(): string {
    return this.opts.assistantName ?? ASSISTANT_NAME;
  }

  private get triggerPattern(): RegExp {
    return this.opts.triggerPattern ?? TRIGGER_PATTERN;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: {
          agent: new https.Agent({ keepAlive: true, family: 4 }),
          compress: true,
        },
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
      const topicId = ctx.message?.message_thread_id;

      let info = `Chat ID: \`${this.buildJid(chatId, chatType)}\`\nName: ${chatName}\nType: ${chatType}`;
      if (topicId) {
        info += `\nTopic ID: \`${topicId}\``;
      }
      ctx.reply(info, { parse_mode: 'Markdown' });
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${this.assistantName} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const topicId = ctx.message.message_thread_id;
      const chatJid = this.buildJid(ctx.chat.id, ctx.chat.type, topicId);
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
        if (isBotMentioned && !this.triggerPattern.test(content)) {
          content = `@${this.assistantName} ${content}`;
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
        topic_id: topicId,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const topicId = ctx.message?.message_thread_id;
      const chatJid = this.buildJid(ctx.chat.id, ctx.chat.type, topicId);
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
        topic_id: topicId,
      });
    };

    /**
     * Download a photo or document and store it; fall back to placeholder on
     * any failure. Only called for photo and document message types.
     */
    const downloadAndStore = async (
      ctx: any,
      fileId: string,
      originalFilename: string,
      fallbackPlaceholder: string,
    ): Promise<void> => {
      const topicId = ctx.message?.message_thread_id;
      const chatJid = this.buildJid(ctx.chat.id, ctx.chat.type, topicId);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const msgId = ctx.message.message_id.toString();
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

      // Attempt download
      const relativePath = await downloadTelegramFile(
        this.botToken,
        fileId,
        group.folder,
        msgId,
        originalFilename,
      );

      const content = relativePath
        ? `[File: ${relativePath}]${caption}`
        : `${fallbackPlaceholder}${caption}`;

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        topic_id: topicId,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      // Photos have no filename — fabricate one from message id
      const filename = `photo_${ctx.message.message_id}.jpg`;
      await downloadAndStore(ctx, largest.file_id, filename, '[Photo]');
    });

    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const filename = doc?.file_name || `document_${ctx.message.message_id}`;
      await downloadAndStore(
        ctx,
        doc.file_id,
        filename,
        `[Document: ${doc?.file_name || 'file'}]`,
      );
    });

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
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

  async sendMessage(
    jid: string,
    text: string,
    options?: MessageOptions,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = parseTelegramChatId(jid);
      // Extract topic from JID or from explicit options
      const jidTopicId = parseTelegramTopicId(jid);
      const effectiveTopicId = options?.topicId ?? jidTopicId;
      const sendOpts = effectiveTopicId
        ? { message_thread_id: effectiveTopicId }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, sendOpts);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            sendOpts,
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

  addManagedJid(jid: string): void {
    this.managedJids.add(jid);
  }

  ownsJid(jid: string): boolean {
    if (this.managedJids.size > 0) return this.managedJids.has(jid);
    return jid.startsWith('tg:'); // backward compat for single-tenant
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
      const numericId = parseTelegramChatId(jid);
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

export function createTenantTelegramChannel(
  botToken: string,
  opts: TelegramChannelOpts,
  tenantId: string,
): TelegramChannel {
  return new TelegramChannel(botToken, opts, `telegram:${tenantId}`, tenantId);
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
