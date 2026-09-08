import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { connectDatabase, closeDatabase } from '../services/db';
import { handleOwnerMessage } from './llm-agent';
import { toolGenerateInvoice } from './tools';
import { getLastFinalizedBillId } from './session.service';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is missing from .env');
}

const ownerChatIdRaw = process.env.OWNER_TELEGRAM_CHAT_ID;
const ownerChatId = ownerChatIdRaw ? Number(ownerChatIdRaw) : null;

if (ownerChatIdRaw && !Number.isFinite(ownerChatId)) {
  throw new Error('OWNER_TELEGRAM_CHAT_ID must be a numeric Telegram chat ID');
}

async function main(): Promise<void> {
  await connectDatabase();

  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;

    if (!ownerChatId) {
      console.log(
        `OWNER_TELEGRAM_CHAT_ID is not set. Your Telegram chat ID is: ${chatId}`
      );

      await ctx.reply(
        'Owner chat ID setup is pending. Check the Mac terminal for your chat ID.'
      );

      return;
    }

    if (chatId !== ownerChatId) {
      console.log(
        `Blocked message from unauthorized chat ID: ${chatId ?? 'unknown'}`
      );

      await ctx.reply('Sorry, this bot is private.');

      return;
    }

    return next();
  });

  bot.start(async (ctx) => {
    await ctx.reply(
      [
        'Hello! I am your supermarket operations assistant.',
        '',
        'You can send natural messages such as:',
        '- 2 maggi add pannu',
        '- Ramesh ku bill podu',
        '- Current bill kaatu',
        '- Ramesh balance enna',
        '- Or paste product UUID directly'
      ].join('\n')
    );
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    try {
      /*
       * PDF / Invoice request
       *
       * Generate the PDF directly and upload the actual
       * PDF file to Telegram.
       */
      const normalizedText = text.toLowerCase();

      if (
        normalizedText.includes('pdf') ||
        normalizedText.includes('invoice')
      ) {
        const billId = getLastFinalizedBillId(chatId);

        if (!billId) {
          await ctx.reply(
            'No finalized bill found. Please finalize a bill first.'
          );

          return;
        }

        const pdfBuffer = await toolGenerateInvoice(billId);

        await ctx.telegram.sendDocument(chatId, {
          source: pdfBuffer,
          filename: `invoice-${billId.slice(0, 8)}.pdf`
        });

        return;
      }

      /*
       * Product UUID selection
       *
       * If the owner sends a UUID directly, pass it
       * to the same LLM agent.
       */
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (uuidRegex.test(text.trim())) {
        const reply = await handleOwnerMessage(
          chatId,
          `SELECT_PRODUCT:${text.trim()}`
        );

        await ctx.reply(reply);

        return;
      }

      /*
       * All normal natural-language messages go through
       * the LLM agent.
       */
      const reply = await handleOwnerMessage(chatId, text);
      /*
 * generate_analysis_deck returns JSON containing pptxBase64.
 * Send the generated PPTX as a real Telegram document.
 */
if (
  reply.includes('"pptxBase64"') ||
  reply.includes('pptxBase64')
) {
  try {
    const data = JSON.parse(reply);

    if (data.pptxBase64 && data.fileName) {
      const buffer = Buffer.from(
        data.pptxBase64,
        'base64'
      );

      await ctx.telegram.sendDocument(chatId, {
        source: buffer,
        filename: data.fileName
      });

      return;
    }
  } catch (error) {
    console.error(
      'PPTX response parsing error:',
      error
    );
  }
}

      /*
       * generate_invoice returns JSON containing pdfBase64.
       * If it somehow reaches here, send it as a real
       * Telegram document instead of showing Base64/text.
       */
      if (
        reply.includes('"pdfBase64"') ||
        reply.includes('pdfBase64')
      ) {
        try {
          const data = JSON.parse(reply);

          if (data.pdfBase64 && data.fileName) {
            const buffer = Buffer.from(data.pdfBase64, 'base64');

            await ctx.telegram.sendDocument(chatId, {
              source: buffer,
              filename: data.fileName
            });

            return;
          }
        } catch (error) {
          console.error('PDF response parsing error:', error);
        }
      }

      await ctx.reply(reply);
    } catch (error: unknown) {
      console.error('Message processing error:', error);

      await ctx.reply(
        'Sorry, I could not process that request safely. Please try again.'
      );
    }
  });

  void bot.launch();

  console.log('Telegram LLM agent started.');
}

main().catch((error) => {
  console.error('Failed to start Telegram agent:', error);
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Stopping due to ${signal}`);

  await closeDatabase();

  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});