const socket = io();

const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 99: 'JOKER' };
const SUIT_MARK = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);
const TITLE_ORDER = ['大富豪', '富豪', '平民', '貧民', '大貧民'];
const DECLARABLE_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const RULE_LABELS = {
  straights: '階段（同スート連番で3枚以上出せる）',
  bomberQ: '12ボンバー（Qで指定ランク全捨て）',
  ak: 'AK（場が空・2枚渡して手番続行）',
  sevenGive: '7渡し（枚数分カードを次へ）',
  tenDiscard: '10捨て（枚数分カードを除外）',
  jBack: 'Jバック（流れるまで革命反転）',
  ambulance: '救急車（9×2で墓地1枚回収）',
  shakaHoonko: '釈迦・報恩講（相手の手札から1枚）',
  nightingale: 'ナイチンゲール（9+Aで墓地回収）',
  miyakoOchi: '都落ち（前回最下位が1位→交代）',
  cardExchange: 'カード交換（順位でカードを交換）',
};
const RULE_ORDER = ['straights', 'bomberQ', 'ak', 'sevenGive', 'tenDiscard', 'jBack', 'ambulance', 'shakaHoonko', 'nightingale', 'miyakoOchi', 'cardExchange'];

let myId = null;
let currentRoom = null;
let selectedIds = new Set();

const screens = {
  lobby: document.getElementById('screen-lobby'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  roundend: document.getElementById('screen-roundend'),
  exchange: document.getElementById('screen-exchange'),
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2400);
}

socket.on('connect', () => {
  myId = socket.id;
  const saved = loadSession();
  if (saved) {
    socket.emit('rejoin', saved);
  }
});

socket.on('rejoin-failed', () => {
  clearSession();
  toast('前のセッションが見つかりませんでした。最初からやり直してください');
});

function saveSession(roomId, token) {
  try { sessionStorage.setItem('daihinmin_session', JSON.stringify({ roomId, token })); } catch (e) { /* ignore */ }
}
function loadSession() {
  try {
    const raw = sessionStorage.getItem('daihinmin_session');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem('daihinmin_session'); } catch (e) { /* ignore */ }
}

let wasDisconnected = false;
socket.on('disconnect', () => {
  wasDisconnected = true;
  toast('接続が切れました。再接続しています…');
});
socket.io.on('reconnect', () => {
  if (wasDisconnected) {
    wasDisconnected = false;
    toast('再接続しました！');
  }
});

// ---------- ロビー ----------
document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim() || 'プレイヤー';
  socket.emit('create-room', { name });
});
document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim() || 'プレイヤー';
  const roomId = document.getElementById('input-roomid').value.trim();
  if (!roomId) { document.getElementById('lobby-error').textContent = '部屋コードを入力してください'; return; }
  socket.emit('join-room', { name, roomId });
});
document.getElementById('btn-start').addEventListener('click', () => socket.emit('start-game'));
document.getElementById('btn-next-round').addEventListener('click', () => socket.emit('next-round'));
document.getElementById('btn-back').addEventListener('click', () => { socket.emit('leave-room'); clearSession(); location.reload(); });
document.getElementById('btn-leave-waiting').addEventListener('click', () => { socket.emit('leave-room'); clearSession(); location.reload(); });
document.getElementById('btn-leave-game').addEventListener('click', () => {
  if (confirm('本当に退出しますか？ゲームが中断されます')) {
    socket.emit('leave-room'); clearSession(); location.reload();
  }
});

socket.on('error-message', msg => {
  document.getElementById('lobby-error').textContent = msg;
  toast(msg);
});

// ---------- 状態受信 ----------
socket.on('room-state', room => {
  currentRoom = room;
  if (room.yourToken) saveSession(room.id, room.yourToken);
  if (room.phase !== 'playing' && room.phase !== 'exchange') selectedIds = new Set();

  if (room.phase === 'waiting') { renderWaiting(room); showScreen('waiting'); }
  else if (room.phase === 'playing') { selectedIds = pruneSelection(selectedIds, room); renderGame(room); showScreen('game'); }
  else if (room.phase === 'exchange') { selectedIds = pruneSelection(selectedIds, room); renderExchange(room); showScreen('exchange'); }
  else if (room.phase === 'ended') { renderRoundEnd(room); showScreen('roundend'); }

  document.getElementById('btn-chat-toggle').classList.remove('hidden');
  renderChat(room);
  checkEffect(room);
});

