/* ============================================================
   RPG SERVER — Express + Telegraf + SQLite
   ============================================================ */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const Database = require('better-sqlite3');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в .env');
  process.exit(1);
}

/* ============ БАЗА ДАННЫХ ============ */
const db = new Database('rpg.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id     INTEGER PRIMARY KEY,
    username    TEXT,
    first_name  TEXT,
    save_data   TEXT,
    gold        INTEGER DEFAULT 0,
    updated_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    username    TEXT,
    text        TEXT,
    ts          INTEGER
  );
  CREATE TABLE IF NOT EXISTS trade_lots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id   INTEGER,
    seller_name TEXT,
    item_id     TEXT,
    item_json   TEXT,
    price       INTEGER,
    ts          INTEGER
  );
  CREATE TABLE IF NOT EXISTS referrals (
    inviter_id  INTEGER,
    invited_id  INTEGER UNIQUE,
    ts          INTEGER
  );
  CREATE TABLE IF NOT EXISTS payments (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER,
    chest_id    TEXT,
    amount      INTEGER,
    ts          INTEGER
  );
`);

/* ============ EXPRESS ============ */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============ ПРОВЕРКА TELEGRAM initData ============ */
function verifyTelegram(initData) {
  try {
    if (!initData) return null;
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return null;
    urlParams.delete('hash');
    const dataCheckString = [...urlParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calcHash !== hash) return null;
    const user = JSON.parse(urlParams.get('user') || 'null');
    return user;
  } catch (e) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const initData = req.headers['x-init-data'] || req.body?.initData;
  const user = verifyTelegram(initData);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.tgUser = user;
  next();
}

/* ============ API ============ */

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/save', authMiddleware, (req, res) => {
  try {
    const userId = req.tgUser.id;
    const { saveData, gold, username, firstName } = req.body;
    db.prepare(`
      INSERT INTO users (user_id, username, first_name, save_data, gold, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        save_data = excluded.save_data,
        gold = excluded.gold,
        username = excluded.username,
        updated_at = excluded.updated_at
    `).run(userId, username || '', firstName || '', JSON.stringify(saveData || {}), gold || 0, Date.now());
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'save_failed' });
  }
});

app.get('/api/load', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(req.tgUser.id);
  if (!row) return res.json({ ok: true, data: null });
  res.json({
    ok: true,
    data: {
      saveData: row.save_data ? JSON.parse(row.save_data) : null,
      gold: row.gold
    }
  });
});

app.post('/api/referral', authMiddleware, (req, res) => {
  const invitedId = req.tgUser.id;
  const { inviterId } = req.body;
  if (!inviterId || inviterId === invitedId) return res.json({ ok: false });
  try {
    const insert = db.prepare('INSERT OR IGNORE INTO referrals (inviter_id, invited_id, ts) VALUES (?, ?, ?)');
    const result = insert.run(inviterId, invitedId, Date.now());
    if (result.changes > 0) {
      const row = db.prepare('SELECT save_data FROM users WHERE user_id = ?').get(inviterId);
      if (row && row.save_data) {
        const save = JSON.parse(row.save_data);
        if (save.player) {
          save.player.gold = (save.player.gold || 0) + 500;
          save.player.statPoints = (save.player.statPoints || 0) + 2;
          db.prepare('UPDATE users SET save_data = ? WHERE user_id = ?').run(JSON.stringify(save), inviterId);
        }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

app.get('/api/chat', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM chat_messages ORDER BY id DESC LIMIT 50').all();
  res.json({ ok: true, messages: rows.reverse() });
});

app.post('/api/chat', authMiddleware, (req, res) => {
  const { text } = req.body;
  if (!text || text.length > 200) return res.status(400).json({ error: 'bad_text' });
  const user = req.tgUser;
  const username = '👤 ' + (user.first_name || user.username || 'Игрок');
  db.prepare('INSERT INTO chat_messages (user_id, username, text, ts) VALUES (?, ?, ?, ?)')
    .run(user.id, username, text, Date.now());
  db.prepare('DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 200)').run();
  res.json({ ok: true });
});

app.get('/api/trade', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM trade_lots ORDER BY id DESC LIMIT 50').all();
  res.json({ ok: true, lots: rows });
});

app.post('/api/trade', authMiddleware, (req, res) => {
  const { itemId, itemJson, price } = req.body;
  if (!itemId || !price || price < 1) return res.status(400).json({ error: 'bad_data' });
  const user = req.tgUser;
  const sellerName = '👤 ' + (user.first_name || user.username || 'Игрок');
  db.prepare('INSERT INTO trade_lots (seller_id, seller_name, item_id, item_json, price, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, sellerName, itemId, JSON.stringify(itemJson || {}), price, Date.now());
  res.json({ ok: true });
});

app.post('/api/trade/:id/buy', authMiddleware, (req, res) => {
  const lotId = parseInt(req.params.id);
  const buyerId = req.tgUser.id;
  const lot = db.prepare('SELECT * FROM trade_lots WHERE id = ?').get(lotId);
  if (!lot) return res.json({ ok: false, error: 'lot_not_found' });
  if (lot.seller_id === buyerId) return res.json({ ok: false, error: 'own_lot' });

  const buyer = db.prepare('SELECT save_data FROM users WHERE user_id = ?').get(buyerId);
  const seller = db.prepare('SELECT save_data FROM users WHERE user_id = ?').get(lot.seller_id);
  if (!buyer || !buyer.save_data) return res.json({ ok: false, error: 'no_buyer_save' });
  if (!seller || !seller.save_data) return res.json({ ok: false, error: 'no_seller_save' });

  const buyerSave = JSON.parse(buyer.save_data);
  const sellerSave = JSON.parse(seller.save_data);
  if ((buyerSave.player?.gold || 0) < lot.price) return res.json({ ok: false, error: 'no_gold' });

  const tx = db.transaction(() => {
    buyerSave.player.gold -= lot.price;
    buyerSave.inventory = buyerSave.inventory || [];
    buyerSave.inventory.push({ id: lot.item_id, qty: 1, level: 0 });
    sellerSave.player.gold = (sellerSave.player.gold || 0) + Math.floor(lot.price * 0.95);
    db.prepare('UPDATE users SET save_data = ? WHERE user_id = ?').run(JSON.stringify(buyerSave), buyerId);
    db.prepare('UPDATE users SET save_data = ? WHERE user_id = ?').run(JSON.stringify(sellerSave), lot.seller_id);
    db.prepare('DELETE FROM trade_lots WHERE id = ?').run(lotId);
  });
  try { tx(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: 'tx_failed' }); }
});

app.post('/api/stars/invoice', authMiddleware, async (req, res) => {
  const { chestId } = req.body;
  const prices = { premium: 50, premium2: 100 };
  const amount = prices[chestId];
  if (!amount) return res.status(400).json({ error: 'bad_chest' });
  try {
    const link = await bot.telegram.createInvoiceLink({
      title: '💎 Премиум сундук',
      description: 'Гарантированная легендарка + 5000-15000 золота',
      payload: `chest:${chestId}:${req.tgUser.id}`,
      currency: 'XTR',
      prices: [{ label: 'Премиум сундук', amount }]
    });
    res.json({ ok: true, link });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'invoice_failed' });
  }
});

app.get('/api/stars/pending', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT save_data FROM users WHERE user_id = ?').get(req.tgUser.id);
  if (!row || !row.save_data) return res.json({ ok: false });
  const save = JSON.parse(row.save_data);
  const pending = save.pendingChest;
  if (pending) {
    delete save.pendingChest;
    db.prepare('UPDATE users SET save_data = ? WHERE user_id = ?').run(JSON.stringify(save), req.tgUser.id);
  }
  res.json({ ok: true, pending: pending || null });
});

/* ============ TELEGRAM BOT ============ */
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const payload = ctx.startPayload;
  const keyboard = {
    inline_keyboard: [[
      { text: '🎮 Играть', web_app: { url: WEBAPP_URL } }
    ]]
  };
  ctx.reply(
    '⚔️ Добро пожаловать в RPG!\n\n' +
    (payload ? '👥 Ты пришёл по приглашению!\n' : '') +
    'Нажми кнопку ниже, чтобы начать.',
    { reply_markup: keyboard }
  );
});

bot.command('play', (ctx) => {
  ctx.reply('🎮 Открыть игру:', {
    reply_markup: { inline_keyboard: [[{ text: 'Играть', web_app: { url: WEBAPP_URL } }]] }
  });
});

bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', (ctx) => {
  const payload = ctx.message.successful_payment.invoice_payload;
  const [, chestId, userId] = payload.split(':');
  const uid = parseInt(userId);
  db.prepare('INSERT OR REPLACE INTO payments (id, user_id, chest_id, amount, ts) VALUES (?, ?, ?, ?, ?)')
    .run(payload, uid, chestId, ctx.message.successful_payment.total_amount, Date.now());
  const row = db.prepare('SELECT save_data FROM users WHERE user_id = ?').get(uid);
  if (row && row.save_data) {
    const save = JSON.parse(row.save_data);
    save.player = save.player || {};
    save.player.gold = (save.player.gold || 0) + 8000;
    save.inventory = save.inventory || [];
    save.inventory.push({ id: 's_div', qty: 2, level: 0 });
    save.pendingChest = chestId;
    db.prepare('UPDATE users SET save_data = ? WHERE user_id = ?').run(JSON.stringify(save), uid);
  }
  ctx.reply('💎 Сундук открыт! Зайди в игру и забери награду.');
});

/* ============ START ============ */
bot.launch().then(() => {
  console.log('🤖 Бот запущен');
}).catch((err) => {
  console.error('❌ Ошибка запуска бота (игра всё равно будет работать):', err.message);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер на http://localhost:${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));