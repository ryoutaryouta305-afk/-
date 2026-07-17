const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------- カード定義 ----------
// rank: 3-13(3~K), 14(A), 15(2), 99(JOKER)
const SUITS = ['S', 'H', 'D', 'C'];
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 99: 'JOKER' };
const DECLARABLE_RANKS = [3,4,5,6,7,8,9,10,11,12,13,14,15];
function rankLabel(r) { return RANK_LABEL[r] || String(r); }
const SUIT_MARK = { S: '♠', H: '♥', D: '♦', C: '♣' };
const PLACEMENT_TITLES = {
  6: ['大富豪', '富豪', '平民', '平民', '貧民', '大貧民'],
  5: ['大富豪', '富豪', '平民', '貧民', '大貧民'],
  4: ['大富豪', '富豪', '貧民', '大貧民'],
  3: ['大富豪', '平民', '大貧民'],
  2: ['大富豪', '大貧民'],
};

function buildDeck() {
  const deck = [];
  let id = 0;
  for (const suit of SUITS) {
    for (let r = 3; r <= 15; r++) {
      deck.push({ id: `c${id++}`, rank: r, suit });
    }
  }
  deck.push({ id: `c${id++}`, rank: 99, suit: null });
  deck.push({ id: `c${id++}`, rank: 99, suit: null });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 通常順位での強さ (数字が大きいほど強い)。ジョーカーは単騎最強=100
function strengthOf(rank, revolution) {
  if (rank === 99) return 100;
  const base = rank; // 3..15
  return revolution ? (100 - base) : base;
}

function sortHand(hand) {
  hand.sort((a, b) => (a.rank === 99 ? 999 : a.rank) - (b.rank === 99 ? 999 : b.rank));
  return hand;
}

const DEFAULT_RULES = {
  straights: true,    // 0. 階段（同スート連番）
  bomberQ: true,      // 1. 12ボンバー
  ak: true,           // 2. AK
  sevenGive: true,    // 3. 7渡し
  tenDiscard: true,   // 4. 10捨て
  jBack: true,        // 5. Jバック
  ambulance: true,    // 6. 救急車
  shakaHoonko: true,  // 7. 釈迦・報恩講
  nightingale: true,  // 8. ナイチンゲール
  miyakoOchi: true,   // 9. 都落ち
  cardExchange: true, // 10. カード交換
};
const RULE_LABELS = {
  straights: '階段（同スート連番）',
  bomberQ: '12ボンバー(Q)',
  ak: 'AK',
  sevenGive: '7渡し',
  tenDiscard: '10捨て',
  jBack: 'Jバック',
  ambulance: '救急車(9+9)',
  shakaHoonko: '釈迦・報恩講',
  nightingale: 'ナイチンゲール(9+A)',
  miyakoOchi: '都落ち',
  cardExchange: 'カード交換',
};

// ---------- ルーム管理 ----------
const rooms = new Map(); // roomId -> room

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function createRoom(hostSocketId, hostName) {
  const roomId = makeRoomId();
  const room = {
    id: roomId,
    hostId: hostSocketId,
    phase: 'waiting', // waiting | playing | exchange | ended
    rules: { ...DEFAULT_RULES },
    players: [], // {id, name, hand:[], finished:false, placement:null, connected:true}
    turnIndex: 0,
    field: { cards: [], count: 0, type: null, byPlayerId: null },
    passedSince: new Set(),
    revolution: false,
    jBackActive: false,
    jBackPrevRevolution: false,
    discardPile: [],
    log: [],
    finishOrder: [],
    pendingAction: null,
    postPlayContext: null,
    previousPlacements: null, // [{playerId, title}] from last round, for 都落ち/交換
    roundNumber: 0,
    exchangeQueue: [],
    chatLog: [], // {name, text, ts}
    effectSeq: 0,
    lastEffect: null, // {kind:'revolution'|'eight'|'joker'|'bomberQ'|'ak', seq}
  };
  rooms.set(roomId, room);
  addPlayer(room, hostSocketId, hostName);
  return room;
}

function makeToken() {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

function addPlayer(room, socketId, name) {
  room.players.push({
    id: socketId,
    token: makeToken(),
    name: (name || '').slice(0, 10) || 'プレイヤー',
    hand: [],
    finished: false,
    placement: null,
    connected: true,
  });
}

function pushLog(room, text) {
  room.log.push(text);
  if (room.log.length > 80) room.log.shift();
}

function triggerEffect(room, kind, extra) {
  room.effectSeq += 1;
  room.lastEffect = { kind, seq: room.effectSeq, ...extra };
}

function dealCards(room) {
  const deck = shuffle(buildDeck());
  const n = room.players.length;
  room.players.forEach(p => (p.hand = []));
  let i = 0;
  for (const card of deck) {
    room.players[i % n].hand.push(card);
    i++;
  }
  for (const p of room.players) sortHand(p.hand);
}

function activePlayers(room) {
  return room.players.filter(p => !p.finished);
}

function nextActiveIndex(room, fromIndex) {
  const n = room.players.length;
  let i = fromIndex;
  for (let step = 0; step < n; step++) {
    i = (i + 1) % n;
    if (!room.players[i].finished) return i;
  }
  return fromIndex;
}

function currentPlayer(room) {
  return room.players[room.turnIndex];
}

function beginRound(room) {
  dealCards(room);
  room.phase = 'playing';
  room.field = { cards: [], count: 0, type: null, byPlayerId: null };
  room.passedSince = new Set();
  room.revolution = false;
  room.jBackActive = false;
  room.jBackPrevRevolution = false;
  room.discardPile = [];
  room.finishOrder = [];
  room.pendingAction = null;
  room.postPlayContext = null;
  room.roundNumber += 1;

  // 前回の順位に応じて開始プレイヤーを決定(前回の大富豪が先手。初回はindex0)
  let startIdx = 0;
  if (room.previousPlacements) {
    const champ = room.previousPlacements.find(p => p.title === '大富豪');
    if (champ) {
      const idx = room.players.findIndex(pl => pl.id === champ.playerId);
      if (idx >= 0) startIdx = idx;
    }
  }
  room.turnIndex = startIdx;
  pushLog(room, `ラウンド${room.roundNumber} 開始！`);
}

function startGame(room) {
  room.previousPlacements = null;
  beginRound(room);
}

// カード群の役判定: 単騎/ペア/トリプル/カルテット or 階段(同スート連番)
function classifyPlay(cards, rules) {
  if (cards.length === 0) return null;
  const jokers = cards.filter(c => c.rank === 99);
  const normals = cards.filter(c => c.rank !== 99);

  if (normals.length === 0 || normals.every(c => c.rank === normals[0].rank)) {
    const rank = normals.length ? normals[0].rank : 99;
    return { type: 'group', count: cards.length, rank, cards };
  }

  const straightsAllowed = !rules || rules.straights !== false;
  if (!straightsAllowed) return null;

  const suitsUsed = new Set(normals.map(c => c.suit));
  if (suitsUsed.size === 1 && cards.length >= 3) {
    const sorted = [...normals].sort((a, b) => a.rank - b.rank);
    let jokerLeft = jokers.length;
    let ok = true;
    let idx = 0;
    const usedRanks = [];
    for (let r = sorted[0].rank; r <= sorted[0].rank + cards.length - 1; r++) {
      if (idx < sorted.length && sorted[idx].rank === r) {
        usedRanks.push(r);
        idx++;
      } else if (jokerLeft > 0) {
        jokerLeft--;
        usedRanks.push(r);
      } else {
        ok = false;
        break;
      }
    }
    if (ok && idx === sorted.length) {
      const topRank = Math.max(...usedRanks);
      return { type: 'straight', count: cards.length, rank: topRank, cards, suit: [...suitsUsed][0] };
    }
  }
  return null;
}

function rankSetOf(cards) {
  return cards.map(c => c.rank).sort((a, b) => a - b);
}
function sameSet(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function countBy(arr) {
  const m = new Map();
  arr.forEach(v => m.set(v, (m.get(v) || 0) + 1));
  return m;
}

// 場が空のときだけ出せる特殊コンボ(AK/釈迦/報恩講/ナイチンゲール)
// ジョーカーはワイルドとして不足分のランクを補える。
// 複数のコンボに解釈できる場合(例: A+ジョーカーはAKにもナイチンゲールにもなり得る)は
// 候補を全部返し、呼び出し側でプレイヤーに選ばせる。
const FREE_COMBOS = [
  { kind: 'ak', ruleKey: 'ak', ranks: [13, 14] },
  { kind: 'nightingale', ruleKey: 'nightingale', ranks: [9, 14] },
  { kind: 'shaka', ruleKey: 'shakaHoonko', ranks: [5, 14, 15] },
  { kind: 'houonko', ruleKey: 'shakaHoonko', ranks: [6, 14, 14] },
];

function detectFreeComboCandidates(cards, rules) {
  const jokerCount = cards.filter(c => c.rank === 99).length;
  const nonJokerRanks = cards.filter(c => c.rank !== 99).map(c => c.rank);
  const playedCounts = countBy(nonJokerRanks);
  const candidates = [];

  for (const combo of FREE_COMBOS) {
    if (!rules[combo.ruleKey]) continue;
    if (cards.length !== combo.ranks.length) continue;
    const comboCounts = countBy(combo.ranks);

    let valid = true;
    for (const rank of playedCounts.keys()) {
      if (!comboCounts.has(rank)) { valid = false; break; }
    }
    if (!valid) continue;

    let leftover = 0;
    for (const [rank, count] of comboCounts) {
      const have = playedCounts.get(rank) || 0;
      if (have > count) { valid = false; break; }
      leftover += (count - have);
    }
    if (!valid) continue;

    if (leftover === jokerCount) candidates.push(combo.kind);
  }
  return candidates;
}

function canBeatField(room, play) {
  const field = room.field;
  if (field.count === 0) return true;
  if (play.count !== field.count) return false;
  if (field.type === 'straight' && play.type !== 'straight') return false;
  if (field.type === 'group' && play.type === 'straight' && field.count >= 3) return false;
  const playStrength = strengthOf(play.rank, room.revolution);
  const fieldStrength = strengthOf(field.rank, room.revolution);
  return playStrength > fieldStrength;
}

function archiveField(room) {
  if (room.field.cards.length) {
    room.discardPile.push(...room.field.cards);
  }
}

function clearField(room, reason) {
  archiveField(room);
  room.field = { cards: [], count: 0, type: null, byPlayerId: null };
  room.passedSince = new Set();
  if (room.jBackActive) {
    room.revolution = room.jBackPrevRevolution;
    room.jBackActive = false;
    pushLog(room, 'Jバック解除：革命状態が元に戻りました');
  }
  if (reason) pushLog(room, reason);
}

function checkFinish(room, player) {
  if (player.hand.length === 0 && !player.finished) {
    player.finished = true;
    room.finishOrder.push(player.id);
    pushLog(room, `${player.name} が上がりました！(${room.finishOrder.length}位)`);
  }
}

function applyMiyakoOchi(room) {
  if (!room.rules.miyakoOchi || !room.previousPlacements) return;
  const prevDaihinmin = room.previousPlacements.find(p => p.title === '大貧民');
  if (!prevDaihinmin) return;
  const n = room.players.length;
  const titles = PLACEMENT_TITLES[n];
  if (!titles) return;
  const champIdx = room.finishOrder.findIndex(pid => pid === prevDaihinmin.playerId);
  if (champIdx === 0 && room.finishOrder.length === n) {
    // 前回の大貧民が今回1位 → 1位と最下位を入れ替え
    const last = room.finishOrder[n - 1];
    room.finishOrder[0] = last;
    room.finishOrder[n - 1] = prevDaihinmin.playerId;
    pushLog(room, '都落ち発生！1位と最下位が入れ替わりました');
    triggerEffect(room, 'spark', { label: '都落ち' });
  }
}

function maybeEndGame(room) {
  const remaining = activePlayers(room);
  if (remaining.length <= 1) {
    if (remaining.length === 1) {
      room.finishOrder.push(remaining[0].id);
      remaining[0].finished = true;
    }
    applyMiyakoOchi(room);

    const n = room.players.length;
    const titles = PLACEMENT_TITLES[n] || null;
    const placements = [];
    room.finishOrder.forEach((pid, idx) => {
      const p = room.players.find(pp => pp.id === pid);
      if (p) {
        p.placement = titles ? titles[idx] : `${idx + 1}位`;
        placements.push({ playerId: pid, title: p.placement });
      }
    });
    room.previousPlacements = placements;
    room.phase = 'ended';
    pushLog(room, 'ゲーム終了！');
  }
}

function finalizeAfterPlay(room, player, includesEight, turnOverride, clearKind) {
  checkFinish(room, player);
  maybeEndGame(room);
  if (room.phase !== 'playing') return;

  if (turnOverride !== undefined && turnOverride !== null) {
    room.turnIndex = turnOverride;
    return;
  }
  if (includesEight) {
    const msg = clearKind === 'joker'
      ? `${player.name} が続けて出せます`
      : `8切り！${player.name} の続行`;
    clearField(room, msg);
    triggerEffect(room, clearKind === 'joker' ? 'joker' : 'eight', { by: player.name });
    room.turnIndex = player.finished ? nextActiveIndex(room, room.players.indexOf(player)) : room.players.indexOf(player);
  } else {
    room.turnIndex = nextActiveIndex(room, room.turnIndex);
  }
}

function describeCards(cards) {
  return cards
    .map(c => (c.rank === 99 ? 'JOKER' : `${SUIT_MARK[c.suit]}${rankLabel(c.rank)}`))
    .join(' ');
}

// 手札から count 枚だけ次の人などに渡す。足りなければ渡せる分だけ渡す。0枚になったら勝ち。
function giveCards(room, giver, receiver, cardIds) {
  const cards = giver.hand.filter(c => cardIds.includes(c.id));
  giver.hand = giver.hand.filter(c => !cardIds.includes(c.id));
  receiver.hand.push(...cards);
  sortHand(receiver.hand);
  return cards;
}

function serializeRoom(room, forSocketId) {
  const me = room.players.find(p => p.id === forSocketId);
  let pendingForMe = null;
  if (room.pendingAction && room.pendingAction.playerId === forSocketId) {
    pendingForMe = { ...room.pendingAction };
    if (pendingForMe.kind === 'takeGraveyard') {
      pendingForMe.discardOptions = room.discardPile;
    }
  }
  return {
    id: room.id,
    hostId: room.hostId,
    yourToken: me ? me.token : null,
    phase: room.phase,
    rules: room.rules,
    revolution: room.revolution,
    roundNumber: room.roundNumber,
    turnPlayerId: room.phase === 'playing' ? currentPlayer(room).id : null,
    field: {
      count: room.field.count,
      type: room.field.type,
      rank: room.field.rank,
      cards: room.field.cards,
      byPlayerId: room.field.byPlayerId,
    },
    discardCount: room.discardPile.length,
    log: room.log.slice(-24),
    chat: room.chatLog.slice(-50),
    lastEffect: room.lastEffect,
    pendingAction: pendingForMe,
    pendingOtherName: room.pendingAction && room.pendingAction.playerId !== forSocketId
      ? (room.players.find(p => p.id === room.pendingAction.playerId) || {}).name
      : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      finished: p.finished,
      placement: p.placement,
      connected: p.connected,
      isYou: p.id === forSocketId,
      hand: p.id === forSocketId ? p.hand : undefined,
    })),
  };
}

function broadcastRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit('room-state', serializeRoom(room, p.id));
  }
}

// ---------- 特殊コンボの後処理 ----------
function commitNormalPlay(room, player, cards, play) {
  const cardIds = cards.map(c => c.id);
  player.hand = player.hand.filter(c => !cardIds.includes(c.id));
  room.field = { cards, count: play.count, type: play.type, rank: play.rank, byPlayerId: player.id };
  room.passedSince = new Set();

  const isAllJoker = cards.every(c => c.rank === 99);
  const isRevolutionTrigger = play.type === 'group' && play.count === 4 && !isAllJoker;
  if (isRevolutionTrigger) {
    room.revolution = !room.revolution;
    pushLog(room, `${player.name} が4枚出し！革命発生！`);
    triggerEffect(room, 'revolution', { by: player.name });
  }
  const includesEight = cards.some(c => c.rank === 8);
  const clearsField = includesEight || isAllJoker;
  const clearKind = isAllJoker ? 'joker' : (includesEight ? 'eight' : null);
  pushLog(room, `${player.name}: ${describeCards(cards)}`);
  if (isAllJoker) pushLog(room, 'ジョーカー！場を流します');

  let bonusPending = false;
  if (play.type === 'group') {
    bonusPending = handleBonusAfterGroupPlay(room, player, play, cards);
  }

  if (bonusPending) {
    room.postPlayContext = { playerId: player.id, includesEight: clearsField, clearKind };
    checkFinish(room, player);
    // 手札が0でpendingActionが不要なら即終了させる(give/discardはcount調整済みなのでここではfinish判定のみ)
    return;
  }

  finalizeAfterPlay(room, player, clearsField, undefined, clearKind);
}

