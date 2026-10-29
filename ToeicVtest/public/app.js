/**
 * TOEIC Vocab Master - Frontend Application
 * 支援連接後端 REST API (/api/*) 儲存於伺服器 data/db.json，
 * 同時具備離線 LocalStorage 備援引擎，確保任何開啟方式皆可完整運作。
 */

(function () {
  'use strict';

  // ==================== 預設示範資料 (供離線備援初始化) ====================
  const DEFAULT_DEMO_USER = {
    id: 'u_demo',
    username: 'demo',
    displayName: 'TOEIC 示範學員',
    passwordPlain: '123456',
    targetScore: 860,
    createdAt: '2026-10-29T12:00:00.000Z',
    stats: {
      totalQuizzes: 3,
      totalQuestions: 25,
      correctAnswers: 21,
      streakDays: 3,
      lastStudyDate: new Date().toISOString().slice(0, 10)
    },
    wrongWords: {
      w040: {
        wordId: 'w040',
        errorCount: 2,
        correctStreak: 0,
        mastered: false,
        lastWrongAt: '2026-10-29T11:30:00.000Z',
        lastMode: '英翻中',
        note: '注意：discrepancy 常指帳目或數據上的「出入、不符」，常搭配 between A and B。'
      },
      w051: {
        wordId: 'w051',
        errorCount: 1,
        correctStreak: 1,
        mastered: false,
        lastWrongAt: '2026-10-29T11:45:00.000Z',
        lastMode: '聽力拼字',
        note: 'expedite = 加速處理（出貨、審批），不要跟 expand 搞混！'
      },
      w076: {
        wordId: 'w076',
        errorCount: 1,
        correctStreak: 2,
        mastered: false,
        lastWrongAt: '2026-10-28T15:20:00.000Z',
        lastMode: '例句填空',
        note: 'reimburse 核銷差旅費，受詞可以是人或費用 (reimburse sb for sth)。'
      }
    },
    history: [
      {
        id: 'h_001',
        mode: '四選一（英翻中）',
        category: '全部主題',
        total: 10,
        correct: 8,
        score: 80,
        durationSec: 68,
        wrongWordIds: ['w040', 'w076'],
        date: '2026-10-29T11:30:00.000Z'
      },
      {
        id: 'h_002',
        mode: '聽力拼字填空',
        category: '商務與合約',
        total: 5,
        correct: 4,
        score: 80,
        durationSec: 54,
        wrongWordIds: ['w051'],
        date: '2026-10-29T11:45:00.000Z'
      },
      {
        id: 'h_003',
        mode: '錯題專項重測',
        category: '錯題本',
        total: 10,
        correct: 9,
        score: 90,
        durationSec: 49,
        wrongWordIds: ['w040'],
        date: '2026-10-29T12:00:00.000Z'
      }
    ]
  };

  // ==================== 全域狀態 ====================
  const state = {
    isServerMode: false,
    token: localStorage.getItem('toeic_auth_token') || '',
    user: null,
    words: Array.isArray(window.INITIAL_TOEIC_WORDS) ? [...window.INITIAL_TOEIC_WORDS] : [],
    activeTab: 'dashboard',
    activeSubtab: 'fc-cards',
    nbFilter: 'all',

    // 四選一測驗狀態
    mcQuiz: {
      active: false,
      questions: [],
      currentIndex: 0,
      results: [],
      answered: false,
      startTime: 0,
      timerInterval: null,
      modeLabel: '',
      categoryLabel: '',
      autoSpeak: true
    },

    // 聽力拼字測驗狀態
    spQuiz: {
      active: false,
      questions: [],
      currentIndex: 0,
      results: [],
      answered: false,
      hintUsed: false,
      startTime: 0,
      timerInterval: null,
      accent: 'en-US',
      categoryLabel: ''
    },

    // 單字卡狀態
    flashcard: {
      filteredWords: [],
      currentIndex: 0,
      flipped: false
    }
  };

  // ==================== 離線 LocalStorage 備援資料庫 ====================
  const LocalDb = {
    KEY: 'toeic_vocab_master_local_db_v1',
    load() {
      try {
        const raw = localStorage.getItem(this.KEY);
        if (!raw) {
          const init = {
            users: [JSON.parse(JSON.stringify(DEFAULT_DEMO_USER))],
            customWords: [],
            sessions: {}
          };
          localStorage.setItem(this.KEY, JSON.stringify(init));
          return init;
        }
        return JSON.parse(raw);
      } catch (e) {
        return { users: [JSON.parse(JSON.stringify(DEFAULT_DEMO_USER))], customWords: [], sessions: {} };
      }
    },
    save(db) {
      localStorage.setItem(this.KEY, JSON.stringify(db));
    }
  };

  // ==================== API 服務層 (自動切換 Server / Local) ====================
  const Api = {
    async checkServer() {
      if (window.location.protocol === 'file:') {
        state.isServerMode = false;
        updateDbStatusUI();
        return false;
      }
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          state.isServerMode = Boolean(data && data.ok);
          updateDbStatusUI(data.engine);
          return state.isServerMode;
        }
      } catch (err) {
        // Server not reachable, fallback to LocalDb
      }
      state.isServerMode = false;
      updateDbStatusUI();
      return false;
    },

    async request(path, options = {}) {
      if (state.isServerMode) {
        const headers = {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        };
        if (state.token) {
          headers['Authorization'] = `Bearer ${state.token}`;
        }
        const res = await fetch(path, {
          ...options,
          headers
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || `請求失敗 (${res.status})`);
        }
        return data;
      } else {
        return this.localRequest(path, options);
      }
    },

    // LocalStorage 模擬相同 REST API 行為
    async localRequest(path, options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      const body = options.body ? JSON.parse(options.body) : {};
      const db = LocalDb.load();
      const currentUserId = db.sessions[state.token];
      const currentUser = db.users.find((u) => u.id === currentUserId) || null;

      if (path === '/api/words' && method === 'GET') {
        const base = Array.isArray(window.INITIAL_TOEIC_WORDS) ? window.INITIAL_TOEIC_WORDS : [];
        return {
          words: [
            ...base.map((w) => ({ ...w, isCustom: false })),
            ...(db.customWords || []).map((w) => ({ ...w, isCustom: true }))
          ]
        };
      }

      if (path === '/api/words' && method === 'POST') {
        if (!currentUser) throw new Error('請先登入');
        const word = String(body.word || '').trim().toLowerCase();
        const meaning = String(body.meaning || '').trim();
        if (!word || !meaning) throw new Error('英文單字與中文解釋為必填');
        const newWord = {
          id: 'cw_' + Date.now(),
          word,
          phonetic: body.phonetic || `/${word}/`,
          pos: body.pos || 'n.',
          meaning,
          synonyms: body.synonyms || '',
          example: body.example || `Please review the usage of ${word} in business contexts.`,
          translation: body.translation || `請複習 ${word}（${meaning}）在商務情境中的用法。`,
          category: body.category || '商務與合約',
          level: body.level || '750分進階',
          isCustom: true,
          createdBy: currentUser.username,
          createdAt: new Date().toISOString()
        };
        db.customWords.unshift(newWord);
        LocalDb.save(db);
        return { word: newWord };
      }

      if (path.startsWith('/api/words/') && method === 'DELETE') {
        const id = decodeURIComponent(path.replace('/api/words/', ''));
        db.customWords = (db.customWords || []).filter((w) => w.id !== id);
        LocalDb.save(db);
        return { ok: true, deletedId: id };
      }

      if (path === '/api/auth/login' && method === 'POST') {
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '');
        const u = db.users.find((x) => x.username.toLowerCase() === username);
        if (!u || (u.passwordPlain && u.passwordPlain !== password)) {
          throw new Error('帳號或密碼錯誤，請重新輸入');
        }
        const token = 'local_tok_' + Date.now();
        db.sessions[token] = u.id;
        LocalDb.save(db);
        return { token, user: u };
      }

      if (path === '/api/auth/register' && method === 'POST') {
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (username.length < 2) throw new Error('帳號至少需 2 個字元');
        if (password.length < 4) throw new Error('密碼至少需 4 個字元');
        if (db.users.some((x) => x.username.toLowerCase() === username)) {
          throw new Error('此帳號已被註冊，請直接登入');
        }
        const newUser = {
          id: 'u_' + Date.now(),
          username,
          displayName: body.displayName || username,
          passwordPlain: password,
          targetScore: Number(body.targetScore) || 860,
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
        const token = 'local_tok_' + Date.now();
        db.users.push(newUser);
        db.sessions[token] = newUser.id;
        LocalDb.save(db);
        return { token, user: newUser };
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        delete db.sessions[state.token];
        LocalDb.save(db);
        return { ok: true };
      }

      if (path === '/api/user/me' && method === 'GET') {
        if (!currentUser) throw new Error('尚未登入');
        return { user: currentUser };
      }

      if (path === '/api/user/profile' && method === 'PUT') {
        if (!currentUser) throw new Error('請先登入');
        if (body.displayName) currentUser.displayName = body.displayName;
        if (body.targetScore) currentUser.targetScore = Number(body.targetScore);
        LocalDb.save(db);
        return { user: currentUser };
      }

      if (path === '/api/user/sync' && method === 'POST') {
        if (!currentUser) throw new Error('請先登入後再匯入備份檔');
        if (body.stats && typeof body.stats === 'object') {
          currentUser.stats = { ...currentUser.stats, ...body.stats };
        }
        if (body.wrongWords && typeof body.wrongWords === 'object') {
          currentUser.wrongWords = { ...(currentUser.wrongWords || {}), ...body.wrongWords };
        }
        if (Array.isArray(body.history)) {
          currentUser.history = body.history.slice(0, 50);
        }
        if (Array.isArray(body.customWords)) {
          db.customWords = db.customWords || [];
          for (const cw of body.customWords) {
            if (cw && cw.word && !db.customWords.some((x) => x.word === cw.word)) {
              db.customWords.push(cw);
            }
          }
        }
        LocalDb.save(db);
        return { user: currentUser };
      }

      if (path === '/api/quiz/submit' && method === 'POST') {
        if (!currentUser) throw new Error('請先登入');
        const results = body.results || [];
        const total = results.length;
        const correct = results.filter((r) => r.isCorrect).length;
        const score = total > 0 ? Math.round((correct / total) * 100) : 0;
        const nowIso = new Date().toISOString();

        currentUser.stats.totalQuizzes += 1;
        currentUser.stats.totalQuestions += total;
        currentUser.stats.correctAnswers += correct;
        currentUser.wrongWords = currentUser.wrongWords || {};
        const wrongWordIds = [];

        for (const item of results) {
          const wId = item.wordId;
          if (!item.isCorrect) {
            wrongWordIds.push(wId);
            const ex = currentUser.wrongWords[wId] || {
              wordId: wId,
              errorCount: 0,
              correctStreak: 0,
              mastered: false,
              note: ''
            };
            ex.errorCount += 1;
            ex.correctStreak = 0;
            ex.mastered = false;
            ex.lastWrongAt = nowIso;
            ex.lastMode = item.mode || body.modeLabel;
            if (item.userAnswer) ex.lastWrongAnswer = item.userAnswer;
            currentUser.wrongWords[wId] = ex;
          } else if (currentUser.wrongWords[wId]) {
            const ex = currentUser.wrongWords[wId];
            ex.correctStreak = (ex.correctStreak || 0) + 1;
            if (ex.correctStreak >= 3) ex.mastered = true;
          }
        }

        currentUser.history = currentUser.history || [];
        currentUser.history.unshift({
          id: 'h_' + Date.now(),
          mode: body.modeLabel || '多益單字測驗',
          category: body.categoryLabel || '全部主題',
          total,
          correct,
          score,
          durationSec: body.durationSec || 0,
          wrongWordIds,
          date: nowIso
        });
        LocalDb.save(db);
        return { user: currentUser, summary: { total, correct, score, wrongWordIds } };
      }

      if (path === '/api/wrong-words/toggle' && method === 'POST') {
        if (!currentUser) throw new Error('請先登入');
        const wId = body.wordId;
        currentUser.wrongWords = currentUser.wrongWords || {};
        if (body.action === 'master' && currentUser.wrongWords[wId]) {
          currentUser.wrongWords[wId].mastered = !currentUser.wrongWords[wId].mastered;
          currentUser.wrongWords[wId].correctStreak = currentUser.wrongWords[wId].mastered ? 3 : 0;
        } else if (body.action === 'remove') {
          delete currentUser.wrongWords[wId];
        } else {
          if (currentUser.wrongWords[wId]) {
            delete currentUser.wrongWords[wId];
          } else {
            currentUser.wrongWords[wId] = {
              wordId: wId,
              errorCount: 1,
              correctStreak: 0,
              mastered: false,
              lastWrongAt: new Date().toISOString(),
              lastMode: '手動加入錯題本',
              note: ''
            };
          }
        }
        LocalDb.save(db);
        return { user: currentUser };
      }

      if (path.startsWith('/api/wrong-words/') && method === 'PUT') {
        if (!currentUser) throw new Error('請先登入');
        const wId = decodeURIComponent(path.replace('/api/wrong-words/', '').replace('/note', ''));
        if (currentUser.wrongWords && currentUser.wrongWords[wId]) {
          if (typeof body.note === 'string') currentUser.wrongWords[wId].note = body.note;
        }
        LocalDb.save(db);
        return { user: currentUser };
      }

      if (path.startsWith('/api/wrong-words/') && method === 'DELETE') {
        if (!currentUser) throw new Error('請先登入');
        const wId = decodeURIComponent(path.replace('/api/wrong-words/', ''));
        if (currentUser.wrongWords) delete currentUser.wrongWords[wId];
        LocalDb.save(db);
        return { user: currentUser };
      }

      throw new Error('Unknown endpoint: ' + path);
    }
  };

  // ==================== 工具函式 ====================
  function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }

  function speakText(text, rate = 1.0, lang = 'en-US') {
    if (!('speechSynthesis' in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang;
      utter.rate = rate;
      window.speechSynthesis.speak(utter);
    } catch (e) {
      // Ignore speech error
    }
  }

  function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 將例句中的目標單字（含詞形變化）挖空為 _______
  function maskWordInSentence(sentence, word) {
    if (!sentence || !word) return sentence;
    const stem = word.length > 5 ? word.slice(0, word.length - 2) : word;
    const regex = new RegExp(`\\b${stem}[a-z]*\\b`, 'gi');
    if (regex.test(sentence)) {
      return sentence.replace(regex, '<span class="blank-slot">_______</span>');
    }
    return `${sentence} (<span class="blank-slot">_______</span>)`;
  }

  function getWordById(wordId) {
    return state.words.find((w) => w.id === wordId) || null;
  }

  function getWrongWordsStats() {
    if (!state.user || !state.user.wrongWords) {
      return { all: [], pending: [], mastered: [], totalErrors: 0 };
    }
    const entries = Object.values(state.user.wrongWords)
      .map((item) => {
        const wordObj = getWordById(item.wordId);
        return wordObj ? { ...item, wordObj } : null;
      })
      .filter(Boolean);

    const pending = entries.filter((x) => !x.mastered);
    const mastered = entries.filter((x) => x.mastered);
    const totalErrors = entries.reduce((sum, x) => sum + (x.errorCount || 1), 0);
    return { all: entries, pending, mastered, totalErrors };
  }

  // ==================== UI 更新與同步 ====================
  function updateDbStatusUI(engineName) {
    const badge = document.getElementById('dbStatusBadge');
    const text = document.getElementById('dbStatusText');
    if (!badge || !text) return;

    if (state.isServerMode) {
      badge.classList.remove('local');
      text.textContent = `伺服器資料庫已連線 (${engineName || 'Server'})`;
    } else {
      badge.classList.add('local');
      text.textContent = '本機資料庫模式 (LocalStorage)';
    }
  }

  function updateAllUI() {
    updateHeaderUserUI();
    renderDashboard();
    renderNotebook();
    refreshFlashcardsFilter();
    renderVocabList();
  }

  function updateHeaderUserUI() {
    const nameEl = document.getElementById('headerUserName');
    const targetEl = document.getElementById('headerUserTarget');
    const authBtn = document.getElementById('authActionBtn');
    const navBadge = document.getElementById('navWrongBadge');

    const { pending } = getWrongWordsStats();
    if (navBadge) {
      navBadge.textContent = pending.length;
    }

    if (state.user) {
      nameEl.textContent = state.user.displayName || state.user.username;
      targetEl.textContent = `🎯 目標 ${state.user.targetScore || 860} 分`;
      authBtn.textContent = '切換 / 登出';
    } else {
      nameEl.textContent = '尚未登入';
      targetEl.textContent = '點擊右側登入';
      authBtn.textContent = '登入 / 註冊';
    }
  }

  // ==================== 1. 學習總覽 (Dashboard) ====================
  function renderDashboard() {
    const user = state.user;
    const stats = (user && user.stats) || {
      totalQuizzes: 0,
      totalQuestions: 0,
      correctAnswers: 0,
      streakDays: 1
    };
    const { pending, mastered } = getWrongWordsStats();

    document.getElementById('dashboardWelcomeTitle').textContent = user
      ? `哈囉，${user.displayName}！開始今天的多益單字特訓吧`
      : '哈囉！請先登入以記錄您的多益單字學習進度與錯題本';

    const targetScore = (user && user.targetScore) || 860;
    document.getElementById('dashboardTargetScore').innerHTML = `${targetScore} <span>分</span>`;
    const certBadge = document.getElementById('dashboardCertBadge');
    if (targetScore >= 860) certBadge.textContent = '🥇 金色證書目標 (860~990)';
    else if (targetScore >= 730) certBadge.textContent = '🟦 藍色證書目標 (730~855)';
    else certBadge.textContent = '🟩 綠色證書目標 (470~725)';

    document.getElementById('dashboardStreak').textContent = stats.streakDays || 1;
    document.getElementById('heroWrongCount').textContent = pending.length;

    document.getElementById('statTotalQuizzes').textContent = stats.totalQuizzes || 0;
    document.getElementById('statTotalQuestions').textContent = stats.totalQuestions || 0;

    const accuracy =
      stats.totalQuestions > 0
        ? Math.round((stats.correctAnswers / stats.totalQuestions) * 100)
        : 0;
    document.getElementById('statAccuracy').textContent = accuracy;
    document.getElementById('statAccuracyBar').style.width = `${accuracy}%`;

    document.getElementById('statPendingWrong').textContent = pending.length;
    document.getElementById('statMasteredWrong').textContent = mastered.length;
    document.getElementById('statTotalWords').textContent = state.words.length;

    // 渲染六大主題分類
    const categories = [
      { name: '商務與合約', icon: '💼' },
      { name: '財務與會計', icon: '💰' },
      { name: '人事與職場', icon: '👥' },
      { name: '行銷與銷售', icon: '📣' },
      { name: '旅遊與交通', icon: '✈️' },
      { name: '科技與製造', icon: '⚙️' }
    ];

    const catGrid = document.getElementById('dashboardCategoryGrid');
    catGrid.innerHTML = categories
      .map((c) => {
        const catWords = state.words.filter((w) => w.category === c.name);
        const catWrong = pending.filter((p) => p.wordObj.category === c.name);
        return `
          <div class="category-item" data-start-cat="${escapeHtml(c.name)}">
            <div class="category-item-top">
              <span class="category-item-title">${c.icon} ${escapeHtml(c.name)}</span>
              <span class="badge badge-outline">${catWords.length} 字</span>
            </div>
            <div class="category-item-meta">
              ${
                catWrong.length > 0
                  ? `<span style="color: var(--danger); font-weight: 700;">📕 待複習錯題 ${catWrong.length} 字</span>`
                  : '✅ 目前無待加強錯題'
              }
            </div>
          </div>
        `;
      })
      .join('');

    catGrid.querySelectorAll('[data-start-cat]').forEach((el) => {
      el.addEventListener('click', () => {
        const cat = el.getAttribute('data-start-cat');
        switchTab('mc-quiz');
        document.getElementById('mcCategorySelect').value = cat;
        startMcQuiz();
      });
    });

    // 渲染歷史紀錄
    const history = (user && user.history) || [];
    document.getElementById('historyCountLabel').textContent = `最近 ${history.length} 筆紀錄`;
    const histContainer = document.getElementById('dashboardHistoryList');

    if (history.length === 0) {
      histContainer.innerHTML = `
        <div class="text-muted" style="text-align:center; padding: 32px 12px;">
          尚無測驗紀錄，點擊上方「立即開始 10 題四選一測驗」完成第一場練習吧！
        </div>
      `;
    } else {
      histContainer.innerHTML = history
        .slice(0, 15)
        .map((h) => {
          const scoreClass = h.score >= 80 ? 'high' : h.score >= 60 ? 'mid' : 'low';
          const wrongLen = Array.isArray(h.wrongWordIds) ? h.wrongWordIds.length : h.total - h.correct;
          return `
            <div class="history-item">
              <div class="history-left">
                <div class="history-title">${escapeHtml(h.mode)}｜${escapeHtml(h.category)}</div>
                <div class="history-sub">
                  🕒 ${formatDateTime(h.date)} · 答對 ${h.correct}/${h.total} 題 · 用時 ${h.durationSec || 0}秒 · 錯題 ${wrongLen} 字
                </div>
              </div>
              <div class="history-score ${scoreClass}">${h.score} 分</div>
            </div>
          `;
        })
        .join('');
    }
  }

  // ==================== 2. 四選一選擇題測驗 (MC Quiz) ====================
  function getFilteredPool(categoryVal, levelVal) {
    const { all, pending } = getWrongWordsStats();
    let pool = [];

    if (categoryVal === 'WRONG_PENDING') {
      pool = pending.map((x) => x.wordObj);
    } else if (categoryVal === 'WRONG_ALL') {
      pool = all.map((x) => x.wordObj);
    } else if (categoryVal === 'ALL') {
      pool = [...state.words];
    } else {
      pool = state.words.filter((w) => w.category === categoryVal);
    }

    if (levelVal && levelVal !== 'ALL' && !categoryVal.startsWith('WRONG_')) {
      pool = pool.filter((w) => w.level === levelVal);
    }
    return pool;
  }

  function buildMcQuestion(targetWord, modeSetting) {
    const modes = ['en-zh', 'zh-en', 'sentence'];
    const actualMode =
      modeSetting === 'mixed' ? modes[Math.floor(Math.random() * modes.length)] : modeSetting;

    // 挑選 3 個干擾選項（優先同詞性）
    const samePosOther = state.words.filter(
      (w) => w.id !== targetWord.id && w.pos === targetWord.pos
    );
    const otherAll = state.words.filter((w) => w.id !== targetWord.id);
    const distractorSource = samePosOther.length >= 3 ? samePosOther : otherAll;
    const distractors = shuffleArray(distractorSource).slice(0, 3);
    const optionsWords = shuffleArray([targetWord, ...distractors]);

    let promptLabel = '';
    let stemHtml = '';
    let subText = '';
    let modeBadge = '';
    let chineseHint = '';

    if (actualMode === 'en-zh') {
      modeBadge = '英翻中';
      promptLabel = '請選出下列多益單字的正確中文解釋：';
      stemHtml = escapeHtml(targetWord.word);
      subText = `${targetWord.phonetic} (${targetWord.pos})`;
      chineseHint = `例句中譯提示：${targetWord.translation}`;
    } else if (actualMode === 'zh-en') {
      modeBadge = '中翻英';
      promptLabel = '請根據中文釋義，選出對應的英文單字：';
      stemHtml = escapeHtml(targetWord.meaning);
      subText = `詞性提示：${targetWord.pos}｜主題：${targetWord.category}`;
      chineseHint = `例句中譯提示：${targetWord.translation}`;
    } else {
      modeBadge = '多益 Part 5 例句填空';
      promptLabel = '請選出最適合填入空格的多益單字：';
      stemHtml = maskWordInSentence(escapeHtml(targetWord.example), targetWord.word);
      subText = `詞性：${targetWord.pos}｜主題：${targetWord.category}`;
      chineseHint = `例句中譯提示：${targetWord.translation}`;
    }

    const options = optionsWords.map((w) => ({
      wordId: w.id,
      label:
        actualMode === 'en-zh'
          ? `${w.pos} ${w.meaning}`
          : `${w.word} (${w.pos})`,
      isCorrect: w.id === targetWord.id,
      wordObj: w
    }));

    return {
      targetWord,
      actualMode,
      modeBadge,
      promptLabel,
      stemHtml,
      subText,
      chineseHint,
      options
    };
  }

  function startMcQuiz() {
    if (!state.user) {
      openAuthModal();
      showToast('請先登入帳號，系統才能為您紀錄測驗成績與錯題！', 'warning');
      return;
    }

    const modeVal = document.getElementById('mcModeSelect').value;
    const catVal = document.getElementById('mcCategorySelect').value;
    const levelVal = document.getElementById('mcLevelSelect').value;
    const countVal = Number(document.getElementById('mcCountSelect').value) || 10;
    const autoSpeak = document.getElementById('mcAutoSpeakCheck').checked;

    const pool = getFilteredPool(catVal, levelVal);
    if (pool.length === 0) {
      if (catVal.startsWith('WRONG_')) {
        showToast('太棒了！目前錯題本中沒有符合條件的錯題，可先測驗其他主題。', 'warning');
      } else {
        showToast('此篩選條件下沒有單字，請放寬難度或分類條件。', 'warning');
      }
      return;
    }

    const selectedWords = shuffleArray(pool).slice(0, Math.min(countVal, pool.length));
    const questions = selectedWords.map((w) => buildMcQuestion(w, modeVal));

    const modeMap = {
      mixed: '四選一（綜合混合）',
      'en-zh': '四選一（英翻中）',
      'zh-en': '四選一（中翻英）',
      sentence: '四選一（例句填空）'
    };
    const catMap = {
      ALL: '全部主題',
      WRONG_PENDING: '錯題本（待加強）',
      WRONG_ALL: '錯題本（全部）'
    };

    clearInterval(state.mcQuiz.timerInterval);
    state.mcQuiz = {
      active: true,
      questions,
      currentIndex: 0,
      results: [],
      answered: false,
      startTime: Date.now(),
      timerInterval: null,
      modeLabel: modeMap[modeVal] || '四選一測驗',
      categoryLabel: catMap[catVal] || catVal,
      autoSpeak
    };

    document.getElementById('mcSetupPanel').classList.add('hidden');
    document.getElementById('mcResultPanel').classList.add('hidden');
    document.getElementById('mcActivePanel').classList.remove('hidden');

    state.mcQuiz.timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - state.mcQuiz.startTime) / 1000);
      document.getElementById('mcTimerText').textContent = formatDuration(sec);
    }, 1000);

    renderCurrentMcQuestion();
  }

  function renderCurrentMcQuestion() {
    const qz = state.mcQuiz;
    const q = qz.questions[qz.currentIndex];
    if (!q) return;

    qz.answered = false;
    const total = qz.questions.length;
    const idx = qz.currentIndex + 1;

    document.getElementById('mcProgressBadge').textContent = `第 ${idx} / ${total} 題`;
    document.getElementById('mcCurrentModeBadge').textContent = q.modeBadge;
    document.getElementById('mcCurrentCategoryBadge').textContent = q.targetWord.category;
    document.getElementById('mcCurrentLevelBadge').textContent = q.targetWord.level;
    document.getElementById('mcProgressBar').style.width = `${Math.round((idx / total) * 100)}%`;

    const correctSoFar = qz.results.filter((r) => r.isCorrect).length;
    const wrongSoFar = qz.results.length - correctSoFar;
    document.getElementById('mcCorrectCount').textContent = correctSoFar;
    document.getElementById('mcWrongCount').textContent = wrongSoFar;

    document.getElementById('mcPromptLabel').textContent = q.promptLabel;
    const stemEl = document.getElementById('mcQuestionStem');
    stemEl.innerHTML = q.stemHtml;
    stemEl.className =
      q.actualMode === 'sentence' ? 'question-stem sentence-stem' : 'question-stem';
    document.getElementById('mcQuestionSub').textContent = q.subText;

    // 重設四選一中文提示隱藏選單
    const mcHintWrap = document.getElementById('mcHintDropdownWrap');
    const mcHintContent = document.getElementById('mcHintContent');
    const mcHintBtn = document.getElementById('mcToggleHintBtn');
    const mcHintBtnText = document.getElementById('mcHintBtnText');
    const mcHintArrow = document.getElementById('mcHintArrow');
    const mcHintText = document.getElementById('mcHintText');

    if (q.chineseHint) {
      mcHintWrap.classList.remove('hidden');
      mcHintContent.classList.add('hidden');
      mcHintBtn.classList.remove('active');
      mcHintBtnText.textContent = '💡 展開中文提示 (H)';
      mcHintArrow.textContent = '▾';
      mcHintText.textContent = q.chineseHint;
    } else {
      mcHintWrap.classList.add('hidden');
    }

    const optionsContainer = document.getElementById('mcOptionsContainer');
    optionsContainer.innerHTML = q.options
      .map(
        (opt, i) => `
        <button class="option-btn" data-opt-index="${i}">
          <span class="option-key">${i + 1}</span>
          <span>${escapeHtml(opt.label)}</span>
        </button>
      `
      )
      .join('');

    optionsContainer.querySelectorAll('.option-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const optIdx = Number(btn.getAttribute('data-opt-index'));
        handleMcAnswer(optIdx);
      });
    });

    document.getElementById('mcExplanationBox').classList.add('hidden');

    if (qz.autoSpeak && q.actualMode === 'en-zh') {
      speakText(q.targetWord.word);
    }
  }

  function handleMcAnswer(selectedIndex) {
    const qz = state.mcQuiz;
    if (!qz.active || qz.answered) return;
    qz.answered = true;

    const q = qz.questions[qz.currentIndex];
    const chosenOpt = q.options[selectedIndex];
    const isCorrect = Boolean(chosenOpt && chosenOpt.isCorrect);

    qz.results.push({
      wordId: q.targetWord.id,
      isCorrect,
      mode: q.modeBadge,
      userAnswer: chosenOpt ? chosenOpt.label : ''
    });

    // 標示選項顏色
    const buttons = document.querySelectorAll('#mcOptionsContainer .option-btn');
    buttons.forEach((btn, idx) => {
      btn.disabled = true;
      if (q.options[idx].isCorrect) {
        btn.classList.add('correct');
      } else if (idx === selectedIndex && !isCorrect) {
        btn.classList.add('wrong');
      }
    });

    const correctSoFar = qz.results.filter((r) => r.isCorrect).length;
    const wrongSoFar = qz.results.length - correctSoFar;
    document.getElementById('mcCorrectCount').textContent = correctSoFar;
    document.getElementById('mcWrongCount').textContent = wrongSoFar;

    if (qz.autoSpeak) {
      speakText(q.targetWord.word);
    }

    // 顯示即時詳解
    const expBox = document.getElementById('mcExplanationBox');
    const expStatus = document.getElementById('mcExpStatus');
    const expBody = document.getElementById('mcExpBody');
    const nextBtn = document.getElementById('mcNextQuestionBtn');
    const bookmarkBtn = document.getElementById('mcToggleBookmarkBtn');

    expBox.classList.remove('hidden');
    if (isCorrect) {
      expStatus.textContent = '✅ 答對了！觀念非常清晰';
      expStatus.className = 'exp-status is-correct';
    } else {
      expStatus.textContent = '❌ 答錯了！此單字將於結算時自動收錄至「錯題本」';
      expStatus.className = 'exp-status is-wrong';
    }

    const isInWrong = Boolean(
      state.user && state.user.wrongWords && state.user.wrongWords[q.targetWord.id]
    );
    bookmarkBtn.textContent = isInWrong ? '📕 已在錯題本' : '⭐ 手動加入錯題本';

    nextBtn.textContent =
      qz.currentIndex + 1 < qz.questions.length ? '下一題 (Enter) ➡️' : '查看測驗成績單 🏁';

    const w = q.targetWord;
    expBody.innerHTML = `
      <div class="exp-word-line">
        <span class="exp-word-title">${escapeHtml(w.word)}</span>
        <span>${escapeHtml(w.phonetic)}</span>
        <span class="pos-tag">${escapeHtml(w.pos)}</span>
        <strong>${escapeHtml(w.meaning)}</strong>
        ${
          w.synonyms
            ? `<span class="text-muted">｜同義詞：${escapeHtml(w.synonyms)}</span>`
            : ''
        }
      </div>
      <div class="exp-example-block">
        <div><strong>多益例句：</strong>${escapeHtml(w.example)}</div>
        <div class="text-muted">${escapeHtml(w.translation)}</div>
      </div>
    `;
  }

  async function finishMcQuiz() {
    const qz = state.mcQuiz;
    clearInterval(qz.timerInterval);
    qz.active = false;

    const durationSec = Math.max(1, Math.floor((Date.now() - qz.startTime) / 1000));
    document.getElementById('mcActivePanel').classList.add('hidden');
    const resultPanel = document.getElementById('mcResultPanel');
    resultPanel.classList.remove('hidden');

    if (qz.results.length === 0) {
      document.getElementById('mcSetupPanel').classList.remove('hidden');
      resultPanel.classList.add('hidden');
      return;
    }

    try {
      const resp = await Api.request('/api/quiz/submit', {
        method: 'POST',
        body: JSON.stringify({
          modeLabel: qz.modeLabel,
          categoryLabel: qz.categoryLabel,
          durationSec,
          results: qz.results
        })
      });
      state.user = resp.user;
      updateAllUI();
      renderQuizResultCard(resultPanel, qz.results, durationSec, qz.modeLabel, 'mc');
      const wrongCount = qz.results.filter((r) => !r.isCorrect).length;
      if (wrongCount > 0) {
        showToast(`測驗完成！已將 ${wrongCount} 個答錯單字同步至您的錯題本`, 'warning');
      } else {
        showToast('🎉 滿分全對！太厲害了！', 'success');
      }
    } catch (err) {
      showToast('儲存測驗結果失敗：' + err.message, 'danger');
    }
  }

  // ==================== 3. 聽力／拼字填空測驗 (Spelling Quiz) ====================
  function startSpQuiz() {
    if (!state.user) {
      openAuthModal();
      showToast('請先登入帳號以記錄聽力拼字成績與錯題！', 'warning');
      return;
    }

    const catVal = document.getElementById('spCategorySelect').value;
    const levelVal = document.getElementById('spLevelSelect').value;
    const countVal = Number(document.getElementById('spCountSelect').value) || 5;
    const accentVal = document.getElementById('spAccentSelect').value || 'en-US';

    const pool = getFilteredPool(catVal, levelVal);
    if (pool.length === 0) {
      showToast('目前沒有符合該條件的單字可供測驗', 'warning');
      return;
    }

    const selectedWords = shuffleArray(pool).slice(0, Math.min(countVal, pool.length));
    const catMap = {
      ALL: '全部主題',
      WRONG_PENDING: '錯題本（待加強）',
      WRONG_ALL: '錯題本（全部）'
    };

    clearInterval(state.spQuiz.timerInterval);
    state.spQuiz = {
      active: true,
      questions: selectedWords,
      currentIndex: 0,
      results: [],
      answered: false,
      hintUsed: false,
      startTime: Date.now(),
      timerInterval: null,
      accent: accentVal,
      categoryLabel: catMap[catVal] || catVal
    };

    document.getElementById('spSetupPanel').classList.add('hidden');
    document.getElementById('spResultPanel').classList.add('hidden');
    document.getElementById('spActivePanel').classList.remove('hidden');

    state.spQuiz.timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - state.spQuiz.startTime) / 1000);
      document.getElementById('spTimerText').textContent = formatDuration(sec);
    }, 1000);

    renderCurrentSpQuestion();
  }

  function renderCurrentSpQuestion() {
    const sp = state.spQuiz;
    const w = sp.questions[sp.currentIndex];
    if (!w) return;

    sp.answered = false;
    sp.hintUsed = false;

    const total = sp.questions.length;
    const idx = sp.currentIndex + 1;
    document.getElementById('spProgressBadge').textContent = `第 ${idx} / ${total} 題`;
    document.getElementById('spCurrentCategoryBadge').textContent = w.category;
    document.getElementById('spCurrentLevelBadge').textContent = w.level;
    document.getElementById('spProgressBar').style.width = `${Math.round((idx / total) * 100)}%`;

    const correctSoFar = sp.results.filter((r) => r.isCorrect).length;
    const wrongSoFar = sp.results.length - correctSoFar;
    document.getElementById('spCorrectCount').textContent = correctSoFar;
    document.getElementById('spWrongCount').textContent = wrongSoFar;

    document.getElementById('spPosTag').textContent = w.pos;
    document.getElementById('spMeaningText').textContent = w.meaning;
    document.getElementById('spSentenceEn').innerHTML = maskWordInSentence(
      escapeHtml(w.example),
      w.word
    );
    document.getElementById('spSentenceZh').textContent = w.translation;

    // 重設聽力拼字中文提示隱藏選單（預設收合）
    const spContent = document.getElementById('spHintContent');
    const spBtn = document.getElementById('spToggleChineseBtn');
    const spBtnText = document.getElementById('spHintBtnText');
    const spArrow = document.getElementById('spHintArrow');
    spContent.classList.add('hidden');
    spBtn.classList.remove('active');
    spBtnText.textContent = '💡 展開中文提示（釋義與中譯） (H)';
    spArrow.textContent = '▾';

    const blankPattern = Array(w.word.length).fill('_').join(' ');
    document.getElementById('spHintPattern').textContent = `${blankPattern} (${w.word.length} 個字母)`;

    const inputEl = document.getElementById('spInput');
    inputEl.value = '';
    inputEl.disabled = false;
    document.getElementById('spSubmitBtn').disabled = false;
    document.getElementById('spExplanationBox').classList.add('hidden');

    setTimeout(() => {
      inputEl.focus();
      speakText(w.word, 1.0, sp.accent);
    }, 120);
  }

  function handleSpSubmit(e) {
    if (e) e.preventDefault();
    const sp = state.spQuiz;
    if (!sp.active || sp.answered) return;

    const w = sp.questions[sp.currentIndex];
    const inputEl = document.getElementById('spInput');
    const typed = inputEl.value.trim().toLowerCase();
    if (!typed) {
      showToast('請輸入英文單字拼字後再送出', 'warning');
      return;
    }

    sp.answered = true;
    inputEl.disabled = true;
    document.getElementById('spSubmitBtn').disabled = true;

    const isCorrect = typed === w.word.toLowerCase();
    sp.results.push({
      wordId: w.id,
      isCorrect,
      mode: '聽力拼字填空',
      userAnswer: typed
    });

    const correctSoFar = sp.results.filter((r) => r.isCorrect).length;
    const wrongSoFar = sp.results.length - correctSoFar;
    document.getElementById('spCorrectCount').textContent = correctSoFar;
    document.getElementById('spWrongCount').textContent = wrongSoFar;

    speakText(w.word, 1.0, sp.accent);

    const expBox = document.getElementById('spExplanationBox');
    const expStatus = document.getElementById('spExpStatus');
    const expBody = document.getElementById('spExpBody');
    const nextBtn = document.getElementById('spNextQuestionBtn');

    expBox.classList.remove('hidden');
    if (isCorrect) {
      expStatus.textContent = `✅ 拼字完全正確！(${w.word})`;
      expStatus.className = 'exp-status is-correct';
    } else {
      expStatus.textContent = `❌ 拼字有誤！正確拼法為「${w.word}」（您的輸入：${typed}）`;
      expStatus.className = 'exp-status is-wrong';
    }

    nextBtn.textContent =
      sp.currentIndex + 1 < sp.questions.length ? '下一題 (Enter) ➡️' : '查看拼字測驗成績單 🏁';

    expBody.innerHTML = `
      <div class="exp-word-line">
        <span class="exp-word-title">${escapeHtml(w.word)}</span>
        <span>${escapeHtml(w.phonetic)}</span>
        <span class="pos-tag">${escapeHtml(w.pos)}</span>
        <strong>${escapeHtml(w.meaning)}</strong>
      </div>
      <div class="exp-example-block">
        <div><strong>完整例句：</strong>${escapeHtml(w.example)}</div>
        <div class="text-muted">${escapeHtml(w.translation)}</div>
      </div>
    `;
  }

  async function finishSpQuiz() {
    const sp = state.spQuiz;
    clearInterval(sp.timerInterval);
    sp.active = false;

    const durationSec = Math.max(1, Math.floor((Date.now() - sp.startTime) / 1000));
    document.getElementById('spActivePanel').classList.add('hidden');
    const resultPanel = document.getElementById('spResultPanel');
    resultPanel.classList.remove('hidden');

    if (sp.results.length === 0) {
      document.getElementById('spSetupPanel').classList.remove('hidden');
      resultPanel.classList.add('hidden');
      return;
    }

    try {
      const resp = await Api.request('/api/quiz/submit', {
        method: 'POST',
        body: JSON.stringify({
          modeLabel: '聽力拼字填空',
          categoryLabel: sp.categoryLabel,
          durationSec,
          results: sp.results
        })
      });
      state.user = resp.user;
      updateAllUI();
      renderQuizResultCard(resultPanel, sp.results, durationSec, '聽力拼字填空', 'sp');
    } catch (err) {
      showToast('儲存結果失敗：' + err.message, 'danger');
    }
  }

  // ==================== 共用測驗成績單渲染 ====================
  function renderQuizResultCard(container, results, durationSec, modeTitle, type) {
    const total = results.length;
    const correct = results.filter((r) => r.isCorrect).length;
    const wrong = total - correct;
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;

    let comment = '繼續保持！錯題已自動收錄至錯題本，立即複習印象最深刻！';
    if (score === 100) comment = '🏆 太神啦！100% 完美全對，離多益金色證書更進一步！';
    else if (score >= 80) comment = '🌟 表現優異！少數錯題已幫您加入錯題本方便考前衝刺。';

    const rowsHtml = results
      .map((r) => {
        const w = getWordById(r.wordId);
        if (!w) return '';
        return `
          <div class="result-review-item ${r.isCorrect ? 'is-correct' : 'is-wrong'}">
            <div>
              <strong>${r.isCorrect ? '✅' : '❌'} ${escapeHtml(w.word)}</strong>
              <span class="text-muted">${escapeHtml(w.phonetic)} (${escapeHtml(w.pos)})</span>
              — <span>${escapeHtml(w.meaning)}</span>
              ${
                !r.isCorrect && r.userAnswer
                  ? `<div style="font-size:0.8rem; color:var(--danger);">您的作答：${escapeHtml(
                      r.userAnswer
                    )}（已加入錯題本）</div>`
                  : ''
              }
            </div>
            <button class="btn-audio-sm" data-speak-word="${escapeHtml(w.word)}">🔊 發音</button>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="result-summary-header">
        <div class="score-circle">
          ${score}
          <small>分</small>
        </div>
        <h2>${escapeHtml(modeTitle)} — 測驗完成！</h2>
        <p class="text-muted" style="margin: 6px 0 16px;">${comment}</p>
        <div style="display:flex; justify-content:center; gap:20px; margin-bottom:20px; font-weight:700;">
          <span>🎯 答對：${correct} / ${total} 題</span>
          <span style="color:var(--danger);">📕 本回錯題：${wrong} 題</span>
          <span>⏱️ 總用時：${formatDuration(durationSec)}</span>
        </div>
        <div style="display:flex; justify-content:center; gap:12px; flex-wrap:wrap;">
          ${
            wrong > 0
              ? `<button class="btn btn-warning btn-lg" id="resRetestWrongBtn_${type}">🔥 立即重測待加強錯題</button>`
              : ''
          }
          <button class="btn btn-primary btn-lg" id="resAgainBtn_${type}">🔄 再測驗一回</button>
          <button class="btn btn-outline btn-lg" id="resGoNotebookBtn_${type}">📕 前往錯題本查看</button>
        </div>
      </div>
      <h3>📋 本回作答明細與解析</h3>
      <div class="result-review-list">${rowsHtml}</div>
    `;

    container.querySelectorAll('[data-speak-word]').forEach((btn) => {
      btn.addEventListener('click', () => speakText(btn.getAttribute('data-speak-word')));
    });

    const againBtn = document.getElementById(`resAgainBtn_${type}`);
    if (againBtn) {
      againBtn.addEventListener('click', () => {
        container.classList.add('hidden');
        document
          .getElementById(type === 'mc' ? 'mcSetupPanel' : 'spSetupPanel')
          .classList.remove('hidden');
      });
    }

    const nbBtn = document.getElementById(`resGoNotebookBtn_${type}`);
    if (nbBtn) {
      nbBtn.addEventListener('click', () => switchTab('notebook'));
    }

    const retestBtn = document.getElementById(`resRetestWrongBtn_${type}`);
    if (retestBtn) {
      retestBtn.addEventListener('click', () => {
        if (type === 'mc') {
          document.getElementById('mcCategorySelect').value = 'WRONG_PENDING';
          startMcQuiz();
        } else {
          document.getElementById('spCategorySelect').value = 'WRONG_PENDING';
          startSpQuiz();
        }
      });
    }
  }

  // ==================== 4. 錯題本專區 (Wrong Answer Notebook) ====================
  function renderNotebook() {
    const { all, pending, mastered, totalErrors } = getWrongWordsStats();

    document.getElementById('nbTotalCount').textContent = all.length;
    document.getElementById('nbPendingCount').textContent = pending.length;
    document.getElementById('nbMasteredCount').textContent = mastered.length;
    document.getElementById('nbTotalErrors').textContent = totalErrors;

    document.getElementById('pillCountAll').textContent = all.length;
    document.getElementById('pillCountPending').textContent = pending.length;
    document.getElementById('pillCountMastered').textContent = mastered.length;

    let filtered = [...all];
    if (state.nbFilter === 'pending') filtered = pending;
    else if (state.nbFilter === 'mastered') filtered = mastered;

    const query = (document.getElementById('nbSearchInput').value || '').trim().toLowerCase();
    if (query) {
      filtered = filtered.filter(
        (item) =>
          item.wordObj.word.toLowerCase().includes(query) ||
          item.wordObj.meaning.toLowerCase().includes(query) ||
          (item.note || '').toLowerCase().includes(query)
      );
    }

    const sortMode = document.getElementById('nbSortSelect').value;
    filtered.sort((a, b) => {
      if (sortMode === 'errors-desc') return (b.errorCount || 1) - (a.errorCount || 1);
      if (sortMode === 'recent-desc')
        return String(b.lastWrongAt || '').localeCompare(String(a.lastWrongAt || ''));
      if (sortMode === 'streak-asc') return (a.correctStreak || 0) - (b.correctStreak || 0);
      return a.wordObj.word.localeCompare(b.wordObj.word);
    });

    const container = document.getElementById('wrongWordsContainer');
    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align:center; padding: 48px 20px;">
          <div style="font-size: 3rem; margin-bottom: 10px;">🎉</div>
          <h3>目前沒有符合條件的錯題紀錄</h3>
          <p class="text-muted" style="margin: 8px 0 20px;">
            您可以前往「四選一測驗」或「聽力拼字」進行練習，答錯的題目會自動收錄於此；或至「題庫總覽」手動將重點單字加入錯題本。
          </p>
          <button class="btn btn-primary" id="nbEmptyStartQuizBtn">📝 前往四選一測驗</button>
        </div>
      `;
      const btn = document.getElementById('nbEmptyStartQuizBtn');
      if (btn) btn.addEventListener('click', () => switchTab('mc-quiz'));
      return;
    }

    container.innerHTML = filtered
      .map((item) => {
        const w = item.wordObj;
        const streak = Math.min(3, item.correctStreak || 0);
        const stars = '★'.repeat(streak) + '☆'.repeat(3 - streak);

        return `
          <div class="wrong-word-card ${item.mastered ? 'is-mastered' : ''}">
            <div>
              <div class="ww-header">
                <div class="ww-word-group">
                  <span class="ww-word">${escapeHtml(w.word)}</span>
                  <span class="ww-phonetic">${escapeHtml(w.phonetic)}</span>
                  <span class="pos-tag">${escapeHtml(w.pos)}</span>
                  <button class="btn-audio-sm" data-nb-speak="${escapeHtml(w.word)}">🔊</button>
                </div>
                <div class="ww-badges">
                  <span class="badge badge-danger">答錯 ${item.errorCount || 1} 次</span>
                  ${
                    item.mastered
                      ? '<span class="badge badge-success">⭐ 已熟練</span>'
                      : '<span class="badge badge-level">🔥 待加強</span>'
                  }
                </div>
              </div>

              <div class="ww-meaning" style="margin: 8px 0;">${escapeHtml(w.meaning)}</div>

              <div class="ww-example">
                <div class="ww-example-en">${escapeHtml(w.example)}</div>
                <div class="ww-example-zh">${escapeHtml(w.translation)}</div>
              </div>
            </div>

            <div>
              <div class="ww-note-box" style="margin-bottom: 10px;">
                <input
                  type="text"
                  class="ww-note-input"
                  id="noteInput_${w.id}"
                  placeholder="✏️ 新增個人記憶口訣或筆記..."
                  value="${escapeHtml(item.note || '')}"
                />
                <button class="btn btn-sm btn-outline" data-nb-save-note="${w.id}">儲存筆記</button>
              </div>

              <div class="ww-footer">
                <div>
                  <span class="mastery-stars" title="錯題重測連續答對 3 次自動標記已熟練">
                    熟練度：${stars} (${streak}/3)
                  </span>
                  <span style="margin-left: 8px;">上次：${escapeHtml(item.lastMode || '測驗')}</span>
                </div>
                <div style="display:flex; gap: 6px;">
                  <button class="btn btn-sm btn-outline" data-nb-toggle-master="${w.id}">
                    ${item.mastered ? '設為待加強' : '✓ 標記已熟練'}
                  </button>
                  <button class="btn btn-sm btn-ghost" data-nb-remove="${w.id}" title="從錯題本移除">
                    🗑️ 移除
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('[data-nb-speak]').forEach((btn) => {
      btn.addEventListener('click', () => speakText(btn.getAttribute('data-nb-speak')));
    });

    container.querySelectorAll('[data-nb-save-note]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const wId = btn.getAttribute('data-nb-save-note');
        const noteVal = document.getElementById(`noteInput_${wId}`).value;
        try {
          const resp = await Api.request(`/api/wrong-words/${encodeURIComponent(wId)}/note`, {
            method: 'PUT',
            body: JSON.stringify({ note: noteVal })
          });
          state.user = resp.user;
          showToast('已儲存個人記憶筆記！', 'success');
        } catch (err) {
          showToast(err.message, 'danger');
        }
      });
    });

    container.querySelectorAll('[data-nb-toggle-master]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const wId = btn.getAttribute('data-nb-toggle-master');
        try {
          const resp = await Api.request('/api/wrong-words/toggle', {
            method: 'POST',
            body: JSON.stringify({ wordId: wId, action: 'master' })
          });
          state.user = resp.user;
          updateAllUI();
          showToast('已更新單字熟練度狀態！', 'success');
        } catch (err) {
          showToast(err.message, 'danger');
        }
      });
    });

    container.querySelectorAll('[data-nb-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const wId = btn.getAttribute('data-nb-remove');
        try {
          const resp = await Api.request(`/api/wrong-words/${encodeURIComponent(wId)}`, {
            method: 'DELETE'
          });
          state.user = resp.user;
          updateAllUI();
          showToast('已從錯題本移除該單字', 'success');
        } catch (err) {
          showToast(err.message, 'danger');
        }
      });
    });
  }

  // ==================== 5. 3D 單字卡 & 題庫管理 ====================
  function refreshFlashcardsFilter() {
    const catVal = document.getElementById('fcCategorySelect').value;
    const levelVal = document.getElementById('fcLevelSelect').value;

    let list = [];
    if (catVal === 'WRONG_ONLY') {
      const { all } = getWrongWordsStats();
      list = all.map((x) => x.wordObj);
    } else if (catVal === 'ALL') {
      list = [...state.words];
    } else {
      list = state.words.filter((w) => w.category === catVal);
    }

    if (levelVal !== 'ALL') {
      list = list.filter((w) => w.level === levelVal);
    }

    state.flashcard.filteredWords = list;
    if (state.flashcard.currentIndex >= list.length) {
      state.flashcard.currentIndex = 0;
    }
    state.flashcard.flipped = false;
    renderCurrentFlashcard();
  }

  function renderCurrentFlashcard() {
    const fc = state.flashcard;
    const card3d = document.getElementById('flashcard3d');
    card3d.classList.toggle('flipped', fc.flipped);

    if (fc.filteredWords.length === 0) {
      document.getElementById('fcCounterText').textContent = '0 / 0 張';
      document.getElementById('fcFrontWord').textContent = '無符合條件單字';
      document.getElementById('fcFrontPhonetic').textContent = '';
      document.getElementById('fcFrontPos').textContent = '-';
      return;
    }

    const w = fc.filteredWords[fc.currentIndex];
    document.getElementById('fcCounterText').textContent = `第 ${fc.currentIndex + 1} / ${
      fc.filteredWords.length
    } 張`;

    document.getElementById('fcFrontCategory').textContent = w.category;
    document.getElementById('fcFrontLevel').textContent = w.level;
    document.getElementById('fcFrontWord').textContent = w.word;
    document.getElementById('fcFrontPhonetic').textContent = w.phonetic;
    document.getElementById('fcFrontPos').textContent = w.pos;

    const isInWrong = Boolean(state.user && state.user.wrongWords && state.user.wrongWords[w.id]);
    const wrongTag = document.getElementById('fcFrontWrongTag');
    wrongTag.classList.toggle('hidden', !isInWrong);

    const toggleWrongBtn = document.getElementById('fcToggleWrongBtn');
    toggleWrongBtn.textContent = isInWrong ? '📕 移出錯題本 (B)' : '⭐ 加入錯題本 (B)';

    document.getElementById('fcBackWordHead').textContent = `${w.word} ${w.phonetic} (${w.pos})`;
    document.getElementById('fcBackMeaning').textContent = w.meaning;
    document.getElementById('fcBackSynonyms').textContent = w.synonyms
      ? `同義字：${w.synonyms}`
      : '';
    document.getElementById('fcBackExample').textContent = w.example;
    document.getElementById('fcBackTranslation').textContent = w.translation;
  }

  function renderVocabList() {
    const query = (document.getElementById('vocabSearchInput').value || '').trim().toLowerCase();
    const cat = document.getElementById('vocabCategoryFilter').value;
    const lvl = document.getElementById('vocabLevelFilter').value;

    const filtered = state.words.filter((w) => {
      if (cat !== 'ALL' && w.category !== cat) return false;
      if (lvl !== 'ALL' && w.level !== lvl) return false;
      if (query) {
        const hay = `${w.word} ${w.meaning} ${w.synonyms || ''} ${w.example}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    document.getElementById('vocabListCountInfo').textContent = `共顯示 ${filtered.length} 個單字（總題庫 ${state.words.length} 字）`;

    const tbody = document.getElementById('vocabTableBody');
    tbody.innerHTML = filtered
      .map((w) => {
        const isInWrong = Boolean(
          state.user && state.user.wrongWords && state.user.wrongWords[w.id]
        );
        return `
          <tr>
            <td>
              <div style="font-weight:800; font-size:1.05rem;">
                ${escapeHtml(w.word)}
                <button class="btn-audio-sm" data-table-speak="${escapeHtml(w.word)}">🔊</button>
              </div>
              <div class="text-muted" style="font-size:0.82rem;">${escapeHtml(w.phonetic)}</div>
            </td>
            <td>
              <span class="pos-tag">${escapeHtml(w.pos)}</span>
              <strong style="margin-left:6px;">${escapeHtml(w.meaning)}</strong>
              ${
                w.synonyms
                  ? `<div class="text-muted" style="font-size:0.8rem; margin-top:3px;">同義：${escapeHtml(
                      w.synonyms
                    )}</div>`
                  : ''
              }
            </td>
            <td>
              <div style="font-weight:600;">${escapeHtml(w.example)}</div>
              <div class="text-muted" style="font-size:0.84rem;">${escapeHtml(w.translation)}</div>
            </td>
            <td>
              <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
                <span class="badge badge-category">${escapeHtml(w.category)}</span>
                <span class="badge badge-level">${escapeHtml(w.level)}</span>
                ${w.isCustom ? '<span class="badge badge-primary">自訂新增</span>' : ''}
              </div>
            </td>
            <td>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button class="btn btn-sm ${
                  isInWrong ? 'btn-danger' : 'btn-outline'
                }" data-table-toggle-wrong="${w.id}">
                  ${isInWrong ? '📕 已在錯題本' : '⭐ 加入錯題本'}
                </button>
                ${
                  w.isCustom
                    ? `<button class="btn btn-sm btn-ghost" data-table-del-word="${w.id}">刪除</button>`
                    : ''
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('[data-table-speak]').forEach((btn) => {
      btn.addEventListener('click', () => speakText(btn.getAttribute('data-table-speak')));
    });

    tbody.querySelectorAll('[data-table-toggle-wrong]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!state.user) {
          openAuthModal();
          return;
        }
        const wId = btn.getAttribute('data-table-toggle-wrong');
        try {
          const resp = await Api.request('/api/wrong-words/toggle', {
            method: 'POST',
            body: JSON.stringify({ wordId: wId })
          });
          state.user = resp.user;
          updateAllUI();
          showToast('已更新錯題本狀態！', 'success');
        } catch (err) {
          showToast(err.message, 'danger');
        }
      });
    });

    tbody.querySelectorAll('[data-table-del-word]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const wId = btn.getAttribute('data-table-del-word');
        try {
          await Api.request(`/api/words/${encodeURIComponent(wId)}`, { method: 'DELETE' });
          state.words = state.words.filter((x) => x.id !== wId);
          updateAllUI();
          showToast('已刪除該自訂單字', 'success');
        } catch (err) {
          showToast(err.message, 'danger');
        }
      });
    });
  }

  // ==================== 登入與註冊控制 ====================
  function openAuthModal() {
    document.getElementById('authErrorAlert').classList.add('hidden');
    document.getElementById('authModal').classList.remove('hidden');
  }

  function closeAuthModal() {
    document.getElementById('authModal').classList.add('hidden');
  }

  async function performLogin(username, password) {
    const errEl = document.getElementById('authErrorAlert');
    errEl.classList.add('hidden');
    try {
      const data = await Api.request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('toeic_auth_token', data.token);
      closeAuthModal();
      updateAllUI();
      showToast(`歡迎回來，${data.user.displayName}！`, 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  }

  // ==================== 分頁導覽與事件綁定 ====================
  function switchTab(tabId) {
    state.activeTab = tabId;
    document.querySelectorAll('#mainNav .nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabId}`);
    });
  }

  function bindEvents() {
    // 主導覽列切換
    document.querySelectorAll('#mainNav .nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
    });

    document.getElementById('brandHomeBtn').addEventListener('click', () => switchTab('dashboard'));

    // Dashboard 快速按鈕
    document.getElementById('quickStartMcBtn').addEventListener('click', () => {
      switchTab('mc-quiz');
      document.getElementById('mcCategorySelect').value = 'ALL';
      document.getElementById('mcCountSelect').value = '10';
      startMcQuiz();
    });

    document.getElementById('quickReviewWrongBtn').addEventListener('click', () => {
      const { pending } = getWrongWordsStats();
      if (pending.length === 0) {
        switchTab('notebook');
        showToast('目前沒有待加強錯題，可先查看錯題本或開始新測驗！', 'success');
      } else {
        switchTab('mc-quiz');
        document.getElementById('mcCategorySelect').value = 'WRONG_PENDING';
        startMcQuiz();
      }
    });

    document.getElementById('quickStartSpellingBtn').addEventListener('click', () => {
      switchTab('spelling-quiz');
    });

    document.getElementById('statWrongCard').addEventListener('click', () => {
      state.nbFilter = 'pending';
      switchTab('notebook');
      renderNotebook();
    });

    document.getElementById('statMasteredCard').addEventListener('click', () => {
      state.nbFilter = 'mastered';
      switchTab('notebook');
      renderNotebook();
    });

    document.getElementById('editGoalBtn').addEventListener('click', async () => {
      if (!state.user) {
        openAuthModal();
        return;
      }
      const nextScore = prompt('請輸入您的目標多益分數 (例如 600, 750, 860, 950)：', state.user.targetScore || 860);
      if (nextScore && !isNaN(Number(nextScore))) {
        const resp = await Api.request('/api/user/profile', {
          method: 'PUT',
          body: JSON.stringify({ targetScore: Number(nextScore) })
        });
        state.user = resp.user;
        updateAllUI();
        showToast(`已將目標分數更新為 ${state.user.targetScore} 分！`, 'success');
      }
    });

    // 四選一測驗事件
    document.getElementById('startMcQuizBtn').addEventListener('click', startMcQuiz);
    document.getElementById('mcQuitBtn').addEventListener('click', () => {
      if (state.mcQuiz.results.length > 0) {
        finishMcQuiz();
      } else {
        clearInterval(state.mcQuiz.timerInterval);
        state.mcQuiz.active = false;
        document.getElementById('mcActivePanel').classList.add('hidden');
        document.getElementById('mcSetupPanel').classList.remove('hidden');
      }
    });

    document.getElementById('mcSpeakBtn').addEventListener('click', () => {
      const q = state.mcQuiz.questions[state.mcQuiz.currentIndex];
      if (q) speakText(q.targetWord.word);
    });

    // 四選一中文提示隱藏選單切換
    document.getElementById('mcToggleHintBtn').addEventListener('click', () => {
      const content = document.getElementById('mcHintContent');
      const btn = document.getElementById('mcToggleHintBtn');
      const btnText = document.getElementById('mcHintBtnText');
      const arrow = document.getElementById('mcHintArrow');
      const isHidden = content.classList.toggle('hidden');
      btn.classList.toggle('active', !isHidden);
      btnText.textContent = isHidden ? '💡 展開中文提示 (H)' : '🙈 隱藏中文提示 (H)';
      arrow.textContent = isHidden ? '▾' : '▴';
    });

    document.getElementById('mcNextQuestionBtn').addEventListener('click', () => {
      const qz = state.mcQuiz;
      if (qz.currentIndex + 1 < qz.questions.length) {
        qz.currentIndex += 1;
        renderCurrentMcQuestion();
      } else {
        finishMcQuiz();
      }
    });

    document.getElementById('mcToggleBookmarkBtn').addEventListener('click', async () => {
      const q = state.mcQuiz.questions[state.mcQuiz.currentIndex];
      if (!q || !state.user) return;
      const resp = await Api.request('/api/wrong-words/toggle', {
        method: 'POST',
        body: JSON.stringify({ wordId: q.targetWord.id })
      });
      state.user = resp.user;
      const isInWrong = Boolean(state.user.wrongWords && state.user.wrongWords[q.targetWord.id]);
      document.getElementById('mcToggleBookmarkBtn').textContent = isInWrong
        ? '📕 已在錯題本'
        : '⭐ 手動加入錯題本';
      updateHeaderUserUI();
      showToast(isInWrong ? '已加入錯題本！' : '已從錯題本移除', 'success');
    });

    // 聽力拼字事件
    document.getElementById('startSpQuizBtn').addEventListener('click', startSpQuiz);
    document.getElementById('spSubmitForm').addEventListener('submit', handleSpSubmit);

    // 聽力拼字中文提示隱藏選單切換
    document.getElementById('spToggleChineseBtn').addEventListener('click', () => {
      const content = document.getElementById('spHintContent');
      const btn = document.getElementById('spToggleChineseBtn');
      const btnText = document.getElementById('spHintBtnText');
      const arrow = document.getElementById('spHintArrow');
      const isHidden = content.classList.toggle('hidden');
      btn.classList.toggle('active', !isHidden);
      btnText.textContent = isHidden ? '💡 展開中文提示（釋義與中譯） (H)' : '🙈 隱藏中文提示 (H)';
      arrow.textContent = isHidden ? '▾' : '▴';
    });
    document.getElementById('spPlayNormalBtn').addEventListener('click', () => {
      const w = state.spQuiz.questions[state.spQuiz.currentIndex];
      if (w) speakText(w.word, 1.0, state.spQuiz.accent);
    });
    document.getElementById('spPlaySlowBtn').addEventListener('click', () => {
      const w = state.spQuiz.questions[state.spQuiz.currentIndex];
      if (w) speakText(w.word, 0.72, state.spQuiz.accent);
    });
    document.getElementById('spShowHintBtn').addEventListener('click', () => {
      const w = state.spQuiz.questions[state.spQuiz.currentIndex];
      if (!w) return;
      const word = w.word;
      const middle = Array(Math.max(1, word.length - 2)).fill('_').join(' ');
      const hint = `${word[0]} ${middle} ${word[word.length - 1]} (${word.length} 個字母)`;
      document.getElementById('spHintPattern').textContent = hint;
      document.getElementById('spInput').focus();
    });
    document.getElementById('spNextQuestionBtn').addEventListener('click', () => {
      const sp = state.spQuiz;
      if (sp.currentIndex + 1 < sp.questions.length) {
        sp.currentIndex += 1;
        renderCurrentSpQuestion();
      } else {
        finishSpQuiz();
      }
    });
    document.getElementById('spQuitBtn').addEventListener('click', () => {
      if (state.spQuiz.results.length > 0) {
        finishSpQuiz();
      } else {
        clearInterval(state.spQuiz.timerInterval);
        state.spQuiz.active = false;
        document.getElementById('spActivePanel').classList.add('hidden');
        document.getElementById('spSetupPanel').classList.remove('hidden');
      }
    });

    // 錯題本事件
    document.querySelectorAll('#nbStatusFilterPills .pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#nbStatusFilterPills .pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.nbFilter = btn.getAttribute('data-filter');
        renderNotebook();
      });
    });

    document.getElementById('nbSearchInput').addEventListener('input', renderNotebook);
    document.getElementById('nbSortSelect').addEventListener('change', renderNotebook);

    document.getElementById('nbRetestMcPendingBtn').addEventListener('click', () => {
      switchTab('mc-quiz');
      document.getElementById('mcCategorySelect').value = 'WRONG_PENDING';
      startMcQuiz();
    });

    document.getElementById('nbRetestSpPendingBtn').addEventListener('click', () => {
      switchTab('spelling-quiz');
      document.getElementById('spCategorySelect').value = 'WRONG_PENDING';
      startSpQuiz();
    });

    document.getElementById('nbRetestAllBtn').addEventListener('click', () => {
      switchTab('mc-quiz');
      document.getElementById('mcCategorySelect').value = 'WRONG_ALL';
      startMcQuiz();
    });

    // 單字卡與題庫子分頁
    document.querySelectorAll('.subtab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-subtab');
        state.activeSubtab = target;
        document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.subtab-panel').forEach((p) => {
          p.classList.toggle('active', p.id === `subtab-${target}`);
        });
      });
    });

    document.getElementById('fcCategorySelect').addEventListener('change', refreshFlashcardsFilter);
    document.getElementById('fcLevelSelect').addEventListener('change', refreshFlashcardsFilter);
    document.getElementById('fcShuffleBtn').addEventListener('click', () => {
      state.flashcard.filteredWords = shuffleArray(state.flashcard.filteredWords);
      state.flashcard.currentIndex = 0;
      state.flashcard.flipped = false;
      renderCurrentFlashcard();
      showToast('已隨機洗牌單字卡順序！', 'success');
    });

    document.getElementById('flashcard3d').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      state.flashcard.flipped = !state.flashcard.flipped;
      renderCurrentFlashcard();
    });

    document.getElementById('fcFlipBtn').addEventListener('click', () => {
      state.flashcard.flipped = !state.flashcard.flipped;
      renderCurrentFlashcard();
    });

    document.getElementById('fcPrevBtn').addEventListener('click', () => {
      const fc = state.flashcard;
      if (fc.filteredWords.length === 0) return;
      fc.currentIndex = (fc.currentIndex - 1 + fc.filteredWords.length) % fc.filteredWords.length;
      fc.flipped = false;
      renderCurrentFlashcard();
    });

    document.getElementById('fcNextBtn').addEventListener('click', () => {
      const fc = state.flashcard;
      if (fc.filteredWords.length === 0) return;
      fc.currentIndex = (fc.currentIndex + 1) % fc.filteredWords.length;
      fc.flipped = false;
      renderCurrentFlashcard();
    });

    const speakCurrentFc = () => {
      const w = state.flashcard.filteredWords[state.flashcard.currentIndex];
      if (w) speakText(w.word);
    };
    document.getElementById('fcSpeakFrontBtn').addEventListener('click', speakCurrentFc);
    document.getElementById('fcSpeakWordBtn').addEventListener('click', speakCurrentFc);
    document.getElementById('fcSpeakBackBtn').addEventListener('click', () => {
      const w = state.flashcard.filteredWords[state.flashcard.currentIndex];
      if (w) speakText(w.example);
    });

    document.getElementById('fcToggleWrongBtn').addEventListener('click', async () => {
      if (!state.user) {
        openAuthModal();
        return;
      }
      const w = state.flashcard.filteredWords[state.flashcard.currentIndex];
      if (!w) return;
      const resp = await Api.request('/api/wrong-words/toggle', {
        method: 'POST',
        body: JSON.stringify({ wordId: w.id })
      });
      state.user = resp.user;
      updateAllUI();
      showToast('已更新錯題本狀態！', 'success');
    });

    // 題庫搜尋與自訂新增
    document.getElementById('vocabSearchInput').addEventListener('input', renderVocabList);
    document.getElementById('vocabCategoryFilter').addEventListener('change', renderVocabList);
    document.getElementById('vocabLevelFilter').addEventListener('change', renderVocabList);

    document.getElementById('addCustomWordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.user) {
        openAuthModal();
        return;
      }
      try {
        const payload = {
          word: document.getElementById('cwWord').value,
          pos: document.getElementById('cwPos').value,
          phonetic: document.getElementById('cwPhonetic').value,
          meaning: document.getElementById('cwMeaning').value,
          category: document.getElementById('cwCategory').value,
          level: document.getElementById('cwLevel').value,
          synonyms: document.getElementById('cwSynonyms').value,
          example: document.getElementById('cwExample').value,
          translation: document.getElementById('cwTranslation').value
        };
        const resp = await Api.request('/api/words', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        state.words.unshift(resp.word);
        e.target.reset();
        updateAllUI();
        showToast(`成功新增多益單字「${resp.word.word}」至題庫！`, 'success');
      } catch (err) {
        showToast(err.message, 'danger');
      }
    });

    // 登入 / 註冊視窗事件
    document.getElementById('exportDataBtn').addEventListener('click', () => {
      if (!state.user) {
        openAuthModal();
        showToast('請先登入以匯出您的個人錯題本與學習紀錄', 'warning');
        return;
      }
      const backup = {
        exportedAt: new Date().toISOString(),
        username: state.user.username,
        displayName: state.user.displayName,
        targetScore: state.user.targetScore,
        stats: state.user.stats || {},
        wrongWords: state.user.wrongWords || {},
        history: state.user.history || [],
        customWords: state.words.filter((w) => w.isCustom)
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `toeic-backup-${state.user.username}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('📤 已匯出錯題本與學習紀錄備份檔！可傳至手機或電腦匯入', 'success');
    });

    document.getElementById('importDataBtn').addEventListener('click', () => {
      if (!state.user) {
        openAuthModal();
        showToast('請先登入帳號後再匯入備份檔', 'warning');
        return;
      }
      document.getElementById('importFileInput').click();
    });

    document.getElementById('importFileInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const resp = await Api.request('/api/user/sync', {
          method: 'POST',
          body: JSON.stringify(data)
        });
        state.user = resp.user;
        const wordsResp = await Api.request('/api/words');
        if (wordsResp && Array.isArray(wordsResp.words)) {
          state.words = wordsResp.words;
        }
        updateAllUI();
        showToast('📥 成功還原錯題本與學習紀錄！', 'success');
      } catch (err) {
        showToast('匯入失敗：檔案格式不正確 (' + err.message + ')', 'danger');
      } finally {
        e.target.value = '';
      }
    });

    document.getElementById('authActionBtn').addEventListener('click', async () => {
      if (state.user) {
        const confirmLogout = confirm(`目前登入為「${state.user.displayName}」，是否要登出或切換帳號？`);
        if (!confirmLogout) return;
        await Api.request('/api/auth/logout', { method: 'POST' }).catch(() => {});
        state.token = '';
        state.user = null;
        localStorage.removeItem('toeic_auth_token');
        updateAllUI();
        openAuthModal();
      } else {
        openAuthModal();
      }
    });

    document.getElementById('closeAuthModalBtn').addEventListener('click', closeAuthModal);

    document.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-auth-tab');
        document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('authErrorAlert').classList.add('hidden');
        document.getElementById('loginForm').classList.toggle('hidden', mode !== 'login');
        document.getElementById('registerForm').classList.toggle('hidden', mode !== 'register');
      });
    });

    document.getElementById('demoQuickLoginBtn').addEventListener('click', () => {
      performLogin('demo', '123456');
    });

    document.getElementById('loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      performLogin(
        document.getElementById('loginUsername').value,
        document.getElementById('loginPassword').value
      );
    });

    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('authErrorAlert');
      errEl.classList.add('hidden');
      try {
        const payload = {
          username: document.getElementById('regUsername').value,
          displayName: document.getElementById('regDisplayName').value,
          password: document.getElementById('regPassword').value,
          targetScore: Number(document.getElementById('regTargetScore').value)
        };
        const data = await Api.request('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('toeic_auth_token', data.token);
        closeAuthModal();
        updateAllUI();
        showToast(`註冊成功！歡迎加入，${data.user.displayName}！`, 'success');
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });

    // 全域鍵盤快捷鍵支援
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        if (
          e.key === 'Enter' &&
          state.activeTab === 'spelling-quiz' &&
          state.spQuiz.active &&
          state.spQuiz.answered
        ) {
          e.preventDefault();
          document.getElementById('spNextQuestionBtn').click();
        }
        return;
      }

      if (state.activeTab === 'mc-quiz' && state.mcQuiz.active) {
        if (!state.mcQuiz.answered && ['1', '2', '3', '4'].includes(e.key)) {
          e.preventDefault();
          handleMcAnswer(Number(e.key) - 1);
        } else if (state.mcQuiz.answered && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          document.getElementById('mcNextQuestionBtn').click();
        } else if (e.key.toLowerCase() === 's') {
          document.getElementById('mcSpeakBtn').click();
        } else if (e.key.toLowerCase() === 'h') {
          e.preventDefault();
          document.getElementById('mcToggleHintBtn').click();
        }
      } else if (state.activeTab === 'spelling-quiz' && state.spQuiz.active) {
        if (state.spQuiz.answered && e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('spNextQuestionBtn').click();
        } else if (e.key.toLowerCase() === 'h') {
          e.preventDefault();
          document.getElementById('spToggleChineseBtn').click();
        }
      } else if (
        state.activeTab === 'flashcards' &&
        state.activeSubtab === 'fc-cards'
      ) {
        if (e.key === ' ') {
          e.preventDefault();
          document.getElementById('fcFlipBtn').click();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          document.getElementById('fcNextBtn').click();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          document.getElementById('fcPrevBtn').click();
        } else if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          document.getElementById('fcSpeakWordBtn').click();
        } else if (e.key.toLowerCase() === 'b') {
          e.preventDefault();
          document.getElementById('fcToggleWrongBtn').click();
        }
      }
    });
  }

  // ==================== 系統初始化 ====================
  async function initApp() {
    bindEvents();
    await Api.checkServer();

    try {
      const wordsResp = await Api.request('/api/words');
      if (wordsResp && Array.isArray(wordsResp.words) && wordsResp.words.length > 0) {
        state.words = wordsResp.words;
      }
    } catch (e) {
      // Keep fallback INITIAL_TOEIC_WORDS
    }

    if (state.token) {
      try {
        const meResp = await Api.request('/api/user/me');
        state.user = meResp.user;
      } catch (e) {
        state.token = '';
        localStorage.removeItem('toeic_auth_token');
      }
    }

    updateAllUI();

    if (!state.user) {
      openAuthModal();
    }
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();
