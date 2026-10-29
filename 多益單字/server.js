/**
 * TOEIC Vocab Master - Node.js Backend Server
 * 支援 Express 或原生 Node.js HTTP 執行（免安裝套件亦可直接 node server.js 啟動）
 * 資料持久化儲存於 data/db.json 與 data/words.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const WORDS_FILE = path.join(DATA_DIR, 'words.json');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 確保資料夾與資料庫檔案存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hashPassword(password) {
  return crypto
    .createHash('sha256')
    .update('toeic_salt_2026:' + String(password))
    .digest('hex');
}

function loadWords() {
  try {
    const raw = fs.readFileSync(WORDS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error loading words.json:', err.message);
    return [];
  }
}

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const initialDb = { users: [], customWords: [], sessions: {} };
      fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), 'utf8');
      return initialDb;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.users = parsed.users || [];
    parsed.customWords = parsed.customWords || [];
    parsed.sessions = parsed.sessions || {};
    return parsed;
  } catch (err) {
    console.error('Error loading db.json:', err.message);
    return { users: [], customWords: [], sessions: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

function getAuthenticatedUser(req, db) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : req.headers['x-auth-token'] || '';
  if (!token || !db.sessions[token]) return null;
  const userId = db.sessions[token];
  return db.users.find((u) => u.id === userId) || null;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token'
  });
  res.end(payload);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function handleApiRequest(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token'
    });
    return res.end();
  }

  const db = loadDb();

  // 1. Health Check
  if (pathname === '/api/health' && req.method === 'GET') {
    const baseWords = loadWords();
    return sendJson(res, 200, {
      ok: true,
      mode: 'server',
      engine: 'Node.js',
      wordCount: baseWords.length + db.customWords.length,
      userCount: db.users.length
    });
  }

  // 2. Get All Words (built-in + custom)
  if (pathname === '/api/words' && req.method === 'GET') {
    const baseWords = loadWords();
    const allWords = [
      ...baseWords.map((w) => ({ ...w, isCustom: false })),
      ...db.customWords.map((w) => ({ ...w, isCustom: true }))
    ];
    return sendJson(res, 200, { words: allWords });
  }

  // 3. Add Custom Word
  if (pathname === '/api/words' && req.method === 'POST') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '請先登入以新增自訂題庫單字' });

    const body = await parseJsonBody(req);
    const word = String(body.word || '').trim().toLowerCase();
    const meaning = String(body.meaning || '').trim();
    if (!word || !meaning) {
      return sendJson(res, 400, { error: '英文單字與中文解釋為必填欄位' });
    }

    const baseWords = loadWords();
    const exists =
      baseWords.some((w) => w.word.toLowerCase() === word) ||
      db.customWords.some((w) => w.word.toLowerCase() === word);
    if (exists) {
      return sendJson(res, 409, { error: `單字 "${word}" 已經存在於題庫中` });
    }

    const newWord = {
      id: 'cw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      word,
      phonetic: String(body.phonetic || '').trim() || `/${word}/`,
      pos: String(body.pos || 'n.').trim(),
      meaning,
      synonyms: String(body.synonyms || '').trim(),
      example:
        String(body.example || '').trim() ||
        `Please review the usage of ${word} in business contexts.`,
      translation:
        String(body.translation || '').trim() ||
        `請複習 ${word}（${meaning}）在商務情境中的用法。`,
      category: String(body.category || '商務與合約').trim(),
      level: String(body.level || '750分進階').trim(),
      isCustom: true,
      createdBy: user.username,
      createdAt: new Date().toISOString()
    };

    db.customWords.unshift(newWord);
    saveDb(db);
    return sendJson(res, 201, { word: newWord });
  }

  // 4. Delete Custom Word
  if (pathname.startsWith('/api/words/') && req.method === 'DELETE') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '請先登入' });

    const wordId = decodeURIComponent(pathname.replace('/api/words/', ''));
    const idx = db.customWords.findIndex((w) => w.id === wordId);
    if (idx === -1) {
      return sendJson(res, 404, { error: '找不到該自訂單字（內建單字無法刪除）' });
    }
    db.customWords.splice(idx, 1);
    saveDb(db);
    return sendJson(res, 200, { ok: true, deletedId: wordId });
  }

  // 5. Auth: Register
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || username).trim();
    const targetScore = Number(body.targetScore) || 750;

    if (!username || username.length < 2) {
      return sendJson(res, 400, { error: '帳號長度至少需 2 個字元' });
    }
    if (!password || password.length < 4) {
      return sendJson(res, 400, { error: '密碼長度至少需 4 個字元' });
    }
    if (db.users.some((u) => u.username.toLowerCase() === username)) {
      return sendJson(res, 409, { error: '此帳號已被註冊，請直接登入或更換帳號' });
    }

    const newUser = {
      id: 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      username,
      displayName: displayName || username,
      passwordHash: hashPassword(password),
      targetScore,
      createdAt: new Date().toISOString(),
      stats: {
        totalQuizzes: 0,
        totalQuestions: 0,
        correctAnswers: 0,
        streakDays: 1,
        lastStudyDate: new Date().toISOString().slice(0, 10)
      },
      wrongWords: {},
      history: []
    };

    const token = crypto.randomBytes(24).toString('hex');
    db.users.push(newUser);
    db.sessions[token] = newUser.id;
    saveDb(db);

    return sendJson(res, 201, {
      token,
      user: sanitizeUser(newUser)
    });
  }

  // 6. Auth: Login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');

    const user = db.users.find((u) => u.username.toLowerCase() === username);
    if (!user || user.passwordHash !== hashPassword(password)) {
      return sendJson(res, 401, { error: '帳號或密碼錯誤，請重新輸入' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = user.id;
    saveDb(db);

    return sendJson(res, 200, {
      token,
      user: sanitizeUser(user)
    });
  }

  // 7. Auth: Logout
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      saveDb(db);
    }
    return sendJson(res, 200, { ok: true });
  }

  // 8. Current User Profile
  if (pathname === '/api/user/me' && req.method === 'GET') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '尚未登入或登入已過期' });
    return sendJson(res, 200, { user: sanitizeUser(user) });
  }

  // 9. Update User Profile
  if (pathname === '/api/user/profile' && req.method === 'PUT') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '請先登入' });

    const body = await parseJsonBody(req);
    if (body.displayName) user.displayName = String(body.displayName).trim();
    if (body.targetScore) user.targetScore = Number(body.targetScore) || 750;
    saveDb(db);
    return sendJson(res, 200, { user: sanitizeUser(user) });
  }

  // 9b. Import / Sync User Backup Data
  if (pathname === '/api/user/sync' && req.method === 'POST') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '請先登入後再匯入備份檔' });

    const body = await parseJsonBody(req);
    if (body.stats && typeof body.stats === 'object') {
      user.stats = { ...user.stats, ...body.stats };
    }
    if (body.wrongWords && typeof body.wrongWords === 'object') {
      user.wrongWords = { ...(user.wrongWords || {}), ...body.wrongWords };
    }
    if (Array.isArray(body.history)) {
      user.history = body.history.slice(0, 50);
    }
    if (Array.isArray(body.customWords)) {
      for (const cw of body.customWords) {
        if (cw && cw.word && !db.customWords.some((x) => x.word === cw.word)) {
          db.customWords.push(cw);
        }
      }
    }
    saveDb(db);
    return sendJson(res, 200, { user: sanitizeUser(user) });
  }

  // 10. Submit Quiz Result & Sync Wrong Words
  if (pathname === '/api/quiz/submit' && req.method === 'POST') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '請先登入以儲存測驗與錯題紀錄' });

    const body = await parseJsonBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    const modeLabel = String(body.modeLabel || '多益單字測驗');
    const categoryLabel = String(body.categoryLabel || '全部主題');
    const durationSec = Number(body.durationSec) || 0;

    const total = results.length;
    const correct = results.filter((r) => r.isCorrect).length;
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;
    const nowIso = new Date().toISOString();
    const todayStr = nowIso.slice(0, 10);

    user.stats = user.stats || {
      totalQuizzes: 0,
      totalQuestions: 0,
      correctAnswers: 0,
      streakDays: 1,
      lastStudyDate: todayStr
    };

    user.stats.totalQuizzes += 1;
    user.stats.totalQuestions += total;
    user.stats.correctAnswers += correct;

    if (user.stats.lastStudyDate !== todayStr) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      if (user.stats.lastStudyDate === yesterday) {
        user.stats.streakDays = (user.stats.streakDays || 1) + 1;
      } else {
        user.stats.streakDays = 1;
      }
      user.stats.lastStudyDate = todayStr;
    }

    user.wrongWords = user.wrongWords || {};
    const wrongWordIds = [];

    for (const item of results) {
      const wId = String(item.wordId || '');
      if (!wId) continue;

      if (!item.isCorrect) {
        wrongWordIds.push(wId);
        const existing = user.wrongWords[wId] || {
          wordId: wId,
          errorCount: 0,
          correctStreak: 0,
          mastered: false,
          note: ''
        };
        existing.errorCount = (existing.errorCount || 0) + 1;
        existing.correctStreak = 0;
        existing.mastered = false;
        existing.lastWrongAt = nowIso;
        existing.lastMode = item.mode || modeLabel;
        if (item.userAnswer) {
          existing.lastWrongAnswer = String(item.userAnswer);
        }
        user.wrongWords[wId] = existing;
      } else if (user.wrongWords[wId]) {
        // 如果該字原本在錯題本中，這次答對了就累積連續答對次數
        const existing = user.wrongWords[wId];
        existing.correctStreak = (existing.correctStreak || 0) + 1;
        existing.lastReviewedAt = nowIso;
        if (existing.correctStreak >= 3) {
          existing.mastered = true;
        }
      }
    }

    user.history = user.history || [];
    user.history.unshift({
      id: 'h_' + Date.now(),
      mode: modeLabel,
      category: categoryLabel,
      total,
      correct,
      score,
      durationSec,
      wrongWordIds,
      date: nowIso
    });
    if (user.history.length > 50) {
      user.history = user.history.slice(0, 50);
    }

    saveDb(db);
    return sendJson(res, 200, {
      user: sanitizeUser(user),
      summary: { total, correct, score, wrongWordIds }
    });
  }

  // 11. Manually Add / Toggle Wrong Word or Mastery Status
  if (pathname === '/api/wrong-words/toggle' && req.method === 'POST') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '請先登入' });

    const body = await parseJsonBody(req);
    const wordId = String(body.wordId || '');
    if (!wordId) return sendJson(res, 400, { error: '缺少 wordId' });

    user.wrongWords = user.wrongWords || {};
    if (body.action === 'add') {
      if (!user.wrongWords[wordId]) {
        user.wrongWords[wordId] = {
          wordId,
          errorCount: 1,
          correctStreak: 0,
          mastered: false,
          lastWrongAt: new Date().toISOString(),
          lastMode: '手動收藏重點',
          note: ''
        };
      }
    } else if (body.action === 'master') {
      if (user.wrongWords[wordId]) {
        user.wrongWords[wordId].mastered = !user.wrongWords[wordId].mastered;
        if (user.wrongWords[wordId].mastered) {
          user.wrongWords[wordId].correctStreak = Math.max(
            3,
            user.wrongWords[wordId].correctStreak || 0
          );
        } else {
          user.wrongWords[wordId].correctStreak = 0;
        }
      }
    } else if (body.action === 'remove') {
      delete user.wrongWords[wordId];
    } else {
      // default toggle presence
      if (user.wrongWords[wordId]) {
        delete user.wrongWords[wordId];
      } else {
        user.wrongWords[wordId] = {
          wordId,
          errorCount: 1,
          correctStreak: 0,
          mastered: false,
          lastWrongAt: new Date().toISOString(),
          lastMode: '手動加入錯題本',
          note: ''
        };
      }
    }

    saveDb(db);
    return sendJson(res, 200, { user: sanitizeUser(user) });
  }

  // 12. Update Note on Wrong Word
  if (pathname.startsWith('/api/wrong-words/') && req.method === 'PUT') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '請先登入' });

    const wordId = decodeURIComponent(
      pathname.replace('/api/wrong-words/', '').replace('/note', '')
    );
    const body = await parseJsonBody(req);

    user.wrongWords = user.wrongWords || {};
    if (!user.wrongWords[wordId]) {
      user.wrongWords[wordId] = {
        wordId,
        errorCount: 1,
        correctStreak: 0,
        mastered: false,
        lastWrongAt: new Date().toISOString(),
        lastMode: '筆記收藏',
        note: ''
      };
    }

    if (typeof body.note === 'string') {
      user.wrongWords[wordId].note = body.note.trim();
    }
    if (typeof body.mastered === 'boolean') {
      user.wrongWords[wordId].mastered = body.mastered;
      user.wrongWords[wordId].correctStreak = body.mastered ? 3 : 0;
    }

    saveDb(db);
    return sendJson(res, 200, { user: sanitizeUser(user) });
  }

  // 13. Delete Wrong Word
  if (pathname.startsWith('/api/wrong-words/') && req.method === 'DELETE') {
    const user = getAuthenticatedUser(req, db);
    if (!user) return sendJson(res, 401, { error: '請先登入' });

    const wordId = decodeURIComponent(pathname.replace('/api/wrong-words/', ''));
    if (user.wrongWords && user.wrongWords[wordId]) {
      delete user.wrongWords[wordId];
      saveDb(db);
    }
    return sendJson(res, 200, { user: sanitizeUser(user) });
  }

  return sendJson(res, 404, { error: 'API endpoint not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) {
      return await handleApiRequest(req, res, pathname);
    }

    // Serve static files from public/
    let safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    if (safePath === '/' || safePath === '\\') {
      safePath = '/index.html';
    }

    const filePath = path.join(PUBLIC_DIR, safePath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    } else {
      // Fallback to index.html for SPA routing
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
    }
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🎯 TOEIC Vocab Master 伺服器已啟動！`);
  console.log(`🌐 請開啟瀏覽器前往: http://localhost:${PORT}`);
  console.log(`💾 資料庫檔案路徑:   ${DB_FILE}`);
  console.log('====================================================');
});