function pruneSelection(set, room) {
  const me = room.players.find(p => p.isYou);
  if (!me || !me.hand) return new Set();
  const ids = new Set(me.hand.map(c => c.id));
  return new Set([...set].filter(id => ids.has(id)));
}

// ---------- チャット ----------
let chatOpen = false;
let lastSeenChatCount = 0;

function renderChat(room) {
  const messages = room.chat || [];
  const listEl = document.getElementById('chat-messages');
  const wasAtBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
  listEl.innerHTML = messages.map(m => {
    const isSelf = room.players.some(p => p.isYou && p.name === m.name);
    return `<div class="chat-msg${isSelf ? ' self' : ''}"><span class="chat-name">${escapeHtml(m.name)}</span><span class="chat-text">${escapeHtml(m.text)}</span></div>`;
  }).join('');
  if (chatOpen || wasAtBottom) listEl.scrollTop = listEl.scrollHeight;

  if (chatOpen) {
    lastSeenChatCount = messages.length;
    document.getElementById('chat-unread').classList.add('hidden');
  } else if (messages.length > lastSeenChatCount) {
    const unread = messages.length - lastSeenChatCount;
    const badge = document.getElementById('chat-unread');
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.remove('hidden');
  }
}

function openChat() {
  chatOpen = true;
  document.getElementById('chat-panel').classList.remove('hidden');
  if (currentRoom) {
    lastSeenChatCount = (currentRoom.chat || []).length;
    document.getElementById('chat-unread').classList.add('hidden');
    const listEl = document.getElementById('chat-messages');
    listEl.scrollTop = listEl.scrollHeight;
  }
}
function closeChat() {
  chatOpen = false;
  document.getElementById('chat-panel').classList.add('hidden');
}

document.getElementById('btn-chat-toggle').addEventListener('click', () => {
  if (chatOpen) closeChat(); else openChat();
});
document.getElementById('btn-chat-close').addEventListener('click', closeChat);

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('send-chat', { text });
  input.value = '';
}
document.getElementById('btn-chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
});