function handleBonusAfterGroupPlay(room, player, play, cards) {
  const rules = room.rules;
  if (rules.bomberQ && play.rank === 12) {
    triggerEffect(room, 'spark', { label: '12ボンバー', by: player.name });
    room.pendingAction = { kind: 'declareRank', playerId: player.id, reason: '12ボンバー：捨てさせるランクを選んでください' };
    return true;
  }
  if (rules.sevenGive && play.rank === 7) {
    if (player.hand.length === 0) return false;
    const count = Math.min(play.count, player.hand.length);
    const receiver = room.players[nextActiveIndex(room, room.players.indexOf(player))];
    triggerEffect(room, 'spark', { label: '7渡し', by: player.name });
    room.pendingAction = { kind: 'give', playerId: player.id, count, targetPlayerId: receiver.id, reason: `7渡し：${receiver.name} に渡すカードを${count}枚選んでください` };
    return true;
  }
  if (rules.tenDiscard && play.rank === 10) {
    if (player.hand.length === 0) return false;
    const count = Math.min(play.count, player.hand.length);
    triggerEffect(room, 'spark', { label: '10捨て', by: player.name });
    room.pendingAction = { kind: 'discard', playerId: player.id, count, reason: `10捨て：捨てるカードを${count}枚選んでください` };
    return true;
  }
  if (rules.jBack && play.rank === 11) {
    if (!room.jBackActive) {
      room.jBackPrevRevolution = room.revolution;
    }
    room.revolution = !room.revolution;
    room.jBackActive = true;
    pushLog(room, `${player.name} のJバック！革命状態が一時反転`);
    triggerEffect(room, 'spark', { label: 'Jバック', by: player.name });
    return false;
  }
  if (rules.ambulance && play.rank === 9 && play.count === 2) {
    if (room.discardPile.length === 0) {
      pushLog(room, '救急車：墓地にカードがありません');
      return false;
    }
    triggerEffect(room, 'spark', { label: '救急車', by: player.name });
    room.pendingAction = { kind: 'takeGraveyard', playerId: player.id, reason: '救急車：墓地から1枚回収できます' };
    return true;
  }
  return false;
}

