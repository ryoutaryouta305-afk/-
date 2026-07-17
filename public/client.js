const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});

const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 99: 'JOKER' };
const ROYAL_ICON = { 11: '♞', 12: '♛', 13: '♚' };

// 実物のトランプに近いピップ(スート記号)の配置。x/yは%、flip=trueは上下反転(下半分の記号)。
const PIP_LAYOUTS = {
  3:  [{x:50,y:16},{x:50,y:50},{x:50,y:84,flip:true}],
  4:  [{x:30,y:18},{x:70,y:18},{x:30,y:82,flip:true},{x:70,y:82,flip:true}],
  5:  [{x:30,y:18},{x:70,y:18},{x:50,y:50},{x:30,y:82,flip:true},{x:70,y:82,flip:true}],
  6:  [{x:30,y:16},{x:70,y:16},{x:30,y:50},{x:70,y:50},{x:30,y:84,flip:true},{x:70,y:84,flip:true}],
  7:  [{x:30,y:14},{x:70,y:14},{x:50,y:30},{x:30,y:50},{x:70,y:50},{x:30,y:86,flip:true},{x:70,y:86,flip:true}],
  8:  [{x:30,y:13},{x:70,y:13},{x:30,y:38},{x:70,y:38},{x:30,y:62,flip:true},{x:70,y:62,flip:true},{x:30,y:87,flip:true},{x:70,y:87,flip:true}],
  9:  [{x:30,y:13},{x:70,y:13},{x:30,y:36},{x:70,y:36},{x:50,y:50},{x:30,y:64,flip:true},{x:70,y:64,flip:true},{x:30,y:87,flip:true},{x:70,y:87,flip:true}],
  10: [{x:30,y:11},{x:70,y:11},{x:50,y:24},{x:30,y:38},{x:70,y:38},{x:30,y:62,flip:true},{x:70,y:62,flip:true},{x:50,y:76,flip:true},{x:30,y:89,flip:true},{x:70,y:89,flip:true}],
  15: [{x:50,y:18},{x:50,y:82,flip:true}], // 「2」(このゲームの最強札)
};
const SUIT_MARK = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);
const TITLE_ORDER = ['大富豪', '富豪', '平民', '貧民', '大貧民'];
const DECLARABLE_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const RULE_LABELS = {
  straights: '階段（同スート連番で3枚以上出せる）',
  bomberQ: '12ボンバー（Qをn枚→n種類のランクを指定して全捨て）',
  ak: 'AK（場が空・2枚渡して手番続行）',
  sevenGive: '7渡し（枚数分カードを次へ）',
  tenDiscard: '10捨て（枚数分カードを除外）',
  jBack: 'Jバック（流れるまで革命反転）',
  ambulance: '救急車（9×2で墓地1枚回収）',
  shakaHoonko: '報恩講・降誕会（相手の手札から1枚）',
  nightingale: 'ナイチンゲール（A+Qで墓地回収・自分の番へ）',
  miyakoOchi: '都落ち（大富豪交代の瞬間、前大富豪が大貧民に）',
  cardExchange: 'カード交換（順位でカードを交換）',
  jokerFoul: 'ジョーカー上がり反則（強制最下位）',
};
const RULE_ORDER = ['straights', 'bomberQ', 'ak', 'sevenGive', 'tenDiscard', 'jBack', 'ambulance', 'shakaHoonko', 'nightingale', 'miyakoOchi', 'cardExchange', 'jokerFoul'];

let myId = null;
let currentRoom = null;
let selectedIds = new Set();
let selectedRanks = new Set();
let lastDealRound = -1;

// 相手の人数(1〜5)ごとに、テーブルを囲む座席の並び順を定義
// 自分(画面下)から時計回りに進む席順(右→右上→中央上→左上→左)
const SEAT_LAYOUTS = {
  1: ['top-center'],
  2: ['right', 'left'],
  3: ['right', 'top-center', 'left'],
  4: ['right', 'top-right', 'top-left', 'left'],
  5: ['right', 'top-right', 'top-center', 'top-left', 'left'],
};

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
  // チャット履歴はroom-stateが来たときだけ丸ごと同期する(通常はjoin/rejoin時のみ)
  syncChatHistory(room.chat || []);
  checkEffect(room);
});

