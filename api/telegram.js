// Vercel Serverless Function — Telegram Webhook
//
// Three interaction modes:
//   1. Fast-path text:  /spend chase 15.50 chipotle
//   2. Inline menu:     /start or /finance → account buttons → action buttons
//   3. ForceReply:      bot asks for amount+desc, reads context back from its own prompt

const { createClient } = require('@supabase/supabase-js');

// ─── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL      || 'https://zpgaszuggbbkdgvpqleb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_I1qootQsE-UnHOV_omm9GQ_FK5whBcE';
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_UID  = String(process.env.TELEGRAM_USER_ID || '');

const APP_KEY        = 'finance';   // matches initCloudSync({ appKey: 'finance' })
const ACTIVITY_MAX   = 50;
const NW_HISTORY_MAX = 500;
const NW_CATS        = ['stocks', 'crypto', 'other'];

const ACCOUNTS = {
  cash:   { label: 'Cash',   icon: '💵', isLiability: false },
  chase:  { label: 'Chase',  icon: '🏦', isLiability: false },
  credit: { label: 'Credit', icon: '💳', isLiability: true  },
};

// ─── Telegram API helpers ─────────────────────────────────────────────────────

async function telegramPost(method, body) {
  if (!BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Send a new message. Pass `extra` to add reply_markup, disable_notification, etc.
function sendMessage(chatId, text, extra = {}) {
  return telegramPost('sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown', ...extra,
  });
}

// Replace the text (and optionally keyboard) of an existing inline message.
function editMessageText(chatId, messageId, text, replyMarkup) {
  return telegramPost('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// Must be called for every callback_query within 30 s to dismiss the spinner.
function answerCallbackQuery(cqId, text = '') {
  return telegramPost('answerCallbackQuery', { callback_query_id: cqId, text });
}

// ─── Menu markup builders ─────────────────────────────────────────────────────

function accountMenuMarkup() {
  return {
    inline_keyboard: [[
      { text: '💵 Cash',   callback_data: 'acc_cash'   },
      { text: '🏦 Chase',  callback_data: 'acc_chase'  },
      { text: '💳 Credit', callback_data: 'acc_credit' },
    ]],
  };
}

function actionMenuMarkup(acctKey) {
  return {
    inline_keyboard: [
      [
        { text: '⬆️ Deposit', callback_data: `op_dep_${acctKey}` },
        { text: '⬇️ Spend',   callback_data: `op_sp_${acctKey}`  },
      ],
      [
        { text: '← Back to accounts', callback_data: 'back_accounts' },
      ],
    ],
  };
}

// ─── Exchange rate ─────────────────────────────────────────────────────────────

// Returns USD per CHF (the internal base unit). Falls back to 1:1.
async function getUsdPerChf() {
  try {
    const res  = await fetch('https://open.er-api.com/v6/latest/CHF', {
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    return data?.rates?.USD ?? 1;
  } catch {
    return 1;
  }
}

// ─── Core Supabase transaction ────────────────────────────────────────────────
//
// Fetches the current app_state, applies the balance change, logs the activity
// entry, recalculates net worth, appends a history snapshot, and saves back.
// Returns { newBal, netWorth, account } (all USD) on success, or null on error.

async function applyTransaction(acctKey, action, amountUsd, description) {
  const account    = ACCOUNTS[acctKey];
  const usdRate    = await getUsdPerChf();
  const amountBase = amountUsd / usdRate;
  const isDeposit  = action === 'deposit';

  const supa = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: row, error: fetchErr } = await supa
    .from('app_state').select('data').eq('key', APP_KEY).maybeSingle();
  if (fetchErr || !row) return null;

  const state      = Object.assign({}, row.data ?? {});
  const liqKey     = `liq:${acctKey}`;
  const currentBal = typeof state[liqKey] === 'number' ? state[liqKey] : 0;

  // Balance math — mirrors applyDelta() in finance.html.
  // delta = change applied to the account balance (positive = balance went up).
  // The UI's delete/undo reverses it as: newBal = storedBal - delta.
  let newBal, delta;
  if (account.isLiability) {
    if (!isDeposit) {                              // /spend credit  → debt up
      newBal = currentBal + amountBase;
      delta  = amountBase;
    } else {                                       // /deposit credit → pay off
      newBal = Math.max(0, currentBal - amountBase);
      delta  = -(currentBal - newBal);
    }
  } else {
    if (isDeposit) {                               // /deposit cash|chase → balance up
      newBal = currentBal + amountBase;
      delta  = amountBase;
    } else {                                       // /spend cash|chase   → balance down
      newBal = Math.max(0, currentBal - amountBase);
      delta  = -(currentBal - newBal);
    }
  }
  state[liqKey] = newBal;

  // Activity entry — matches { ts, cat, name, delta, kind } schema in finance.html
  const activity = Array.isArray(state['nw:activity']) ? [...state['nw:activity']] : [];
  activity.push({ ts: Date.now(), cat: acctKey, name: description, delta, kind: 'add' });
  if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
  state['nw:activity'] = activity;

  // Net worth — matches renderAllNetWorth(): cash + chase − credit + cat items
  const cash   = typeof state['liq:cash']   === 'number' ? state['liq:cash']   : 0;
  const chase  = typeof state['liq:chase']  === 'number' ? state['liq:chase']  : 0;
  const credit = typeof state['liq:credit'] === 'number' ? state['liq:credit'] : 0;
  let catSum = 0;
  for (const cat of NW_CATS) {
    const items = Array.isArray(state[`nw:${cat}`]) ? state[`nw:${cat}`] : [];
    for (const item of items) catSum += typeof item.amount === 'number' ? item.amount : 0;
  }
  const netWorthBase = cash + chase - credit + catSum;

  // History snapshot — matches logNetWorthSnapshot(): { t, v }
  const hist     = Array.isArray(state['nw:history']) ? [...state['nw:history']] : [];
  const lastSnap = hist[hist.length - 1];
  if (!lastSnap || Math.abs((lastSnap.v ?? 0) - netWorthBase) >= 0.005) {
    hist.push({ t: Date.now(), v: netWorthBase });
    if (hist.length > NW_HISTORY_MAX) hist.splice(0, hist.length - NW_HISTORY_MAX);
  }
  state['nw:history'] = hist;

  const { error: saveErr } = await supa
    .from('app_state')
    .upsert({ key: APP_KEY, data: state, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (saveErr) return null;

  return { newBal: newBal * usdRate, netWorth: netWorthBase * usdRate, account };
}

// Builds the success confirmation string shared by all three interaction modes.
function buildConfirmation(action, amountUsd, description, account, newBal, netWorth) {
  return action === 'deposit'
    ? `✅ Deposited $${amountUsd.toFixed(2)} (${description}) to ${account.label}. New ${account.label} Balance: $${newBal.toFixed(2)}\n📊 Net Worth: $${netWorth.toFixed(2)}`
    : `✅ Spent $${amountUsd.toFixed(2)} on ${description} from ${account.label}. New ${account.label} Balance: $${newBal.toFixed(2)}\n📊 Net Worth: $${netWorth.toFixed(2)}`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── Inline button press ────────────────────────────────────────────────────
  if (req.body.callback_query) {
    const cq       = req.body.callback_query;
    const senderId = String(cq.from?.id ?? '');
    const chatId   = cq.message?.chat?.id;
    const msgId    = cq.message?.message_id;
    const data     = cq.data ?? '';

    // Security: answer + ignore unauthorized presses
    if (senderId !== ALLOWED_UID) {
      await answerCallbackQuery(cq.id, '⛔ Unauthorized');
      return res.status(200).json({ ok: true });
    }

    // Step 1 — account selected: swap keyboard to Deposit / Spend
    if (data.startsWith('acc_')) {
      const acctKey = data.slice(4);
      const account = ACCOUNTS[acctKey];
      if (!account) { await answerCallbackQuery(cq.id); return res.status(200).json({ ok: true }); }

      await editMessageText(
        chatId, msgId,
        `${account.icon} *${account.label}* selected.\n\nWhat would you like to do?`,
        actionMenuMarkup(acctKey)
      );
      await answerCallbackQuery(cq.id);
      return res.status(200).json({ ok: true });
    }

    // Back arrow — restore the account picker
    if (data === 'back_accounts') {
      await editMessageText(chatId, msgId, '💰 *Finance Tracker*\nChoose an account to update:', accountMenuMarkup());
      await answerCallbackQuery(cq.id);
      return res.status(200).json({ ok: true });
    }

    // Step 2 — action selected: send a ForceReply prompt with embedded context.
    //
    // Context is encoded in plain English so it survives round-trips:
    //   "…to SPEND from CHASE…"  or  "…to DEPOSIT to CASH…"
    // The ForceReply handler below parses this back out with a regex.
    const opMatch = data.match(/^op_(dep|sp)_(.+)$/);
    if (opMatch) {
      const acctKey = opMatch[2];
      const account = ACCOUNTS[acctKey];
      if (!account) { await answerCallbackQuery(cq.id); return res.status(200).json({ ok: true }); }

      const isDep   = opMatch[1] === 'dep';
      const action  = isDep ? 'DEPOSIT' : 'SPEND';
      const prep    = isDep ? 'to' : 'from';
      const example = isDep ? '20 paycheck' : '15.50 chipotle';

      // Dismiss the spinner first, then send the ForceReply in a new message.
      await answerCallbackQuery(cq.id);
      await sendMessage(
        chatId,
        // NOTE: no Markdown here so the plain text is easy to regex when it comes
        // back as reply_to_message.text. Keep the key phrase intact.
        `Reply to this message with the amount and description to ${action} ${prep} ${account.label.toUpperCase()}\n(e.g., ${example})`,
        {
          parse_mode: '',   // plain text — prevents accidental Markdown formatting
          reply_markup: { force_reply: true, selective: true },
        }
      );
      return res.status(200).json({ ok: true });
    }

    // Unknown callback — just dismiss
    await answerCallbackQuery(cq.id);
    return res.status(200).json({ ok: true });
  }

  // ── Text messages ──────────────────────────────────────────────────────────
  const message = req.body.message;
  if (!message?.text) return res.status(200).json({ ok: true });

  const senderId = String(message.from?.id ?? '');
  const chatId   = message.chat?.id;

  if (senderId !== ALLOWED_UID) return res.status(200).json({ ok: true });

  const text = message.text.trim();

  // ── ForceReply response ────────────────────────────────────────────────────
  // Detected when the user replies to one of our ForceReply prompts.
  // Context (action + account) is parsed from the original prompt text.
  if (message.reply_to_message) {
    const promptText = message.reply_to_message.text ?? '';

    // Match "to SPEND from CHASE" or "to DEPOSIT to CASH" (case-insensitive)
    const ctxMatch = promptText.match(/to (SPEND|DEPOSIT) (?:to|from) (CASH|CHASE|CREDIT)/i);
    if (!ctxMatch) return res.status(200).json({ ok: true }); // not our prompt

    const action  = ctxMatch[1].toLowerCase();   // 'spend' | 'deposit'
    const acctKey = ctxMatch[2].toLowerCase();   // 'cash' | 'chase' | 'credit'
    if (!ACCOUNTS[acctKey]) return res.status(200).json({ ok: true });

    // Expect: "15.50 chipotle" or "20 paycheck from work"
    const inputMatch = text.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (!inputMatch) {
      await sendMessage(chatId, '❌ Format: `15.50 chipotle`  (amount then description)');
      return res.status(200).json({ ok: true });
    }

    const amountUsd   = parseFloat(inputMatch[1]);
    const description = inputMatch[2].trim();

    const result = await applyTransaction(acctKey, action, amountUsd, description);
    if (!result) {
      await sendMessage(chatId, '❌ Failed to save. Please try again.');
      return res.status(200).json({ ok: true });
    }

    await sendMessage(chatId, buildConfirmation(action, amountUsd, description, result.account, result.newBal, result.netWorth));
    return res.status(200).json({ ok: true });
  }

  // ── Menu trigger ───────────────────────────────────────────────────────────
  if (/^\/?(start|finance)$/i.test(text)) {
    await sendMessage(chatId, '💰 *Finance Tracker*\nChoose an account to update:', {
      reply_markup: accountMenuMarkup(),
    });
    return res.status(200).json({ ok: true });
  }

  // ── Fast-path text command ─────────────────────────────────────────────────
  // Kept for power-users and Telegram shortcuts.
  // Format: /spend chase 15.50 chipotle
  const m = text.match(/^\/?(spend|deposit)\s+(cash|chase|credit)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (!m) {
    await sendMessage(
      chatId,
      '❓ *Quick commands:*\n`/spend chase 15.50 chipotle`\n`/deposit cash 20 atm`\n`/spend credit 40 gas`\n\nOr tap /finance for the menu.'
    );
    return res.status(200).json({ ok: true });
  }

  const [, action, rawAcct, amountStr, description] = m;
  const acctKey   = rawAcct.toLowerCase();
  const amountUsd = parseFloat(amountStr);

  if (!ACCOUNTS[acctKey] || isNaN(amountUsd) || amountUsd <= 0) {
    await sendMessage(chatId, '❌ Invalid command.');
    return res.status(200).json({ ok: true });
  }

  const result = await applyTransaction(acctKey, action.toLowerCase(), amountUsd, description);
  if (!result) {
    await sendMessage(chatId, '❌ Failed to save. Please try again.');
    return res.status(200).json({ ok: true });
  }

  await sendMessage(chatId, buildConfirmation(action.toLowerCase(), amountUsd, description, result.account, result.newBal, result.netWorth));
  return res.status(200).json({ ok: true });
};