function handleFreeCombo(room, player, combo, cards) {
  archiveField(room); // 場は空のはずだが念のため
  room.field = { cards: [], count: 0, type: null, byPlayerId: null };
  room.discardPile.push(...cards);
  pushLog(room, `${player.name}: ${describeCards(cards)}（${comboName(combo.kind)}）`);
  triggerEffect(room, 'spark', { label: comboName(combo.kind), by: player.name });

  if (combo.kind === 'ak') {
    if (player.hand.length === 0) {
      finalizeAfterPlay(room, player, false, room.players.indexOf(player));
      return;
    }
    const receiver = room.players[nextActiveIndex(room, room.players.indexOf(player))];
    const count = Math.min(2, player.hand.length);
    room.pendingAction = { kind: 'give', playerId: player.id, count, targetPlayerId: receiver.id, reason: `AK：${receiver.name} に渡すカードを${count}枚選んでください`, afterTurnOverride: room.players.indexOf(player) };
    return;
  }
  if (combo.kind === 'nightingale') {
    if (room.discardPile.length === 0) {
      finalizeAfterPlay(room, player, false);
      return;
    }
    room.pendingAction = { kind: 'takeGraveyard', playerId: player.id, reason: 'ナイチンゲール：墓地から1枚回収できます' };
    return;
  }
  if (combo.kind === 'shaka' || combo.kind === 'houonko') {
    const others = activePlayers(room).filter(p => p.id !== player.id);
    if (others.length === 0) {
      finalizeAfterPlay(room, player, false);
      return;
    }
    room.pendingAction = {
      kind: 'chooseTarget',
      playerId: player.id,
      reason: `${comboName(combo.kind)}：手札を見る相手を選んでください`,
      options: others.map(p => ({ id: p.id, name: p.name })),
    };
    return;
  }
}