// ---------- 待機画面 ----------
function renderWaiting(room) {
  document.getElementById('room-code-display').textContent = room.id;
  const list = document.getElementById('waiting-players');
  list.innerHTML = '';
  room.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.isYou ? '（あなた）' : ''}</span>` +
      (p.id === room.hostId ? '<span class="host-tag">部屋主</span>' : '');
    list.appendChild(li);
  });

  const isHost = room.hostId === myId;
  renderRulesPanel(room, isHost);

  const canStart = isHost && room.players.length >= 2 && room.players.length <= 6;
  const btn = document.getElementById('btn-start');
  btn.disabled = !canStart;
  btn.textContent = isHost ? 'ゲーム開始' : '部屋主の開始を待っています';
}

function renderRulesPanel(room, isHost) {
  const panel = document.getElementById('rules-panel');
  panel.innerHTML = '';
  RULE_ORDER.forEach(key => {
    const on = !!room.rules[key];
    const row = document.createElement('div');
    row.className = 'rule-row' + (on ? ' on' : '') + (isHost ? '' : ' locked');
    row.innerHTML = `<span class="rule-name">${RULE_LABELS[key]}</span><span class="rule-toggle">${on ? 'ON' : 'OFF'}</span>`;
    if (isHost) {
      row.addEventListener('click', () => socket.emit('toggle-rule', { ruleKey: key, value: !on }));
    }
    panel.appendChild(row);
  });
  document.getElementById('rules-readonly-hint').classList.toggle('hidden', isHost);
}

// ---------- カード描画 ----------
function cardLabel(card) { return card.rank === 99 ? 'JOKER' : (RANK_LABEL[card.rank] || String(card.rank)); }

function buildCardEl(card, { onClick, selected } = {}) {
  const div = document.createElement('div');
  div.className = 'card';
  if (card.rank === 99) div.classList.add('joker');
  else div.classList.add(RED_SUITS.has(card.suit) ? 'red' : 'black');

  if (card.rank !== 99) {
    const cornerTL = document.createElement('div');
    cornerTL.className = 'corner';
    cornerTL.innerHTML = `<span>${cardLabel(card)}</span><span class="csuit">${SUIT_MARK[card.suit]}</span>`;
    div.appendChild(cornerTL);
    const cornerBR = document.createElement('div');
    cornerBR.className = 'corner br';
    cornerBR.innerHTML = `<span>${cardLabel(card)}</span><span class="csuit">${SUIT_MARK[card.suit]}</span>`;
    div.appendChild(cornerBR);
  }

  const rank = document.createElement('div');
  rank.className = 'rank';
  rank.textContent = cardLabel(card);
  div.appendChild(rank);
  if (card.rank !== 99) {
    const suit = document.createElement('div');
    suit.className = 'suit';
    suit.textContent = SUIT_MARK[card.suit];
    div.appendChild(suit);
  }
  div.dataset.id = card.id;
  if (selected) div.classList.add('selected');
  if (onClick) div.addEventListener('click', onClick);
  return div;
}

function buildCardBackFan(count) {
  const wrap = document.createElement('div');
  wrap.className = 'opp-hand-fan';
  const shown = Math.min(count, 8);
  for (let i = 0; i < shown; i++) {
    const back = document.createElement('div');
    back.className = 'card-back';
    wrap.appendChild(back);
  }
  if (count > shown) {
    const more = document.createElement('span');
    more.className = 'overflow-count';
    more.textContent = `+${count - shown}`;
    wrap.appendChild(more);
  }
  return wrap;
}

// ---------- ゲーム画面 ----------
function renderGame(room) {
  document.getElementById('round-label').textContent = room.roundNumber ? `第${room.roundNumber}ラウンド` : '';

  const oppWrap = document.getElementById('opponents');
  oppWrap.innerHTML = '';
  room.players.filter(p => !p.isYou).forEach(p => {
    const card = document.createElement('div');
    card.className = 'opp-card';
    if (p.id === room.turnPlayerId) card.classList.add('active-turn');
    if (p.finished) card.classList.add('finished');
    card.innerHTML = `
      <div class="opp-name">${escapeHtml(p.name)}${!p.connected ? ' <span class="disconnected-mark">(切断)</span>' : ''}</div>
      <div class="opp-count">${p.finished ? '上がり' : `残り ${p.handCount} 枚`}</div>
      ${p.placement ? `<div class="opp-placement">${p.placement}</div>` : ''}
    `;
    if (!p.finished && p.handCount > 0) card.appendChild(buildCardBackFan(p.handCount));
    oppWrap.appendChild(card);
  });

  const fieldWrap = document.getElementById('field-area');
  fieldWrap.innerHTML = '';
  if (room.field.count > 0) {
    room.field.cards.forEach(c => fieldWrap.appendChild(buildCardEl(c)));
  } else {
    const empty = document.createElement('div');
    empty.className = 'field-empty';
    empty.textContent = '場は空です（何を出してもOK）';
    fieldWrap.appendChild(empty);
  }

  document.getElementById('revolution-badge').classList.toggle('hidden', !room.revolution);

  const me = room.players.find(p => p.isYou);
  const turnPlayer = room.players.find(p => p.id === room.turnPlayerId);
  const indicator = document.getElementById('turn-indicator');
  if (room.pendingAction) indicator.textContent = room.pendingAction.reason || '特殊効果を処理中…';
  else if (room.pendingOtherName) indicator.textContent = `${room.pendingOtherName} が処理中…`;
  else if (me && me.finished) indicator.textContent = 'あなたは上がりました。他のプレイヤーを待っています…';
  else if (turnPlayer) indicator.textContent = turnPlayer.isYou ? 'あなたの番です' : `${turnPlayer.name} の番です`;

  renderPendingPanel(room, me);

  const logWrap = document.getElementById('log-area');
  logWrap.innerHTML = room.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  logWrap.scrollTop = logWrap.scrollHeight;

  document.getElementById('my-info').textContent = me ? `${me.name}（あなた）　残り ${me.handCount} 枚` : '';

  const handWrap = document.getElementById('my-hand');
  handWrap.innerHTML = '';
  const myNormalTurn = me && !me.finished && room.turnPlayerId === me.id && !room.pendingAction;
  if (me && me.hand) {
    me.hand.forEach(card => {
      const el = buildCardEl(card, {
        selected: selectedIds.has(card.id),
        onClick: myNormalTurn ? () => { toggleSelect(card.id); renderGame(currentRoom); } : null,
      });
      if (!myNormalTurn) el.style.opacity = '0.85';
      handWrap.appendChild(el);
    });
  }

  const showActions = !room.pendingAction;
  document.getElementById('btn-pass').classList.toggle('hidden', !showActions);
  document.getElementById('btn-play').classList.toggle('hidden', !showActions);
  document.getElementById('btn-pass').disabled = !myNormalTurn || room.field.count === 0;
  document.getElementById('btn-play').disabled = !myNormalTurn || selectedIds.size === 0;
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
}

// pendingAction の本人用UI（kind は server と一致）
function renderPendingPanel(room, me) {
  const panel = document.getElementById('pending-panel');
  const p = room.pendingAction;
  if (!p || !me || p.playerId !== me.id) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

  panel.classList.remove('hidden');
  panel.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'pending-title';
  title.textContent = p.reason || '';
  panel.appendChild(title);

  if (p.kind === 'declareRank') {
    const list = document.createElement('div');
    list.className = 'pending-choice-list';
    DECLARABLE_RANKS.forEach(r => {
      const btn = document.createElement('button');
      btn.className = 'btn-choice';
      btn.textContent = RANK_LABEL[r] || String(r);
      btn.addEventListener('click', () => socket.emit('resolve-action', { rank: r }));
      list.appendChild(btn);
    });
    panel.appendChild(list);
    return;
  }

  if (p.kind === 'give' || p.kind === 'discard') {
    const need = p.count;
    const list = document.createElement('div');
    list.className = 'pending-choice-list';
    me.hand.forEach(card => {
      const el = buildCardEl(card, {
        selected: selectedIds.has(card.id),
        onClick: () => {
          if (selectedIds.has(card.id)) selectedIds.delete(card.id);
          else if (selectedIds.size < need) selectedIds.add(card.id);
          renderGame(currentRoom);
        },
      });
      list.appendChild(el);
    });
    panel.appendChild(list);

    const confirm = document.createElement('button');
    confirm.className = 'btn-choice confirm-btn';
    confirm.textContent = p.kind === 'give' ? `${need}枚渡す` : `${need}枚捨てる`;
    confirm.disabled = selectedIds.size !== Math.min(need, me.hand.length);
    confirm.addEventListener('click', () => {
      const ids = [...selectedIds];
      selectedIds.clear();
      socket.emit('resolve-action', { cardIds: ids });
    });
    panel.appendChild(confirm);
    return;
  }

  if (p.kind === 'takeGraveyard') {
    const list = document.createElement('div');
    list.className = 'pending-choice-list';
    const pile = p.discardOptions || [];
    if (pile.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'pending-hint';
      hint.textContent = '墓地にカードがありません';
      list.appendChild(hint);
    } else {
      pile.forEach(card => {
        const el = buildCardEl(card, { onClick: () => socket.emit('resolve-action', { cardId: card.id }) });
        list.appendChild(el);
      });
    }
    panel.appendChild(list);
    return;
  }

  if (p.kind === 'chooseCombo') {
    const list = document.createElement('div');
    list.className = 'pending-choice-list';
    (p.options || []).forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'btn-choice';
      btn.textContent = opt.label;
      btn.addEventListener('click', () => socket.emit('resolve-action', { optionIndex: idx }));
      list.appendChild(btn);
    });
    panel.appendChild(list);
    return;
  }

  if (p.kind === 'chooseTarget') {
    const list = document.createElement('div');
    list.className = 'pending-choice-list';
    (p.options || []).forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'btn-choice';
      btn.textContent = opt.name;
      btn.addEventListener('click', () => socket.emit('resolve-action', { targetId: opt.id }));
      list.appendChild(btn);
    });
    panel.appendChild(list);
    return;
  }

  if (p.kind === 'chooseCard') {
    const list = document.createElement('div');
    list.className = 'pending-choice-list';
    (p.revealHand || []).forEach(card => {
      const el = buildCardEl(card, { onClick: () => socket.emit('resolve-action', { cardId: card.id }) });
      list.appendChild(el);
    });
    panel.appendChild(list);
    return;
  }
}

document.getElementById('btn-play').addEventListener('click', () => {
  if (selectedIds.size === 0) return;
  socket.emit('play-cards', { cardIds: [...selectedIds] });
  selectedIds.clear();
});
document.getElementById('btn-pass').addEventListener('click', () => socket.emit('pass'));

// ---------- カード交換フェーズ ----------
function renderExchange(room) {
  const statusEl = document.getElementById('exchange-status');
  const handWrap = document.getElementById('exchange-hand');
  const confirmBtn = document.getElementById('btn-exchange-confirm');
  handWrap.innerHTML = '';
  confirmBtn.classList.add('hidden');

  const me = room.players.find(p => p.isYou);
  if (!me) { statusEl.textContent = '交換処理中…'; return; }

  const p = room.pendingAction;
  const mine = p && p.playerId === me.id && p.kind === 'exchangeGive';

  if (mine) {
    const need = Math.min(p.count, me.hand.length);
    statusEl.textContent = p.reason || `${need}枚選んで渡してください`;
    me.hand.forEach(card => {
      const el = buildCardEl(card, {
        selected: selectedIds.has(card.id),
        onClick: () => {
          if (selectedIds.has(card.id)) selectedIds.delete(card.id);
          else if (selectedIds.size < need) selectedIds.add(card.id);
          renderExchange(currentRoom);
        },
      });
      handWrap.appendChild(el);
    });
    confirmBtn.classList.remove('hidden');
    confirmBtn.disabled = selectedIds.size !== need;
    confirmBtn.textContent = `${need}枚渡す`;
    confirmBtn.onclick = () => {
      const ids = [...selectedIds];
      selectedIds.clear();
      socket.emit('resolve-action', { cardIds: ids });
    };
  } else {
    statusEl.textContent = room.pendingOtherName
      ? `${room.pendingOtherName} がカードを選んでいます…`
      : 'まもなくゲームが再開します…';
    (me.hand || []).forEach(card => handWrap.appendChild(buildCardEl(card)));
  }
}

// ---------- ラウンド結果 ----------
function placementOrder(title) {
  const i = TITLE_ORDER.indexOf(title);
  return i === -1 ? 99 : i;
}
function renderRoundEnd(room) {
  const list = document.getElementById('result-list');
  list.innerHTML = '';
  const ordered = [...room.players].sort((a, b) => placementOrder(a.placement) - placementOrder(b.placement));
  ordered.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.isYou ? '（あなた）' : ''}</span><span class="rank-title">${p.placement || ''}</span>`;
    list.appendChild(li);
  });
  const isHost = room.hostId === myId;
  const nextBtn = document.getElementById('btn-next-round');
  nextBtn.classList.toggle('hidden', !isHost);
  nextBtn.textContent = room.rules && room.rules.cardExchange ? '次のラウンドへ（カード交換あり）' : '次のラウンドへ';
  document.getElementById('roundend-wait').classList.toggle('hidden', isHost);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