socket.on('chat-message', msg => {
  chatMessages.push(msg);
  if (chatMessages.length > 200) chatMessages.shift();
  appendChatMessage(msg);
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
let chatMessages = [];
let chatHistorySynced = false;

function isSelfName(name) {
  if (!currentRoom) return false;
  return currentRoom.players.some(p => p.isYou && p.name === name);
}

function syncChatHistory(messages) {
  // 既に同じ内容を反映済みなら何もしない(無駄な再描画を避ける)
  if (chatHistorySynced && messages.length === chatMessages.length) return;
  chatHistorySynced = true;
  chatMessages = messages.slice();
  const listEl = document.getElementById('chat-messages');
  listEl.innerHTML = chatMessages.map(m => renderChatMsgHtml(m)).join('');
  listEl.scrollTop = listEl.scrollHeight;
  updateUnreadBadge();
}

function renderChatMsgHtml(m) {
  const isSelf = isSelfName(m.name);
  return `<div class="chat-msg${isSelf ? ' self' : ''}"><span class="chat-name">${escapeHtml(m.name)}</span><span class="chat-text">${escapeHtml(m.text)}</span></div>`;
}

function appendChatMessage(m) {
  const listEl = document.getElementById('chat-messages');
  const wasAtBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
  const div = document.createElement('div');
  div.innerHTML = renderChatMsgHtml(m);
  listEl.appendChild(div.firstChild);
  if (chatOpen || wasAtBottom) listEl.scrollTop = listEl.scrollHeight;
  updateUnreadBadge();
}

function updateUnreadBadge() {
  if (chatOpen) {
    lastSeenChatCount = chatMessages.length;
    document.getElementById('chat-unread').classList.add('hidden');
  } else if (chatMessages.length > lastSeenChatCount) {
    const unread = chatMessages.length - lastSeenChatCount;
    const badge = document.getElementById('chat-unread');
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.remove('hidden');
  }
}

function openChat() {
  chatOpen = true;
  document.getElementById('chat-panel').classList.remove('hidden');
  lastSeenChatCount = chatMessages.length;
  document.getElementById('chat-unread').classList.add('hidden');
  const listEl = document.getElementById('chat-messages');
  listEl.scrollTop = listEl.scrollHeight;
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

// 枚数が多いほど重ね、少なくなるほど広げる(2枚以下は重ねない)
function fanOverlap(count, cardWidth, maxRatio = 0.62, growAt = 14) {
  const ratio = Math.min(maxRatio, Math.max(0, (count - 2) / growAt));
  return Math.round(cardWidth * ratio);
}

function buildCardEl(card, { onClick, selected, tilt, lift, dealDelay } = {}) {
  const div = document.createElement('div');
  div.className = 'card';
  if (card.rank === 99) div.classList.add('joker');
  else div.classList.add(RED_SUITS.has(card.suit) ? 'red' : 'black');
  if (typeof tilt === 'number') div.style.setProperty('--tilt', `${tilt}deg`);
  if (typeof lift === 'number') div.style.setProperty('--lift', `${lift}px`);
  if (typeof dealDelay === 'number') div.style.setProperty('--deal-delay', `${dealDelay}ms`);

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

  if (card.rank === 99) {
    const jesterIcon = document.createElement('div');
    jesterIcon.className = 'joker-icon';
    jesterIcon.textContent = '🃏';
    div.appendChild(jesterIcon);
    const rank = document.createElement('div');
    rank.className = 'rank';
    rank.textContent = 'JOKER';
    div.appendChild(rank);
  } else if (card.rank === 14) {
    // エース: 中央に大きくスート1つ
    const face = document.createElement('div');
    face.className = 'face-ace';
    face.textContent = SUIT_MARK[card.suit];
    div.appendChild(face);
  } else if (card.rank >= 11 && card.rank <= 13) {
    // 絵札(J/Q/K): 金の縁取りフレーム + 駒アイコン + 文字
    const face = document.createElement('div');
    face.className = 'face-royal';
    face.innerHTML = `<span class="royal-icon">${ROYAL_ICON[card.rank]}</span><span class="royal-letter">${cardLabel(card)}</span><span class="royal-suit">${SUIT_MARK[card.suit]}</span>`;
    div.appendChild(face);
  } else {
    // 数字札(3〜10、および「2」): 実物のトランプに近いピップ配置
    const layout = PIP_LAYOUTS[card.rank];
    if (layout) {
      const field = document.createElement('div');
      field.className = 'pip-field';
      layout.forEach(p => {
        const pip = document.createElement('span');
        pip.className = 'pip' + (p.flip ? ' flip' : '');
        pip.style.left = `${p.x}%`;
        pip.style.top = `${p.y}%`;
        pip.textContent = SUIT_MARK[card.suit];
        field.appendChild(pip);
      });
      div.appendChild(field);
    } else {
      const rank = document.createElement('div');
      rank.className = 'rank';
      rank.textContent = cardLabel(card);
      div.appendChild(rank);
      const suit = document.createElement('div');
      suit.className = 'suit';
      suit.textContent = SUIT_MARK[card.suit];
      div.appendChild(suit);
    }
  }

  div.dataset.id = card.id;
  if (selected) div.classList.add('selected');
  if (onClick) div.addEventListener('click', onClick);
  return div;
}

function buildCardBackFan(count) {
  const wrap = document.createElement('div');
  wrap.className = 'opp-hand-fan';
  const shown = Math.min(count, 10);
  const center = (shown - 1) / 2;
  const step = shown > 1 ? Math.min(10, 30 / shown) : 0;
  const overlap = fanOverlap(shown, 26, 0.55, 10);
  for (let i = 0; i < shown; i++) {
    const back = document.createElement('div');
    back.className = 'card-back';
    back.style.setProperty('--tilt', `${((i - center) * step).toFixed(1)}deg`);
    if (i > 0) back.style.marginLeft = `-${overlap}px`;
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
  // 自分から見て時計回り(ターンが進む順)に相手を並べる
  const myIdx = room.players.findIndex(p => p.isYou);
  const n = room.players.length;
  const opponents = myIdx < 0
    ? room.players.filter(p => !p.isYou)
    : Array.from({ length: n - 1 }, (_, i) => room.players[(myIdx + 1 + i) % n]);
  const seatSet = SEAT_LAYOUTS[opponents.length] || SEAT_LAYOUTS[5];
  opponents.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = `opp-card seat-${seatSet[i] || 'top-center'}`;
    if (p.id === room.turnPlayerId) card.classList.add('active-turn');
    if (p.finished) card.classList.add('finished');
    card.innerHTML = `
      <div class="opp-avatar">${escapeHtml((p.name || '?').slice(0, 1))}</div>
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
    const scatterPattern = [-6, 5, -3, 7, -4, 3, -7, 4, -2, 6];
    room.field.cards.forEach((c, i) => {
      const el = buildCardEl(c, { tilt: scatterPattern[i % scatterPattern.length], dealDelay: i * 70 });
      el.style.zIndex = String(i + 1);
      fieldWrap.appendChild(el);
    });
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
  const isNewDeal = room.roundNumber !== lastDealRound;
  lastDealRound = room.roundNumber;
  if (me && me.hand) {
    const n = me.hand.length;
    const center = (n - 1) / 2;
    const step = Math.min(4, n > 1 ? 26 / n : 0);
    const overlap = fanOverlap(n, 74);
    me.hand.forEach((card, i) => {
      const distFromCenter = Math.abs(i - center);
      const el = buildCardEl(card, {
        selected: selectedIds.has(card.id),
        onClick: myNormalTurn ? () => { toggleSelect(card.id); renderGame(currentRoom); } : null,
        tilt: Number(((i - center) * step).toFixed(1)),
        lift: Number((distFromCenter * distFromCenter * 0.35).toFixed(1)),
        dealDelay: isNewDeal ? Math.min(i * 22, 380) : 0,
      });
      if (i > 0) el.style.marginLeft = `-${overlap}px`;
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
  if (p.kind !== 'declareRank') selectedRanks.clear();
  const title = document.createElement('div');
  title.className = 'pending-title';
  title.textContent = p.reason || '';
  panel.appendChild(title);

  if (p.kind === 'declareRank') {
    const need = p.count || 1;
    const list = document.createElement('div');
    list.className = 'pending-choice-list';
    DECLARABLE_RANKS.forEach(r => {
      const btn = document.createElement('button');
      btn.className = 'btn-choice';
      if (selectedRanks.has(r)) btn.classList.add('selected');
      btn.textContent = RANK_LABEL[r] || String(r);
      btn.addEventListener('click', () => {
        if (selectedRanks.has(r)) selectedRanks.delete(r);
        else if (selectedRanks.size < need) selectedRanks.add(r);
        renderPendingPanel(currentRoom, me);
      });
      list.appendChild(btn);
    });
    panel.appendChild(list);

    const confirm = document.createElement('button');
    confirm.className = 'btn-choice confirm-btn';
    confirm.textContent = `この${need}種類を捨てさせる`;
    confirm.disabled = selectedRanks.size !== need;
    confirm.addEventListener('click', () => {
      const ranks = [...selectedRanks];
      selectedRanks.clear();
      socket.emit('resolve-action', { ranks });
    });
    panel.appendChild(confirm);
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
  revolution: (e) => ({ main: 'REVOLUTION', sub: `革命発生！${e.by ? ' — ' + e.by : ''}`, icon: '☖' }),
  eight: (e) => ({ main: '8切り', sub: `${e.by || ''} の続行`, icon: '⚡' }),
  joker: (e) => ({ main: 'JOKER!!', sub: `${e.by || ''} が場を流した`, icon: '🃏' }),
  spark: (e) => ({ main: e.label || '発動！', sub: e.by ? `${e.by} が発動` : '', icon: '✨' }),

  ak: (e) => ({ main: 'AK', sub: `${e.by || ''} 掃射——`, icon: '🔫' }),
  ambulance: (e) => ({ main: '救急車', sub: `${e.by || ''} が緊急出動`, icon: '🚑' }),
  bomberQ: (e) => ({ main: '12ボンバー', sub: `${e.by || ''} が起爆`, icon: '💥' }),
  houonko: (e) => ({ main: '報恩講', sub: `${e.by || ''} が引導を渡す`, icon: '⚔️' }),
  shaka: (e) => ({ main: '降誕会', sub: `${e.by || ''} に光臨`, icon: '🕉️' }),
  nightingale: (e) => ({ main: 'ナイチンゲール', sub: `${e.by || ''} の号令`, icon: '👑' }),
  miyakoOchi: (e) => ({ main: '都落ち', sub: `${e.by || ''} が大貧民に転落`, icon: '👑' }),
  jokerFoul: () => ({ main: 'ジョーカー上がり', sub: '反則につき強制最下位', icon: '🚫' }),
  cardExchange: (e) => ({ main: 'カード交換', sub: `${e.from || ''} → ${e.to || ''}（${e.count || ''}枚）`, icon: '🂠' }),
};

// 写真ベースの必殺演出(用意した画像がある技だけここに追加していく)
const PHOTO_EFFECTS = {
  ak: { src: '/assets/effects/ak.jpg', duration: 2300 },
  shaka: { src: '/assets/effects/shaka.jpg', duration: 2500 },
  ambulance: { src: '/assets/effects/ambulance.jpg', duration: 2300 },
  bomberQ: { src: '/assets/effects/bomberQ.jpg', duration: 2200 },
  nightingale: { src: '/assets/effects/nightingale.jpg', duration: 2500 },
  miyakoOchi: { src: '/assets/effects/miyakoOchi.jpg', duration: 2400 },
  jokerFoul: { src: '/assets/effects/jokerFoul.jpg', duration: 2200 },
  houonko: { src: '/assets/effects/houonko.jpg', duration: 2300 },
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
  const duration = showEffect(eff);
  setTimeout(() => {
    effectShowing = false;
    runEffectQueue();
  }, duration);
}

function showEffect(eff) {
  const photo = PHOTO_EFFECTS[eff.kind];
  if (photo) return showPhotoEffect(eff, photo);
  return showBannerEffect(eff);
}

// 写真(リアル系画像)を使った映画風の必殺演出
function showPhotoEffect(eff, photo) {
  const cfg = (EFFECT_CONFIG[eff.kind] || EFFECT_CONFIG.spark)(eff);
  const overlay = document.getElementById('effect-overlay');

  const wrap = document.createElement('div');
  wrap.className = `effect-photo ${eff.kind}`;
  wrap.innerHTML = `
    <img src="${photo.src}" alt="" />
    <div class="effect-photo-shade"></div>
    <div class="effect-photo-flare"></div>
    ${photoExtraMarkup(eff.kind)}
    <div class="effect-photo-title">
      <div class="effect-photo-main">${escapeHtml(cfg.main)}</div>
      <span class="effect-photo-sub">${escapeHtml(cfg.sub || '')}</span>
    </div>`;
  overlay.appendChild(wrap);

  requestAnimationFrame(() => wrap.classList.add('playing'));

  setTimeout(() => wrap.remove(), photo.duration + 150);
  return photo.duration;
}

// 技ごとに「今まさに起きている」感を出すための追加パーティクル(爆発の火の粉・崩れる王冠の破片など)
function photoExtraMarkup(kind) {
  if (kind === 'bomberQ') {
    const embers = Array.from({ length: 14 }, (_, i) => {
      const left = 30 + Math.random() * 40;
      const delay = (Math.random() * 0.3).toFixed(2);
      const drift = (Math.random() * 60 - 30).toFixed(0);
      return `<span class="ember" style="left:${left}%; animation-delay:${delay}s; --drift:${drift}px;"></span>`;
    }).join('');
    return `<div class="effect-particles bomberQ-particles">${embers}</div>`;
  }
  if (kind === 'miyakoOchi') {
    const shards = Array.from({ length: 10 }, (_, i) => {
      const left = 35 + Math.random() * 30;
      const delay = (Math.random() * 0.4).toFixed(2);
      const drift = (Math.random() * 80 - 40).toFixed(0);
      return `<span class="shard" style="left:${left}%; animation-delay:${delay}s; --drift:${drift}px;"></span>`;
    }).join('');
    return `<div class="effect-particles miyako-particles">${shards}</div>`;
  }
  if (kind === 'ambulance') {
    return `<div class="effect-siren"></div>`;
  }
  if (kind === 'houonko') {
    return `<div class="slash"></div>`;
  }
  return '';
}

// 通常のCSSバナー演出(写真素材がまだ用意されていない技用)
function showBannerEffect(eff) {
  const cfg = (EFFECT_CONFIG[eff.kind] || EFFECT_CONFIG.spark)(eff);
  const overlay = document.getElementById('effect-overlay');
  const extras = [];

  const flash = document.createElement('div');
  flash.className = `effect-flash ${eff.kind}`;
  const banner = document.createElement('div');
  banner.className = `effect-banner ${eff.kind}`;
  banner.innerHTML = `
    <div class="effect-icon">${cfg.icon || ''}</div>
    <div class="effect-main">${escapeHtml(cfg.main)}</div>
    <span class="effect-sub">${escapeHtml(cfg.sub || '')}</span>`;

  overlay.appendChild(flash);
  overlay.appendChild(banner);
  extras.push(flash, banner);

  // 救急車: 画面を横切っていく
  if (eff.kind === 'ambulance') {
    const car = document.createElement('div');
    car.className = 'effect-ambulance';
    car.textContent = '🚑';
    overlay.appendChild(car);
    extras.push(car);
    requestAnimationFrame(() => car.classList.add('playing'));
  }

  // 12ボンバー: 爆発の破片
  if (eff.kind === 'bomberQ') {
    const boom = document.createElement('div');
    boom.className = 'effect-boom';
    overlay.appendChild(boom);
    extras.push(boom);
    requestAnimationFrame(() => boom.classList.add('playing'));
  }

  // AK: 銃口のマズルフラッシュ + 弾痕ライン
  if (eff.kind === 'ak') {
    const muzzle = document.createElement('div');
    muzzle.className = 'effect-muzzle';
    overlay.appendChild(muzzle);
    extras.push(muzzle);
    requestAnimationFrame(() => muzzle.classList.add('playing'));
  }

  // カード交換: カードが一枚、一方から一方へ飛んでいく
  if (eff.kind === 'cardExchange') {
    const flying = document.createElement('div');
    flying.className = 'effect-card-fly';
    flying.textContent = '🂠';
    overlay.appendChild(flying);
    extras.push(flying);
    requestAnimationFrame(() => flying.classList.add('playing'));
  }

  requestAnimationFrame(() => {
    flash.classList.add('playing');
    banner.classList.add('playing');
  });

  setTimeout(() => {
    extras.forEach(el => el.remove());
  }, 1700);
  return 1650;
}