function comboName(kind) {
  return { ak: 'AK', nightingale: 'ナイチンゲール', shaka: '釈迦', houonko: '報恩講' }[kind] || kind;
}

// ---------- Socket通信 ----------
io.on('connection', socket => {
  socket.on('create-room', ({ name }) => {
    const room = createRoom(socket.id, name);
    socket.join(room.id);
    socket.data.roomId = room.id;
    broadcastRoom(room);
  });

  socket.on('join-room', ({ name, roomId }) => {
    const id = (roomId || '').toUpperCase().trim();
    const room = rooms.get(id);
    if (!room) { socket.emit('error-message', '部屋が見つかりません'); return; }
    if (room.phase !== 'waiting') { socket.emit('error-message', 'すでにゲームが始まっています'); return; }
    if (room.players.length >= 6) { socket.emit('error-message', '満員です(6人まで)'); return; }
    addPlayer(room, socket.id, name);
    socket.join(room.id);
    socket.data.roomId = room.id;
    pushLog(room, `${name} が参加しました`);
    broadcastRoom(room);
  });

  socket.on('toggle-rule', ({ ruleKey, value }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.phase !== 'waiting') return;
    if (!(ruleKey in room.rules)) return;
    room.rules[ruleKey] = !!value;
    broadcastRoom(room);
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.players.length < 2 || room.players.length > 6) return;
    startGame(room);
    broadcastRoom(room);
  });

  socket.on('next-round', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.phase !== 'ended') return;
    room.players.forEach(p => { p.finished = false; p.placement = null; });
    beginRound(room);

    if (room.rules.cardExchange && room.previousPlacements) {
      startCardExchange(room);
    }
    broadcastRoom(room);
  });

  socket.on('play-cards', ({ cardIds }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'playing' || room.pendingAction) return;
    const player = currentPlayer(room);
    if (player.id !== socket.id) return;

    const cards = player.hand.filter(c => cardIds.includes(c.id));
    if (cards.length !== cardIds.length || cards.length === 0) return;

    if (room.field.count === 0) {
      const comboCandidates = detectFreeComboCandidates(cards, room.rules);
      const normalPlay = classifyPlay(cards, room.rules);

      const options = comboCandidates.map(k => ({ type: 'combo', kind: k, label: comboName(k) }));
      if (normalPlay) {
        options.push({ type: 'normal', label: `通常プレイ（${describeCards(cards)}）` });
      }

      if (options.length === 1) {
        const only = options[0];
        if (only.type === 'combo') {
          player.hand = player.hand.filter(c => !cardIds.includes(c.id));
          handleFreeCombo(room, player, { kind: only.kind }, cards);
          broadcastRoom(room);
          return;
        }
        // 通常プレイのみ合法(コンボ候補なし) → そのまま下の通常処理へフォールスルー
      } else if (options.length > 1) {
        room.pendingAction = {
          kind: 'chooseCombo',
          playerId: player.id,
          reason: 'このカードをどう出すか選んでください',
          options,
          cardIds: cardIds.slice(),
        };
        broadcastRoom(room);
        return;
      } else {
        socket.emit('error-message', '無効な組み合わせです');
        return;
      }
    }

    const play = classifyPlay(cards, room.rules);
    if (!play) { socket.emit('error-message', '無効な組み合わせです'); return; }
    if (!canBeatField(room, play)) { socket.emit('error-message', '場より弱いか、出せない組み合わせです'); return; }

    commitNormalPlay(room, player, cards, play);
    broadcastRoom(room);
  });

  socket.on('pass', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'playing' || room.pendingAction) return;
    const player = currentPlayer(room);
    if (player.id !== socket.id) return;
    if (room.field.count === 0) { socket.emit('error-message', '場が空のときはパスできません'); return; }

    room.passedSince.add(player.id);
    pushLog(room, `${player.name}: パス`);

    const others = activePlayers(room).filter(p => p.id !== room.field.byPlayerId);
    const allPassed = others.every(p => room.passedSince.has(p.id));

    room.turnIndex = nextActiveIndex(room, room.turnIndex);

    if (allPassed) {
      const winnerId = room.field.byPlayerId;
      clearField(room, '場が流れました');
      const winnerIdx = room.players.findIndex(p => p.id === winnerId);
      if (winnerIdx >= 0 && !room.players[winnerIdx].finished) {
        room.turnIndex = winnerIdx;
      }
    }
    broadcastRoom(room);
  });

  // ---- 各種pendingAction解決 ----
  socket.on('resolve-action', (payload = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.pendingAction) return;
    const pending = room.pendingAction;
    if (pending.playerId !== socket.id) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (pending.kind === 'give') {
      const cardIds = (payload.cardIds || []).slice(0, pending.count);
      const receiver = room.players.find(p => p.id === pending.targetPlayerId);
      if (!receiver) return;
      giveCards(room, player, receiver, cardIds);
      pushLog(room, `${player.name} が ${receiver.name} にカードを${cardIds.length}枚渡しました`);
      room.pendingAction = null;
      const ctx = room.postPlayContext || {};
      room.postPlayContext = null;
      finalizeAfterPlay(room, player, !!ctx.includesEight, pending.afterTurnOverride, ctx.clearKind);
      broadcastRoom(room);
      return;
    }

    if (pending.kind === 'discard') {
      const cardIds = (payload.cardIds || []).slice(0, pending.count);
      const discarded = player.hand.filter(c => cardIds.includes(c.id));
      player.hand = player.hand.filter(c => !cardIds.includes(c.id));
      room.discardPile.push(...discarded);
      pushLog(room, `${player.name} がカードを${discarded.length}枚捨てました`);
      room.pendingAction = null;
      const ctx = room.postPlayContext || {};
      room.postPlayContext = null;
      finalizeAfterPlay(room, player, !!ctx.includesEight, undefined, ctx.clearKind);
      broadcastRoom(room);
      return;
    }

    if (pending.kind === 'declareRank') {
      const rank = payload.rank;
      if (!DECLARABLE_RANKS.includes(rank)) return;
      let removedTotal = 0;
      room.players.forEach(p => {
        const removed = p.hand.filter(c => c.rank === rank);
        if (removed.length) {
          p.hand = p.hand.filter(c => c.rank !== rank);
          room.discardPile.push(...removed);
          removedTotal += removed.length;
        }
      });
      pushLog(room, `${player.name} が「${rankLabel(rank)}」を宣言！全員が${rankLabel(rank)}を捨てました(${removedTotal}枚)`);
      room.pendingAction = null;
      const ctx = room.postPlayContext || {};
      room.postPlayContext = null;
      room.players.forEach(p => checkFinish(room, p));
      finalizeAfterPlay(room, player, !!ctx.includesEight, undefined, ctx.clearKind);
      broadcastRoom(room);
      return;
    }

    if (pending.kind === 'takeGraveyard') {
      const cardId = payload.cardId;
      const idx = room.discardPile.findIndex(c => c.id === cardId);
      if (idx >= 0) {
        const [card] = room.discardPile.splice(idx, 1);
        player.hand.push(card);
        sortHand(player.hand);
        pushLog(room, `${player.name} が墓地からカードを1枚回収しました`);
      }
      room.pendingAction = null;
      const ctx = room.postPlayContext || {};
      room.postPlayContext = null;
      finalizeAfterPlay(room, player, !!ctx.includesEight, undefined, ctx.clearKind);
      broadcastRoom(room);
      return;
    }

    if (pending.kind === 'chooseCombo') {
      const opt = (pending.options || [])[payload.optionIndex];
      if (!opt) return;
      const cards = player.hand.filter(c => pending.cardIds.includes(c.id));
      if (cards.length !== pending.cardIds.length) return;

      if (opt.type === 'combo') {
        player.hand = player.hand.filter(c => !pending.cardIds.includes(c.id));
        room.pendingAction = null;
        handleFreeCombo(room, player, { kind: opt.kind }, cards);
        broadcastRoom(room);
        return;
      }
      if (opt.type === 'normal') {
        const play = classifyPlay(cards, room.rules);
        if (!play) { room.pendingAction = null; broadcastRoom(room); return; }
        room.pendingAction = null;
        commitNormalPlay(room, player, cards, play);
        broadcastRoom(room);
        return;
      }
      return;
    }

    if (pending.kind === 'chooseTarget') {
      const targetId = payload.targetId;
      const target = room.players.find(p => p.id === targetId && !p.finished);
      if (!target) return;
      room.pendingAction = {
        kind: 'chooseCard',
        playerId: player.id,
        targetPlayerId: target.id,
        reason: `${target.name} の手札から1枚もらいます`,
        revealHand: target.hand,
      };
      broadcastRoom(room);
      return;
    }

    if (pending.kind === 'chooseCard') {
      const target = room.players.find(p => p.id === pending.targetPlayerId);
      if (!target) return;
      const cardId = payload.cardId;
      const idx = target.hand.findIndex(c => c.id === cardId);
      if (idx >= 0) {
        const [card] = target.hand.splice(idx, 1);
        player.hand.push(card);
        sortHand(player.hand);
        pushLog(room, `${player.name} が ${target.name} からカードを1枚もらいました`);
      }
      const targetIdx = room.players.indexOf(target);
      room.pendingAction = null;
      const ctx = room.postPlayContext || {};
      room.postPlayContext = null;
      finalizeAfterPlay(room, player, !!ctx.includesEight, targetIdx, ctx.clearKind);
      broadcastRoom(room);
      return;
    }

    if (pending.kind === 'exchangeGive') {
      const cardIds = (payload.cardIds || []).slice(0, pending.count);
      const receiver = room.players.find(p => p.id === pending.targetPlayerId);
      if (!receiver) return;
      giveCards(room, player, receiver, cardIds);
      pushLog(room, `${player.name} が ${receiver.name} にカードを${cardIds.length}枚渡しました(交換)`);
      room.pendingAction = null;
      advanceExchangeQueue(room);
      broadcastRoom(room);
      return;
    }
  });

  socket.on('send-chat', ({ text }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return;
    room.chatLog.push({ name: player.name, text: clean, ts: Date.now() });
    if (room.chatLog.length > 200) room.chatLog.shift();
    broadcastRoom(room);
  });

  socket.on('rejoin', ({ roomId, token }) => {
    const room = rooms.get((roomId || '').toUpperCase().trim());
    if (!room) { socket.emit('rejoin-failed'); return; }
    const player = room.players.find(p => p.token === token);
    if (!player) { socket.emit('rejoin-failed'); return; }

    const oldId = player.id;
    if (oldId !== socket.id) {
      remapPlayerId(room, oldId, socket.id);
      player.id = socket.id;
    }
    player.connected = true;
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.token = token;
    pushLog(room, `${player.name} が再接続しました`);
    broadcastRoom(room);
  });

  socket.on('leave-room', () => { handleDisconnect(socket); });
  socket.on('disconnect', () => { handleDisconnect(socket); });
});

