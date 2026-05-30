(() => {
  'use strict';

  const APP_VERSION = 2;
  const DB_NAME = 'pay-kakeibo-v2-db';
  const STORE_NAME = 'kv';
  const STATE_KEY = 'payKakeiboStateV2';
  const BACKUP_KEY = 'payKakeiboBackupHistoryV2';
  const LEGACY_BUDGET_KEY = 'budgetDataV7';
  const LEGACY_KAKEIBO_KEY = 'kakeiboData';
  const LEGACY_KAKEIBO_CATEGORIES_KEY = 'kakeiboCategories';
  const today = new Date();
  const currentYearMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  const defaultMainCategories = ['固定費', '変動費', '投資費'];
  const defaultKakeiboCategories = ['食費', '日用品', '交際費', '交通費', '給与', 'その他'];

  const $ = (id) => document.getElementById(id);
  const yen = (value) => `${Number(value || 0).toLocaleString()} 円`;
  const clone = (obj) => JSON.parse(JSON.stringify(obj));
  const createId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, '').replace(/[・･\/（）()]/g, '').toLowerCase();

  function normalizeAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.floor(amount);
  }

  function monthFromDate(dateStr) {
    return String(dateStr || '').slice(0, 7);
  }

  function isMonthKey(value) {
    return /^\d{4}-\d{2}$/.test(String(value || ''));
  }

  function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function csvEscape(value) {
    return `"${String(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  }

  function downloadText(filename, content, type = 'application/json') {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toast(message, actionLabel, action) {
    const host = $('toast');
    const item = document.createElement('div');
    item.className = 'toast-item';
    const span = document.createElement('span');
    span.textContent = message;
    item.appendChild(span);
    if (actionLabel && action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => {
        action();
        item.remove();
      });
      item.appendChild(btn);
    }
    host.appendChild(item);
    setTimeout(() => item.remove(), action ? 9000 : 3500);
  }

  const Storage = {
    provider: 'localStorage',
    db: null,
    async init() {
      if (!('indexedDB' in window)) return;
      try {
        this.db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        this.provider = 'IndexedDB';
      } catch (e) {
        this.provider = 'localStorage';
      }
    },
    async get(key) {
      if (!this.db) {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      }
      return new Promise((resolve) => {
        const tx = this.db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    },
    async set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
      if (!this.db) return;
      await new Promise((resolve) => {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
  };

  let state = null;
  let pendingImportState = null;
  let lastDeleted = null;

  function createEmptyState() {
    return {
      version: APP_VERSION,
      exportedAt: null,
      ui: { month: currentYearMonth, darkMode: false },
      budget: {},
      kakeibo: { entries: [], categories: [...defaultKakeiboCategories] },
      mappings: {},
      backups: []
    };
  }

  function ensureBudgetMonth(monthKey) {
    if (!state.budget[monthKey]) {
      state.budget[monthKey] = {
        incomes: [{ id: createId('income'), name: '給料', amount: 250000 }, { id: createId('income'), name: 'ボーナス', amount: 0 }],
        mainCategories: [...defaultMainCategories],
        items: []
      };
    }
    return state.budget[monthKey];
  }

  function migrateLegacy() {
    const newState = createEmptyState();
    try {
      const legacyBudget = JSON.parse(localStorage.getItem(LEGACY_BUDGET_KEY) || '{}');
      Object.entries(legacyBudget).forEach(([month, data]) => {
        if (!isMonthKey(month)) return;
        newState.budget[month] = {
          incomes: (data.incomes || []).map((inc) => ({ id: createId('income'), name: String(inc.name || '収入'), amount: normalizeAmount(inc.amount) ?? 0 })),
          mainCategories: Array.isArray(data.categories) ? data.categories.map(String) : [...defaultMainCategories],
          items: (data.items || []).map((item) => ({
            id: createId('budgetItem'),
            mainCat: String(item.mainCat || 'カテゴリ未設定'),
            name: String(item.name || '名称未設定'),
            amount: normalizeAmount(item.amount) ?? 0
          }))
        };
      });
    } catch (e) {}
    try {
      const legacyEntries = JSON.parse(localStorage.getItem(LEGACY_KAKEIBO_KEY) || '[]');
      if (Array.isArray(legacyEntries)) {
        newState.kakeibo.entries = legacyEntries.map((item) => ({
          id: createId('entry'),
          date: String(item.date || ''),
          type: item.type === '収入' ? '収入' : '支出',
          category: String(item.category || 'その他'),
          amount: normalizeAmount(item.amount) ?? 0,
          memo: String(item.memo || '')
        })).filter((item) => isDateKey(item.date));
      }
      const legacyCats = JSON.parse(localStorage.getItem(LEGACY_KAKEIBO_CATEGORIES_KEY) || '[]');
      if (Array.isArray(legacyCats) && legacyCats.length) newState.kakeibo.categories = [...new Set(legacyCats.map(String))];
    } catch (e) {}
    return newState;
  }

  async function loadState() {
    const saved = await Storage.get(STATE_KEY);
    if (saved && saved.version) {
      state = normalizeState(saved);
    } else {
      state = normalizeState(migrateLegacy());
    }
    applyDarkMode();
    ensureBudgetMonth(state.ui.month);
  }

  function normalizeState(input) {
    const base = createEmptyState();
    const s = { ...base, ...input };
    s.ui = { ...base.ui, ...(input.ui || {}) };
    s.budget = input.budget && typeof input.budget === 'object' ? input.budget : {};
    s.kakeibo = { ...base.kakeibo, ...(input.kakeibo || {}) };
    s.kakeibo.entries = Array.isArray(s.kakeibo.entries) ? s.kakeibo.entries : [];
    s.kakeibo.categories = Array.isArray(s.kakeibo.categories) && s.kakeibo.categories.length ? [...new Set(s.kakeibo.categories.map(String))] : [...defaultKakeiboCategories];
    s.mappings = input.mappings && typeof input.mappings === 'object' ? input.mappings : {};
    s.backups = Array.isArray(input.backups) ? input.backups.slice(-10) : [];
    s.version = APP_VERSION;
    if (!isMonthKey(s.ui.month)) s.ui.month = currentYearMonth;
    return s;
  }

  async function saveState() {
    await Storage.set(STATE_KEY, state);
  }

  async function saveAndRender() {
    await saveState();
    renderAll();
  }

  function getMonth() {
    return state.ui.month;
  }

  function setMonth(monthKey) {
    if (!isMonthKey(monthKey)) return;
    state.ui.month = monthKey;
    ensureBudgetMonth(monthKey);
    setFormDate();
    saveAndRender();
  }

  function makeBackup(reason = 'manual') {
    const snapshot = clone({ ...state, exportedAt: new Date().toISOString() });
    const item = { id: createId('backup'), reason, createdAt: new Date().toISOString(), state: snapshot };
    state.backups = [...(state.backups || []), item].slice(-10);
    localStorage.setItem(BACKUP_KEY, JSON.stringify(state.backups));
    return item;
  }

  async function createBackupAndSave(reason) {
    makeBackup(reason);
    await saveState();
    renderSettings();
  }

  function getBudgetSummary(monthKey) {
    const month = ensureBudgetMonth(monthKey);
    const income = month.incomes.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const itemTotals = {};
    const mainTotals = {};
    month.items.forEach((item) => {
      itemTotals[item.name] = (itemTotals[item.name] || 0) + Number(item.amount || 0);
      mainTotals[item.mainCat] = (mainTotals[item.mainCat] || 0) + Number(item.amount || 0);
    });
    const expense = Object.values(itemTotals).reduce((sum, value) => sum + value, 0);
    return { income, expense, remaining: income - expense, itemTotals, mainTotals, items: month.items };
  }

  function getActualSummary(monthKey) {
    const entries = state.kakeibo.entries.filter((entry) => monthFromDate(entry.date) === monthKey);
    let income = 0;
    let expense = 0;
    const categoryTotals = {};
    entries.forEach((entry) => {
      const amount = Number(entry.amount || 0);
      if (entry.type === '収入') income += amount;
      if (entry.type === '支出') {
        expense += amount;
        categoryTotals[entry.category] = (categoryTotals[entry.category] || 0) + amount;
      }
    });
    return { income, expense, remaining: income - expense, categoryTotals, entries };
  }

  function getPlanOptions(monthKey) {
    const budget = ensureBudgetMonth(monthKey);
    const names = new Set();
    budget.items.forEach((item) => names.add(item.name));
    budget.mainCategories.forEach((cat) => names.add(cat));
    return [...names].sort();
  }

  function mapActualCategory(actualCategory, monthKey) {
    const direct = state.mappings[actualCategory];
    if (direct) return direct;
    const planOptions = getPlanOptions(monthKey);
    const normalizedActual = normalizeName(actualCategory);
    const matched = planOptions.find((name) => normalizeName(name) === normalizedActual);
    return matched || actualCategory;
  }

  function getComparisonRows(monthKey) {
    const budget = getBudgetSummary(monthKey);
    const actual = getActualSummary(monthKey);
    const actualMapped = {};
    Object.entries(actual.categoryTotals).forEach(([category, amount]) => {
      const mapped = mapActualCategory(category, monthKey);
      actualMapped[mapped] = (actualMapped[mapped] || 0) + amount;
    });
    const names = [...new Set([...Object.keys(budget.itemTotals), ...Object.keys(actualMapped)])];
    return names.map((name) => {
      const plan = budget.itemTotals[name] || budget.mainTotals[name] || 0;
      const actualAmount = actualMapped[name] || 0;
      const gap = plan - actualAmount;
      const rate = plan > 0 ? Math.round((actualAmount / plan) * 100) : null;
      const main = budget.items.find((item) => item.name === name)?.mainCat || (budget.mainTotals[name] ? name : '未分類');
      return { name, main, plan, actual: actualAmount, gap, rate };
    }).sort((a, b) => Math.max(b.plan, b.actual) - Math.max(a.plan, a.actual));
  }

  function getStatus(row) {
    if (row.plan === 0 && row.actual > 0) return { label: '予定なし', cls: 'over' };
    if (row.rate === null) return { label: '未設定', cls: 'warn' };
    if (row.rate > 100) return { label: '超過', cls: 'over' };
    const now = new Date();
    const currentMonth = getMonth();
    const monthProgress = monthFromDate(now.toISOString()) === currentMonth
      ? Math.ceil((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100)
      : 100;
    if (row.rate > monthProgress + 20) return { label: 'ペース注意', cls: 'warn' };
    if (row.rate >= 80) return { label: '注意', cls: 'warn' };
    return { label: '余裕あり', cls: 'good' };
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function listRow(title, sub, amount, actions = []) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const main = document.createElement('div');
    main.className = 'list-main';
    const titleEl = document.createElement('div');
    titleEl.className = 'list-title';
    titleEl.textContent = title;
    const subEl = document.createElement('div');
    subEl.className = 'list-sub';
    subEl.textContent = sub;
    main.append(titleEl, subEl);
    const right = document.createElement('div');
    right.className = 'inline-form';
    const amountEl = document.createElement('strong');
    amountEl.textContent = amount;
    right.appendChild(amountEl);
    actions.forEach((action) => right.appendChild(action));
    row.append(main, right);
    return row;
  }

  function button(label, cls, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${cls || 'secondary'} small`;
    btn.textContent = label;
    btn.addEventListener('click', handler);
    return btn;
  }

  function deleteWithUndo(label, deleteFn, undoFn) {
    deleteFn();
    lastDeleted = undoFn;
    toast(`${label}を削除しました`, '元に戻す', async () => {
      if (lastDeleted) {
        lastDeleted();
        lastDeleted = null;
        await saveAndRender();
        toast('削除を取り消しました');
      }
    });
    saveAndRender();
  }

  function renderBudget() {
    const month = getMonth();
    const data = ensureBudgetMonth(month);
    const summary = getBudgetSummary(month);
    $('budgetIncomeTotal').textContent = yen(summary.income);
    $('budgetExpenseTotal').textContent = yen(summary.expense);
    $('budgetRemainingTotal').textContent = yen(summary.remaining);

    const incomes = $('budgetIncomeList'); clear(incomes);
    data.incomes.forEach((inc, index) => {
      const row = listRow(inc.name, '収入予定', yen(inc.amount), [
        button('削除', 'danger', () => deleteWithUndo('収入予定', () => data.incomes.splice(index, 1), () => data.incomes.splice(index, 0, inc)))
      ]);
      incomes.appendChild(row);
    });

    const catSelect = $('budgetMainCategorySelect'); clear(catSelect);
    data.mainCategories.forEach((cat) => {
      const opt = document.createElement('option'); opt.value = cat; opt.textContent = cat; catSelect.appendChild(opt);
    });

    const expenses = $('budgetExpenseList'); clear(expenses);
    data.mainCategories.forEach((mainCat) => {
      const items = data.items.filter((item) => item.mainCat === mainCat);
      const total = items.reduce((sum, item) => sum + item.amount, 0);
      const header = listRow(`📁 ${mainCat}`, '大カテゴリ', yen(total), [
        button('枠削除', 'danger', () => {
          const removedItems = data.items.filter((item) => item.mainCat === mainCat);
          deleteWithUndo('大カテゴリ', () => {
            data.mainCategories = data.mainCategories.filter((cat) => cat !== mainCat);
            data.items = data.items.filter((item) => item.mainCat !== mainCat);
          }, () => {
            data.mainCategories.push(mainCat);
            data.items.push(...removedItems);
          });
        })
      ]);
      expenses.appendChild(header);
      items.forEach((item) => {
        expenses.appendChild(listRow(item.name, mainCat, yen(item.amount), [
          button('削除', 'danger', () => deleteWithUndo('支出予定', () => data.items = data.items.filter((x) => x.id !== item.id), () => data.items.push(item)))
        ]));
      });
    });
  }

  function setFormDate() {
    const month = getMonth();
    const input = $('kakeiboDate');
    const todayStr = new Date().toISOString().slice(0, 10);
    input.value = todayStr.startsWith(month) ? todayStr : `${month}-01`;
  }

  function signedYen(value) {
    const amount = Number(value || 0);
    if (amount > 0) return `+${amount.toLocaleString()} 円`;
    if (amount < 0) return `-${Math.abs(amount).toLocaleString()} 円`;
    return '0 円';
  }

  function updateActualRemainingDesign(remaining) {
    const amount = Number(remaining || 0);
    const row = $('actualRemainingRow');
    const value = $('actualRemainingTotal');
    const status = $('actualRemainingStatus');
    if (!row || !value || !status) return;

    row.classList.remove('positive-balance', 'negative-balance', 'neutral-balance');
    value.textContent = signedYen(amount);

    if (amount > 0) {
      row.classList.add('positive-balance');
      status.textContent = '黒字';
    } else if (amount < 0) {
      row.classList.add('negative-balance');
      status.textContent = '赤字';
    } else {
      row.classList.add('neutral-balance');
      status.textContent = '収支ぴったり';
    }
  }

  function renderIncomeExpensePie(income, expense) {
    const pie = $('incomeExpensePie');
    const incomeLabel = $('pieIncomeLabel');
    const expenseLabel = $('pieExpenseLabel');
    const note = $('pieChartNote');
    if (!pie || !incomeLabel || !expenseLabel || !note) return;

    const incomeAmount = Math.max(0, Number(income || 0));
    const expenseAmount = Math.max(0, Number(expense || 0));
    const total = incomeAmount + expenseAmount;

    if (total <= 0) {
      pie.classList.add('empty');
      pie.style.background = 'conic-gradient(var(--line) 0 360deg)';
      incomeLabel.textContent = '0%';
      expenseLabel.textContent = '0%';
      note.textContent = '収入・支出の実績を入力すると円グラフが表示されます。';
      return;
    }

    const incomeRate = Math.round((incomeAmount / total) * 100);
    const expenseRate = 100 - incomeRate;
    const incomeDeg = (incomeAmount / total) * 360;

    pie.classList.remove('empty');
    pie.style.background = `conic-gradient(var(--success) 0deg ${incomeDeg}deg, var(--danger) ${incomeDeg}deg 360deg)`;
    incomeLabel.textContent = `${incomeRate}%`;
    expenseLabel.textContent = `${expenseRate}%`;
    note.textContent = `収入 ${yen(incomeAmount)} / 支出 ${yen(expenseAmount)} の比率です。`;
  }

  function renderKakeibo() {
    const month = getMonth();
    const summary = getActualSummary(month);
    $('actualIncomeTotal').textContent = yen(summary.income);
    $('actualExpenseTotal').textContent = yen(summary.expense);
    updateActualRemainingDesign(summary.remaining);
    renderIncomeExpensePie(summary.income, summary.expense);

    const categorySelect = $('kakeiboCategory'); clear(categorySelect);
    const historyCategoryFilter = $('historyCategoryFilter');
    const currentFilter = historyCategoryFilter.value;
    clear(historyCategoryFilter);
    const allOpt = document.createElement('option'); allOpt.value = 'all'; allOpt.textContent = '全カテゴリ'; historyCategoryFilter.appendChild(allOpt);
    state.kakeibo.categories.forEach((cat) => {
      const opt = document.createElement('option'); opt.value = cat; opt.textContent = cat; categorySelect.appendChild(opt);
      const opt2 = document.createElement('option'); opt2.value = cat; opt2.textContent = cat; historyCategoryFilter.appendChild(opt2);
    });
    historyCategoryFilter.value = state.kakeibo.categories.includes(currentFilter) ? currentFilter : 'all';

    const tags = $('kakeiboCategoryTags'); clear(tags);
    state.kakeibo.categories.forEach((cat) => {
      const tag = document.createElement('span'); tag.className = 'tag';
      const text = document.createElement('span'); text.textContent = cat;
      const del = button('×', 'danger', () => {
        deleteWithUndo('カテゴリ', () => state.kakeibo.categories = state.kakeibo.categories.filter((x) => x !== cat), () => state.kakeibo.categories.push(cat));
      });
      tag.append(text, del); tags.appendChild(tag);
    });

    const catList = $('actualCategoryList'); clear(catList);
    Object.entries(summary.categoryTotals).sort((a, b) => b[1] - a[1]).forEach(([cat, total]) => catList.appendChild(listRow(cat, '支出実績', yen(total))));

    renderHistory();
  }

  function renderHistory() {
    const month = getMonth();
    const keyword = $('historyKeyword').value.trim().toLowerCase();
    const type = $('historyTypeFilter').value;
    const category = $('historyCategoryFilter').value;
    const list = $('historyList'); clear(list);
    state.kakeibo.entries
      .filter((entry) => monthFromDate(entry.date) === month)
      .filter((entry) => type === 'all' || entry.type === type)
      .filter((entry) => category === 'all' || entry.category === category)
      .filter((entry) => !keyword || `${entry.category} ${entry.memo}`.toLowerCase().includes(keyword))
      .sort((a, b) => b.date.localeCompare(a.date))
      .forEach((entry) => {
        const row = document.createElement('div'); row.className = 'history-row';
        const left = document.createElement('div'); left.className = 'list-main';
        const title = document.createElement('div'); title.className = 'list-title'; title.textContent = `[${entry.date}] ${entry.category}`;
        const sub = document.createElement('div'); sub.className = 'list-sub'; sub.textContent = `${entry.type} / ${entry.memo || 'メモなし'}`;
        left.append(title, sub);
        const right = document.createElement('div'); right.className = 'inline-form';
        const amount = document.createElement('strong'); amount.textContent = yen(entry.amount); right.appendChild(amount);
        right.appendChild(button('削除', 'danger', () => deleteWithUndo('履歴', () => state.kakeibo.entries = state.kakeibo.entries.filter((x) => x.id !== entry.id), () => state.kakeibo.entries.push(entry))));
        row.append(left, right); list.appendChild(row);
      });
  }

  function renderMappings() {
    const month = getMonth();
    const host = $('mappingList'); clear(host);
    const actualCategories = [...new Set([...state.kakeibo.categories, ...Object.keys(getActualSummary(month).categoryTotals)])];
    const planOptions = getPlanOptions(month);
    actualCategories.forEach((actual) => {
      const row = document.importNode($('mappingTemplate').content, true).firstElementChild;
      const actualSel = row.querySelector('.mapping-actual');
      const planSel = row.querySelector('.mapping-plan');
      actualCategories.forEach((cat) => { const opt = document.createElement('option'); opt.value = cat; opt.textContent = cat; actualSel.appendChild(opt); });
      ['未設定', ...planOptions].forEach((plan) => { const opt = document.createElement('option'); opt.value = plan === '未設定' ? '' : plan; opt.textContent = plan; planSel.appendChild(opt); });
      actualSel.value = actual;
      planSel.value = state.mappings[actual] || '';
      const update = async () => {
        const oldActual = actual;
        delete state.mappings[oldActual];
        if (planSel.value) state.mappings[actualSel.value] = planSel.value;
        await saveAndRender();
      };
      actualSel.addEventListener('change', update);
      planSel.addEventListener('change', update);
      row.querySelector('.mapping-delete').addEventListener('click', async () => { delete state.mappings[actual]; await saveAndRender(); });
      host.appendChild(row);
    });
  }

  function renderCompare() {
    const month = getMonth();
    const budget = getBudgetSummary(month);
    const actual = getActualSummary(month);
    const rows = getComparisonRows(month);
    const expenseGap = budget.expense - actual.expense;
    const expenseRate = budget.expense > 0 ? Math.round((actual.expense / budget.expense) * 100) : 0;
    const cards = [
      ['収入予定', yen(budget.income), '給与運用の収入合計'], ['収入実績', yen(actual.income), '家計簿の収入合計'],
      ['支出予定', yen(budget.expense), '給与運用の支出合計'], ['支出実績', yen(actual.expense), '家計簿の支出合計'],
      ['予定残額', yen(budget.remaining), '収入予定 − 支出予定'], ['実績残額', yen(actual.remaining), '収入実績 − 支出実績'],
      ['支出差額', `${expenseGap >= 0 ? '+' : ''}${yen(expenseGap)} ${expenseGap >= 0 ? '予算内' : '超過'}`, '支出予定 − 支出実績'],
      ['支出消化率', `${expenseRate}%`, '支出実績 ÷ 支出予定']
    ];
    const cardHost = $('compareCards'); clear(cardHost);
    cards.forEach(([title, value, sub]) => {
      const card = document.createElement('div'); card.className = 'card summary-card';
      const h = document.createElement('h3'); h.textContent = title;
      const strong = document.createElement('strong'); strong.textContent = value; strong.className = value.includes('超過') ? 'negative' : '';
      const p = document.createElement('p'); p.className = 'hint'; p.textContent = sub;
      card.append(h, strong, p); cardHost.appendChild(card);
    });

    renderMappings();
    const body = $('compareTableBody'); clear(body);
    const mobile = $('compareMobileCards'); clear(mobile);
    rows.forEach((row) => {
      const status = getStatus(row);
      const tr = document.createElement('tr');
      const cells = [row.name, row.main, yen(row.plan), yen(row.actual), `${row.gap >= 0 ? '+' : ''}${yen(row.gap)} ${row.gap >= 0 ? '予算内' : '超過'}`];
      cells.forEach((value, i) => { const td = document.createElement('td'); td.textContent = value; if (i >= 2) td.className = `num ${i === 4 && row.gap < 0 ? 'negative' : ''}`; tr.appendChild(td); });
      const rateTd = document.createElement('td');
      const wrap = document.createElement('div'); wrap.className = 'inline-form';
      const prog = document.createElement('div'); prog.className = 'progress';
      const fill = document.createElement('span'); fill.style.width = `${Math.min(row.rate ?? 100, 100)}%`; prog.appendChild(fill);
      const pct = document.createElement('span'); pct.textContent = row.rate === null ? '-' : `${row.rate}%`;
      wrap.append(prog, pct); rateTd.appendChild(wrap); tr.appendChild(rateTd);
      const statusTd = document.createElement('td'); const badge = document.createElement('span'); badge.className = `badge ${status.cls}`; badge.textContent = status.label; statusTd.appendChild(badge); tr.appendChild(statusTd);
      body.appendChild(tr);

      const mc = document.createElement('div'); mc.className = 'mobile-compare-card';
      [['項目', row.name], ['分類', row.main], ['予定', yen(row.plan)], ['実績', yen(row.actual)], ['差額', `${row.gap >= 0 ? '+' : ''}${yen(row.gap)} ${row.gap >= 0 ? '予算内' : '超過'}`], ['状態', status.label]].forEach(([k, v]) => {
        const div = document.createElement('div'); div.className = 'summary-row';
        const s = document.createElement('span'); s.textContent = k;
        const b = document.createElement('strong'); b.textContent = v;
        div.append(s, b); mc.appendChild(div);
      });
      mobile.appendChild(mc);
    });

    const insights = $('compareInsights'); clear(insights);
    const unmatched = Object.keys(actual.categoryTotals).filter((cat) => !state.mappings[cat] && !Object.prototype.hasOwnProperty.call(budget.itemTotals, cat));
    [
      ['収入差額', yen(actual.income - budget.income), actual.income - budget.income >= 0 ? 'positive' : 'negative'],
      ['残額差額', yen(actual.remaining - budget.remaining), actual.remaining - budget.remaining >= 0 ? 'positive' : 'negative'],
      ['予定未登録カテゴリ', `${unmatched.length} 件`, unmatched.length ? 'negative' : 'positive'],
      ['支出状況', expenseGap >= 0 ? `${yen(expenseGap)} 予算内` : `${yen(Math.abs(expenseGap))} 超過`, expenseGap >= 0 ? 'positive' : 'negative']
    ].forEach(([label, value, cls]) => {
      const row = document.createElement('div'); row.className = 'insight-row';
      const l = document.createElement('span'); l.textContent = label;
      const v = document.createElement('strong'); v.textContent = value; v.className = cls;
      row.append(l, v); insights.appendChild(row);
    });
    if (unmatched.length) insights.appendChild(listRow('予定側にない実績カテゴリ', unmatched.join('、'), '対応表で設定してください'));
  }

  function renderReports() {
    const trend = $('trendBars'); clear(trend);
    const months = [...new Set([...Object.keys(state.budget), ...state.kakeibo.entries.map((e) => monthFromDate(e.date)).filter(Boolean)])].sort();
    const max = Math.max(1, ...months.flatMap((m) => [getBudgetSummary(m).expense, getActualSummary(m).expense]));
    months.slice(-12).forEach((m) => {
      const b = getBudgetSummary(m); const a = getActualSummary(m);
      const row = document.createElement('div'); row.className = 'bar-row';
      const label = document.createElement('strong'); label.textContent = m;
      const track = document.createElement('div'); track.className = 'bar-track';
      const fill = document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = `${Math.max(b.expense, a.expense) / max * 100}%`; track.appendChild(fill);
      const value = document.createElement('span'); value.textContent = `予:${b.expense.toLocaleString()} / 実:${a.expense.toLocaleString()}`;
      row.append(label, track, value); trend.appendChild(row);
    });

    const year = getMonth().slice(0, 4);
    const yearMonths = months.filter((m) => m.startsWith(year));
    const total = yearMonths.reduce((acc, m) => {
      const b = getBudgetSummary(m); const a = getActualSummary(m);
      acc.bIncome += b.income; acc.bExpense += b.expense; acc.aIncome += a.income; acc.aExpense += a.expense; return acc;
    }, { bIncome: 0, bExpense: 0, aIncome: 0, aExpense: 0 });
    const ys = $('yearSummary'); clear(ys);
    [['年間収入予定', total.bIncome], ['年間収入実績', total.aIncome], ['年間支出予定', total.bExpense], ['年間支出実績', total.aExpense], ['年間実績残額', total.aIncome - total.aExpense]].forEach(([label, val]) => ys.appendChild(listRow(label, `${year}年`, yen(val))));

    const main = $('mainCategoryCompare'); clear(main);
    const budget = getBudgetSummary(getMonth());
    const actual = getActualSummary(getMonth());
    const actualByMain = {};
    Object.entries(actual.categoryTotals).forEach(([cat, value]) => {
      const mapped = mapActualCategory(cat, getMonth());
      const mainCat = ensureBudgetMonth(getMonth()).items.find((item) => item.name === mapped)?.mainCat || mapped;
      actualByMain[mainCat] = (actualByMain[mainCat] || 0) + value;
    });
    const mainNames = [...new Set([...Object.keys(budget.mainTotals), ...Object.keys(actualByMain)])];
    const mainMax = Math.max(1, ...mainNames.flatMap((name) => [budget.mainTotals[name] || 0, actualByMain[name] || 0]));
    mainNames.forEach((name) => {
      const row = document.createElement('div'); row.className = 'bar-row';
      const label = document.createElement('strong'); label.textContent = name;
      const track = document.createElement('div'); track.className = 'bar-track';
      const fill = document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = `${Math.max(budget.mainTotals[name] || 0, actualByMain[name] || 0) / mainMax * 100}%`; track.appendChild(fill);
      const value = document.createElement('span'); value.textContent = `予:${(budget.mainTotals[name] || 0).toLocaleString()} / 実:${(actualByMain[name] || 0).toLocaleString()}`;
      row.append(label, track, value); main.appendChild(row);
    });
  }

  function renderSettings() {
    const status = $('storageStatus'); clear(status);
    [['保存方式', Storage.provider], ['データ形式', `version ${APP_VERSION}`], ['対象月', getMonth()], ['バックアップ件数', `${(state.backups || []).length} 件`]].forEach(([k, v]) => {
      const div = document.createElement('div'); div.className = 'storage-pill';
      const a = document.createElement('span'); a.textContent = k; const b = document.createElement('strong'); b.textContent = v; div.append(a, b); status.appendChild(div);
    });
    const list = $('backupList'); clear(list);
    (state.backups || []).slice().reverse().forEach((bk) => {
      list.appendChild(listRow(new Date(bk.createdAt).toLocaleString('ja-JP'), bk.reason, '復元可能', [
        button('復元', 'warn', async () => {
          makeBackup('restore-before');
          state = normalizeState(bk.state);
          await saveAndRender(); toast('バックアップを復元しました');
        })
      ]));
    });
  }

  function applyDarkMode() {
    document.body.classList.toggle('dark', Boolean(state?.ui?.darkMode));
  }

  function renderAll() {
    $('globalMonth').value = getMonth();
    applyDarkMode();
    renderBudget(); renderKakeibo(); renderCompare(); renderReports(); renderSettings();
  }

  function validateState(imported) {
    const errors = [];
    if (!imported || typeof imported !== 'object') errors.push('JSONの最上位がオブジェクトではありません。');
    const s = normalizeState(imported || {});
    Object.entries(s.budget).forEach(([month, data]) => {
      if (!isMonthKey(month)) errors.push(`給与運用の月キーが不正です: ${month}`);
      if (!Array.isArray(data.incomes)) errors.push(`${month}: incomes が配列ではありません。`);
      if (!Array.isArray(data.items)) errors.push(`${month}: items が配列ではありません。`);
      (data.incomes || []).forEach((inc) => { if (normalizeAmount(inc.amount) === null) errors.push(`${month}: 収入金額が不正です。`); });
      (data.items || []).forEach((item) => { if (normalizeAmount(item.amount) === null) errors.push(`${month}: 支出金額が不正です。`); });
    });
    s.kakeibo.entries.forEach((entry) => {
      if (!isDateKey(entry.date)) errors.push(`家計簿の日付が不正です: ${entry.date}`);
      if (!['収入', '支出'].includes(entry.type)) errors.push(`家計簿の種別が不正です: ${entry.type}`);
      if (normalizeAmount(entry.amount) === null) errors.push(`家計簿の金額が不正です: ${entry.amount}`);
    });
    return { ok: errors.length === 0, errors, state: s };
  }

  function renderImportPreview(result) {
    const host = $('importPreview'); clear(host);
    if (!result.ok) {
      host.appendChild(listRow('読み込み不可', result.errors.slice(0, 5).join(' / '), `${result.errors.length} 件`));
      pendingImportState = null;
      return;
    }
    pendingImportState = result.state;
    const months = Object.keys(result.state.budget).length;
    const entries = result.state.kakeibo.entries.length;
    const categories = result.state.kakeibo.categories.length;
    host.appendChild(listRow('復元候補', `給与運用 ${months}か月 / 家計簿 ${entries}件 / カテゴリ ${categories}件`, '確認済み', [
      button('復元する', 'warn', async () => {
        makeBackup('before-import');
        state = normalizeState(pendingImportState);
        pendingImportState = null;
        await saveAndRender();
        toast('データを復元しました');
      })
    ]));
  }

  function exportAll() {
    const output = { ...clone(state), exportedAt: new Date().toISOString(), version: APP_VERSION };
    downloadText(`給与運用_家計簿_v2_backup_${getMonth()}.json`, JSON.stringify(output, null, 2));
  }

  function exportKakeiboCsv() {
    const rows = [['日付', '種別', 'カテゴリ', '金額', 'メモ'], ...state.kakeibo.entries.map((e) => [e.date, e.type, e.category, e.amount, e.memo])];
    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
    downloadText(`家計簿_${getMonth()}.csv`, csv, 'text/csv');
  }

  function bindEvents() {
    document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.page).classList.add('active');
      renderAll();
    }));

    $('globalMonth').addEventListener('change', (e) => setMonth(e.target.value));
    $('toggleDarkBtn').addEventListener('click', async () => { state.ui.darkMode = !state.ui.darkMode; await saveAndRender(); });
    $('exportAllBtn').addEventListener('click', exportAll);
    $('importAllBtn').addEventListener('click', () => $('importAllFile').click());
    $('importAllFile').addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try { renderImportPreview(validateState(JSON.parse(reader.result))); }
        catch (err) { renderImportPreview({ ok: false, errors: ['JSONとして読み込めません。'] }); }
      };
      reader.readAsText(file); e.target.value = '';
    });

    $('budgetIncomeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('budgetIncomeName').value.trim(); const amount = normalizeAmount($('budgetIncomeAmount').value);
      if (!name || amount === null) return toast('収入名と金額を正しく入力してください');
      ensureBudgetMonth(getMonth()).incomes.push({ id: createId('income'), name, amount });
      $('budgetIncomeName').value = ''; $('budgetIncomeAmount').value = ''; await saveAndRender(); toast('収入予定を追加しました');
    });
    $('budgetCategoryForm').addEventListener('submit', async (e) => {
      e.preventDefault(); const name = $('budgetMainCategoryName').value.trim(); const data = ensureBudgetMonth(getMonth());
      if (!name) return toast('大カテゴリ名を入力してください');
      if (data.mainCategories.includes(name)) return toast('同じ大カテゴリが既にあります');
      data.mainCategories.push(name); $('budgetMainCategoryName').value = ''; await saveAndRender();
    });
    $('budgetItemForm').addEventListener('submit', async (e) => {
      e.preventDefault(); const mainCat = $('budgetMainCategorySelect').value; const name = $('budgetItemName').value.trim(); const amount = normalizeAmount($('budgetItemAmount').value);
      if (!mainCat || !name || amount === null) return toast('支出項目と金額を正しく入力してください');
      ensureBudgetMonth(getMonth()).items.push({ id: createId('budgetItem'), mainCat, name, amount });
      $('budgetItemName').value = ''; $('budgetItemAmount').value = ''; await saveAndRender(); toast('支出予定を追加しました');
    });
    $('copyPrevBudgetBtn').addEventListener('click', async () => {
      const [y, m] = getMonth().split('-').map(Number); const prev = new Date(y, m - 2, 1); const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
      if (!state.budget[prevKey]) return toast(`前月（${prevKey}）のデータがありません`);
      makeBackup('before-copy-previous');
      state.budget[getMonth()] = clone(state.budget[prevKey]);
      state.budget[getMonth()].incomes.forEach((i) => i.id = createId('income'));
      state.budget[getMonth()].items.forEach((i) => i.id = createId('budgetItem'));
      await saveAndRender(); toast('前月データをコピーしました');
    });

    $('kakeiboForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const date = $('kakeiboDate').value; const type = $('kakeiboType').value; const category = $('kakeiboCategory').value; const amount = normalizeAmount($('kakeiboAmount').value); const memo = $('kakeiboMemo').value.trim();
      if (!isDateKey(date) || !['収入', '支出'].includes(type) || !category || amount === null) return toast('家計簿の入力内容を確認してください');
      state.kakeibo.entries.push({ id: createId('entry'), date, type, category, amount, memo });
      if (monthFromDate(date) !== getMonth()) state.ui.month = monthFromDate(date);
      $('kakeiboAmount').value = ''; $('kakeiboMemo').value = ''; await saveAndRender(); toast('家計簿に追加しました');
    });
    $('kakeiboCategoryForm').addEventListener('submit', async (e) => {
      e.preventDefault(); const name = $('kakeiboNewCategory').value.trim();
      if (!name) return toast('カテゴリ名を入力してください');
      if (state.kakeibo.categories.includes(name)) return toast('同じカテゴリが既にあります');
      state.kakeibo.categories.push(name); $('kakeiboNewCategory').value = ''; await saveAndRender();
    });
    ['historyKeyword', 'historyTypeFilter', 'historyCategoryFilter'].forEach((id) => $(id).addEventListener('input', renderHistory));
    $('exportKakeiboCsvBtn').addEventListener('click', exportKakeiboCsv);

    $('autoMappingBtn').addEventListener('click', async () => {
      const month = getMonth(); const planOptions = getPlanOptions(month); let count = 0;
      state.kakeibo.categories.forEach((cat) => {
        if (state.mappings[cat]) return;
        const normalized = normalizeName(cat);
        const found = planOptions.find((p) => normalizeName(p).includes(normalized) || normalized.includes(normalizeName(p)));
        if (found) { state.mappings[cat] = found; count++; }
      });
      await saveAndRender(); toast(`${count}件の対応候補を設定しました`);
    });
    $('addMappingBtn').addEventListener('click', async () => { toast('対応表はカテゴリ一覧から選択して設定できます'); renderMappings(); });
    $('printReportBtn').addEventListener('click', () => window.print());
    $('makeBackupBtn').addEventListener('click', async () => { await createBackupAndSave('manual'); toast('バックアップを作成しました'); });
  }

  async function init() {
    await Storage.init();
    await loadState();
    bindEvents();
    setFormDate();
    await saveState();
    renderAll();
  }

  init();


  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

})();
