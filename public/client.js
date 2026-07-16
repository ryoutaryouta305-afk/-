const socket = io();

const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 99: 'JOKER' };
const SUIT_MARK = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);
const TITLE_ORDER = ['大富豪', '富豪', '平民', '貧民', '大貧民'];
const DECLARABLE_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const RULE_LABELS = {
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
const RULE_ORDER = ['bomberQ', 'ak', 'sevenGive', 'tenDiscard', 'jBack', 'ambulance', 'shakaHoonko', 'nightingale', 'miyakoOchi', 'cardExchange'];

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

socket.on('connect', () => { myId = socket.id; });

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
document.getElementById('btn-back').addEventListener('click', () => { socket.emit('leave-room'); location.reload(); });

socket.on('error-message', msg => {
  document.getElementById('lobby-error').textContent = msg;
  toast(msg);
});

// ---------- 状態受信 ----------
socket.on('room-state', room => {
  currentRoom = room;
  if (room.phase !== 'playing' && room.phase !== 'exchange') selectedIds = new Set();

  if (room.phase === 'waiting') { renderWaiting(room); showScreen('waiting'); }
  else if (room.phase === 'playing') { selectedIds = pruneSelection(selectedIds, room); renderGame(room); showScreen('game'); }
  else if (room.phase === 'exchange') { selectedIds = pruneSelection(selectedIds, room); renderExchange(room); showScreen('exchange'); }
  else if (room.phase === 'ended') { renderRoundEnd(room); showScreen('roundend'); }
});

function pruneSelection(set, room) {
  const me = room.players.find(p => p.isYou);
  if (!me || !me.hand) return new Set();
  const ids = new Set(me.hand.map(c => c.id));
  return new Set([...set].filter(id => ids.has(id)));
}

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

  const canStart = isHost && room.players.length >= 2 && room.players.length <= 5;
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