// ---------- ラウンド間のカード交換 ----------
function startCardExchange(room) {
  const n = room.players.length;
  const titles = PLACEMENT_TITLES[n];
  if (!titles) return;
  const byTitle = {};
  room.previousPlacements.forEach(pp => { byTitle[pp.title] = pp.playerId; });

  const queue = [];

  function forcedGive(loserTitle, winnerTitle, count) {
    const loserId = byTitle[loserTitle];
    const winnerId = byTitle[winnerTitle];
    const loser = room.players.find(p => p.id === loserId);
    const winner = room.players.find(p => p.id === winnerId);
    if (!loser || !winner) return;
    const sorted = [...loser.hand].sort((a, b) => strengthOf(b.rank, false) - strengthOf(a.rank, false));
    const takeCount = Math.min(count, sorted.length);
    const takenIds = sorted.slice(0, takeCount).map(c => c.id);
    giveCards(room, loser, winner, takenIds);
    pushLog(room, `${loser.name} が強いカードを${takeCount}枚 ${winner.name} に渡しました`);
    queue.push({ giverId: winner.id, receiverId: loser.id, count: takeCount });
  }

  if (byTitle['大貧民'] && byTitle['大富豪']) forcedGive('大貧民', '大富豪', 2);
  if (byTitle['貧民'] && byTitle['富豪']) forcedGive('貧民', '富豪', 1);

  room.exchangeQueue = queue;
  room.phase = 'exchange';
  advanceExchangeQueue(room);
}

