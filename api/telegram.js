// Vercel Serverless Function — Telegram Webhook
// Handles /spend and /deposit commands, writing directly to Supabase
// in the same JSON schema used by finance.html (liq:*, nw:activity, nw:history).

const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config — Supabase credentials fall back to the values already in sync.js
// so the function works without extra env vars, but you can override them.
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL  || 'https://zpgaszuggbbkdgvpqleb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_I1qootQsE-UnHOV_omm9GQ_FK5whBcE';
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_UID  = String(process.env.TELEGRAM_USER_ID || '');

// Must match initCloudSync({ appKey: 'finance', ... }) in finance.html
const APP_KEY        = 'finance';
const ACTIVITY_MAX   = 50;
const NW_HISTORY_MAX = 500;
const NW_CATS        = ['stocks', 'crypto', 'other'];

// Mirrors LIQ_ACCOUNTS in finance.html
const ACCOUNTS = {
  cash:   { label: 'Cash',   isLiability: false },
  chase:  { label: 'Chase',  isLiability: false },
  credit: { label: 'Credit', isLiability: true  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

// Returns how many USD = 1 CHF (the internal base unit).
// Falls back to 1 (1:1) if the rate API is unavailable.
async function getUsdPerChf() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CHF', {
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    return data?.rates?.USD ?? 1;
  } catch {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const message = req.body?.message;
  if (!message?.text) return res.status(200).json({ ok: true });

  const senderId = String(message.from?.id ?? '');
  const chatId   = message.chat?.id;

  // Security: silently ignore messages from anyone other than the owner
  if (senderId !== ALLOWED_UID) return res.status(200).json({ ok: true });

  const text = message.text.trim();

  // Parse: /(spend|deposit) (cash|chase|credit) <amount> <description…>
  const m = text.match(/^\/?(spend|deposit)\s+(cash|chase|credit)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (!m) {
    await sendTelegramMessage(
      chatId,
      '❓ *Format:* `/spend chase 15.50 chipotle` or `/deposit cash 20 atm`\n' +
      'Accounts: `cash` · `chase` · `credit`'
    );
    return res.status(200).json({ ok: true });
  }

  const [, action, rawAcct, amountStr, description] = m;
  const acctKey  = rawAcct.toLowerCase();
  const account  = ACCOUNTS[acctKey];
  const amountUsd = parseFloat(amountStr);

  if (!account || isNaN(amountUsd) || amountUsd <= 0) {
    await sendTelegramMessage(chatId, '❌ Invalid amount or account.');
    return res.status(200).json({ ok: true });
  }

  // Convert USD → internal CHF base unit
  const usdRate   = await getUsdPerChf();      // e.g. 1.10 means 1 CHF = $1.10
  const amountBase = amountUsd / usdRate;

  // Fetch current state
  const supa = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: row, error: fetchErr } = await supa
    .from('app_state')
    .select('data')
    .eq('key', APP_KEY)
    .maybeSingle();

  if (fetchErr || !row) {
    await sendTelegramMessage(chatId, '❌ Could not fetch your data. Please try again.');
    return res.status(200).json({ ok: true });
  }

  const state   = Object.assign({}, row.data ?? {});
  const liqKey  = `liq:${acctKey}`;
  const currentBal = typeof state[liqKey] === 'number' ? state[liqKey] : 0;

  // -------------------------------------------------------------------------
  // Balance math — mirrors applyDelta() in finance.html:
  //
  //   Assets  (cash/chase):  deposit → balance up,  spend → balance down
  //   Liability (credit):    spend   → balance up (more debt),
  //                          deposit → balance down (pay off)
  //
  // `delta` = net change applied to the account balance.
  // The delete/undo function in the UI reverses it via: bal - delta.
  // -------------------------------------------------------------------------
  const isDeposit = action.toLowerCase() === 'deposit';
  let newBal, delta;

  if (account.isLiability) {
    if (!isDeposit) {                             // /spend credit → debt increases
      newBal = currentBal + amountBase;
      delta  = amountBase;
    } else {                                      // /deposit credit → pay off
      newBal = Math.max(0, currentBal - amountBase);
      delta  = -(currentBal - newBal);
    }
  } else {
    if (isDeposit) {                              // /deposit cash|chase → balance up
      newBal = currentBal + amountBase;
      delta  = amountBase;
    } else {                                      // /spend cash|chase → balance down
      newBal = Math.max(0, currentBal - amountBase);
      delta  = -(currentBal - newBal);
    }
  }
  state[liqKey] = newBal;

  // -------------------------------------------------------------------------
  // Append activity entry — matches logActivity() schema in finance.html:
  //   { ts, cat, name, delta, kind }
  // -------------------------------------------------------------------------
  const activity = Array.isArray(state['nw:activity']) ? [...state['nw:activity']] : [];
  activity.push({ ts: Date.now(), cat: acctKey, name: description, delta, kind: 'add' });
  if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
  state['nw:activity'] = activity;

  // -------------------------------------------------------------------------
  // Recalculate net worth — matches renderAllNetWorth() in finance.html:
  //   grand = cash + chase - credit + sum(nw:stocks + nw:crypto + nw:other)
  // -------------------------------------------------------------------------
  const cash   = typeof state['liq:cash']   === 'number' ? state['liq:cash']   : 0;
  const chase  = typeof state['liq:chase']  === 'number' ? state['liq:chase']  : 0;
  const credit = typeof state['liq:credit'] === 'number' ? state['liq:credit'] : 0;
  let catSum = 0;
  for (const cat of NW_CATS) {
    const items = Array.isArray(state[`nw:${cat}`]) ? state[`nw:${cat}`] : [];
    for (const item of items) catSum += typeof item.amount === 'number' ? item.amount : 0;
  }
  const netWorthBase = cash + chase - credit + catSum;

  // Append NW history snapshot — matches logNetWorthSnapshot() in finance.html:
  //   { t, v }  (only appended when value has meaningfully changed)
  const hist = Array.isArray(state['nw:history']) ? [...state['nw:history']] : [];
  const lastSnap = hist[hist.length - 1];
  if (!lastSnap || Math.abs((lastSnap.v ?? 0) - netWorthBase) >= 0.005) {
    hist.push({ t: Date.now(), v: netWorthBase });
    if (hist.length > NW_HISTORY_MAX) hist.splice(0, hist.length - NW_HISTORY_MAX);
  }
  state['nw:history'] = hist;

  // Save back
  const { error: saveErr } = await supa
    .from('app_state')
    .upsert(
      { key: APP_KEY, data: state, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

  if (saveErr) {
    await sendTelegramMessage(chatId, '❌ Failed to save. Please try again.');
    return res.status(200).json({ ok: true });
  }

  // -------------------------------------------------------------------------
  // Confirmation reply (convert base → USD for display)
  // -------------------------------------------------------------------------
  const newBalUsd = newBal * usdRate;
  const nwUsd     = netWorthBase * usdRate;

  const reply = isDeposit
    ? `✅ Deposited $${amountUsd.toFixed(2)} (${description}) to ${account.label}. New ${account.label} Balance: $${newBalUsd.toFixed(2)}\n📊 Net Worth: $${nwUsd.toFixed(2)}`
    : `✅ Spent $${amountUsd.toFixed(2)} on ${description} from ${account.label}. New ${account.label} Balance: $${newBalUsd.toFixed(2)}\n📊 Net Worth: $${nwUsd.toFixed(2)}`;

  await sendTelegramMessage(chatId, reply);
  return res.status(200).json({ ok: true });
};