document.getElementById('input-roomid').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

// ---------- 特殊演出（革命・8切り・ジョーカー・地元ルール） ----------
let lastShownEffectSeq = 0;
const effectQueue = [];
let effectShowing = false;

const EFFECT_CONFIG = {
  revolution: (e) => ({ main: 'REVOLUTION', sub: `革命発生！${e.by ? ' — ' + e.by : ''}` }),
  eight: (e) => ({ main: '8切り', sub: `${e.by || ''} の続行` }),
  joker: (e) => ({ main: 'JOKER!!', sub: `${e.by || ''} が場を流した` }),
  spark: (e) => ({ main: e.label || '発動！', sub: e.by ? `${e.by} が発動` : '' }),
};

function checkEffect(room) {
  const eff = room.lastEffect;
  if (!eff || eff.seq <= lastShownEffectSeq) return;
  lastShownEffectSeq = eff.seq;
  effectQueue.push(eff);
  runEffectQueue();
}

function runEffectQueue() {
  if (effectShowing || effectQueue.length === 0) return;
  effectShowing = true;
  const eff = effectQueue.shift();
  showEffect(eff);
  setTimeout(() => {
    effectShowing = false;
    runEffectQueue();
  }, 1450);
}

function showEffect(eff) {
  const cfg = (EFFECT_CONFIG[eff.kind] || EFFECT_CONFIG.spark)(eff);
  const overlay = document.getElementById('effect-overlay');

  const flash = document.createElement('div');
  flash.className = `effect-flash ${eff.kind}`;
  const banner = document.createElement('div');
  banner.className = `effect-banner ${eff.kind}`;
  banner.innerHTML = `<div class="effect-main">${escapeHtml(cfg.main)}</div><span class="effect-sub">${escapeHtml(cfg.sub || '')}</span>`;

  overlay.appendChild(flash);
  overlay.appendChild(banner);

  requestAnimationFrame(() => {
    flash.classList.add('playing');
    banner.classList.add('playing');
  });

  setTimeout(() => {
    flash.remove();
    banner.remove();
  }, 1600);
}