function advanceExchangeQueue(room) {
  if (room.phase !== 'exchange') return;
  const next = room.exchangeQueue.shift();
  if (!next) {
    room.phase = 'playing';
    pushLog(room, 'カード交換完了！ゲーム再開');
    triggerEffect(room, 'spark', { label: 'カード交換完了' });
    return;
  }
  const giver = room.players.find(p => p.id === next.giverId);
  if (!giver || giver.hand.length === 0 || next.count === 0) {
    advanceExchangeQueue(room);
    return;
  }
  const receiver = room.players.find(p => p.id === next.receiverId);
  room.pendingAction = {
    kind: 'exchangeGive',
    playerId: giver.id,
    count: Math.min(next.count, giver.hand.length),
    targetPlayerId: receiver.id,
    reason: `カード交換：${receiver.name} に渡すカードを${next.count}枚選んでください`,
  };
}

function remapPlayerId(room, oldId, newId) {
  if (room.hostId === oldId) room.hostId = newId;
  if (room.field.byPlayerId === oldId) room.field.byPlayerId = newId;
  if (room.passedSince.has(oldId)) { room.passedSince.delete(oldId); room.passedSince.add(newId); }
  if (room.pendingAction) {
    if (room.pendingAction.playerId === oldId) room.pendingAction.playerId = newId;
    if (room.pendingAction.targetPlayerId === oldId) room.pendingAction.targetPlayerId = newId;
  }
  if (room.postPlayContext && room.postPlayContext.playerId === oldId) {
    room.postPlayContext.playerId = newId;
  }
  room.finishOrder = room.finishOrder.map(id => (id === oldId ? newId : id));
  if (room.previousPlacements) {
    room.previousPlacements = room.previousPlacements.map(pp =>
      pp.playerId === oldId ? { ...pp, playerId: newId } : pp
    );
  }
  room.exchangeQueue = room.exchangeQueue.map(q => ({
    ...q,
    giverId: q.giverId === oldId ? newId : q.giverId,
    receiverId: q.receiverId === oldId ? newId : q.receiverId,
  }));
}

function handleDisconnect(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  const player = room.players.find(p => p.id === socket.id);
  if (player) {
    player.connected = false;
    pushLog(room, `${player.name} が切断しました`);
  }
  const stillConnected = room.players.some(p => p.connected);
  if (!stillConnected) {
    // すぐには消さず、しばらく猶予を持って再接続を待つ
    setTimeout(() => {
      const r = rooms.get(roomId);
      if (r && !r.players.some(p => p.connected)) rooms.delete(roomId);
    }, 3 * 60 * 1000);
    broadcastRoom(room);
    return;
  }
  broadcastRoom(room);
}

server.listen(PORT, () => {
  console.log(`大富豪サーバー起動: http://localhost:${PORT}`);
});
