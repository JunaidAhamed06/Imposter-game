const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Deep-link support: allow sharing rooms via a friendly URL like /room/ABCD
// We still serve the same SPA (public/index.html); the client reads the room code from the URL.
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Convenience: /room -> home
app.get('/room', (req, res) => res.redirect('/'));

const CATEGORIES = {
  Movies: [
    "Titanic", "Avatar", "Inception", "Gladiator", "Frozen",
    "Matrix", "Jurassic Park", "Lion King", "Batman", "Spiderman",
    "Godzilla", "Joker", "Interstellar", "Rocky", "Alien",
    "Shrek", "Toy Story", "Finding Nemo", "Up", "Coco"
  ],
  Food: [
    "Pizza", "Sushi", "Taco", "Burger", "Pasta",
    "Ice Cream", "Chocolate", "Waffle", "Ramen", "Croissant",
    "Donut", "Pancake", "Popcorn", "Cupcake", "Nachos",
    "Burrito", "Pretzel", "Falafel", "Paella", "Mochi"
  ],
  Animals: [
    "Dolphin", "Penguin", "Tiger", "Eagle", "Octopus",
    "Panda", "Koala", "Flamingo", "Shark", "Elephant",
    "Giraffe", "Cheetah", "Parrot", "Camel", "Peacock",
    "Chameleon", "Jellyfish", "Hedgehog", "Otter", "Toucan"
  ],
  Games: [
    "Minecraft", "Fortnite", "Tetris", "Pacman", "Mario",
    "Zelda", "Pokemon", "Roblox", "Among Us", "Chess",
    "Sudoku", "Monopoly", "Scrabble", "Uno", "Cluedo",
    "Snake", "Pong", "Solitaire", "Rubiks Cube", "Jenga"
  ]
};

const CATEGORY_ICONS = {
  Movies: "\uD83C\uDFAC",
  Food: "\uD83C\uDF55",
  Animals: "\uD83D\uDC3E",
  Games: "\uD83C\uDFAE"
};

const rooms = new Map();

function normalizeName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function isValidPlayerName(name) {
  // Letters and spaces only; must contain at least one letter.
  if (!name || name.length > 20) return false;
  if (!/^[A-Za-z ]+$/.test(name)) return false;
  return /[A-Za-z]/.test(name);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoom(roomCode) {
  return rooms.get(roomCode.toUpperCase());
}

function createRoom(hostId, hostName, playerCount) {
  const code = generateCode();
  rooms.set(code, {
    code,
    hostId,
    players: [{ id: hostId, name: hostName, clue: null, vote: null, eliminated: false, spectator: false, categoryVote: null }],
    playerCount: Math.max(3, Math.min(10, playerCount)),
    word: null,
    category: null,
    imposterSocketIds: [],
    round: 0,
    phase: 'lobby',
    clues: [],
    eliminationHistory: [],
    roundWords: [],
    usedWords: new Set(),
    revealReady: {},
    discussionSeconds: 60,
    discussionEndsAt: null,
    discussionMessages: [],
    discussionTimer: null,
    autoNextRoundTimer: null,
    turnTimer: null,
    // When the imposter is voted out, they get ONE chance to guess the word.
    // { imposterId: string, attempted: boolean }
    imposterGuess: null,
    lastVotePayload: null
  });
  return code;
}

function pickWord(room) {
  const words = CATEGORIES[room.category] || [];
  const available = words.filter(w => !room.usedWords.has(w));
  let word;
  if (available.length > 0) {
    word = available[Math.floor(Math.random() * available.length)];
  } else {
    room.usedWords.clear();
    word = words[Math.floor(Math.random() * words.length)];
  }
  room.word = word;
  room.usedWords.add(word);
  room.roundWords.push(word);
}

function clampInt(n, min, max) {
  const x = Number.isFinite(+n) ? Math.floor(+n) : min;
  return Math.max(min, Math.min(max, x));
}

function isImposter(room, socketId) {
  return (room.imposterSocketIds || []).includes(socketId);
}

function getImposterNames(room) {
  const ids = room.imposterSocketIds || [];
  const names = ids
    .map(id => room.players.find(p => p.id === id)?.name)
    .filter(Boolean);
  return names.length ? names : ['Unknown'];
}

function clearRoomTimers(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.discussionTimer) { clearTimeout(room.discussionTimer); room.discussionTimer = null; }
  if (room.autoNextRoundTimer) { clearTimeout(room.autoNextRoundTimer); room.autoNextRoundTimer = null; }
}

function assignImposters(room) {
  const activePlayers = room.players.filter(p => !p.eliminated);
  const imposterCount = activePlayers.length >= 7 ? 2 : 1;

  const shuffled = [...activePlayers];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  room.imposterSocketIds = shuffled.slice(0, imposterCount).map(p => p.id);
  pickWord(room);
  room.revealReady = {};
}

function tallyCategoryVotes(room) {
  const votes = {};
  Object.keys(CATEGORIES).forEach(c => votes[c] = 0);
  room.players.forEach(p => {
    if (p.categoryVote && votes[p.categoryVote] !== undefined) {
      votes[p.categoryVote]++;
    }
  });

  let maxVotes = 0;
  for (const count of Object.values(votes)) {
    if (count > maxVotes) maxVotes = count;
  }

  const tied = Object.entries(votes)
    .filter(([, count]) => count === maxVotes)
    .map(([cat]) => cat);

  room.category = tied[Math.floor(Math.random() * tied.length)];
  return { votes, chosen: room.category };
}

function shuffleTurnOrder(room) {
  const active = room.players.filter(p => !p.eliminated);
  const shuffled = [...active];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Avoid having an imposter go first (it makes the game easier).
  const imposterIdx = shuffled.findIndex(p => isImposter(room, p.id));
  if (imposterIdx === 0 && shuffled.length > 1) {
    const nonImposters = shuffled
      .map((p, idx) => ({ p, idx }))
      .filter(x => !isImposter(room, x.p.id));
    if (nonImposters.length > 0) {
      const swapIdx = nonImposters[Math.floor(Math.random() * nonImposters.length)].idx;
      [shuffled[0], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[0]];
    }
  }

  room.turnOrder = shuffled.map(p => p.id);
}

function broadcastToRoom(room, event, data) {
  room.players.forEach(p => {
    io.to(p.id).emit(event, data);
  });
}

function getRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      eliminated: p.eliminated
    })),
    playerCount: room.playerCount,
    round: room.round,
    phase: room.phase,
    discussionSeconds: room.discussionSeconds
  };
}

const TURN_SECONDS = 30;

function startNextRound(room) {
  clearRoomTimers(room);
  room.round++;
  room.phase = 'categoryVote';
  room.clueTurn = 0;
  room.clues = [];
  room.discussionMessages = [];
  room.discussionEndsAt = null;
  room.currentTurnPlayerId = null;
  room.readyToVote = {};
  room.players.forEach(p => { p.clue = null; p.vote = null; p.categoryVote = null; });
  room.imposterGuess = null;
  room.lastVotePayload = null;

  broadcastToRoom(room, 'startCategoryVote', {
    categories: Object.keys(CATEGORIES).map(cat => ({
      name: cat,
      icon: CATEGORY_ICONS[cat],
      words: CATEGORIES[cat].length
    })),
    round: room.round
  });
}

function enterVotePhase(room) {
  const active = room.players.filter(p => !p.eliminated);
  if (room.discussionTimer) { clearTimeout(room.discussionTimer); room.discussionTimer = null; }
  room.phase = 'vote';
  // Used for early-finish voting during discussion.
  room.readyToVote = {};

  broadcastToRoom(room, 'phaseChange', {
    phase: 'vote',
    activePlayers: active.map(p => ({ id: p.id, name: p.name })),
    allClues: room.clues || []
  });

  // If everyone already voted during discussion, resolve immediately.
  const votedCount = active.filter(p => p.vote !== null).length;
  if (votedCount === active.length && active.length > 0) {
    tallyVotes(room);
  } else {
    // Let clients show who has voted so far.
    const votedIds = active.filter(p => p.vote !== null).map(p => p.id);
    broadcastToRoom(room, 'voteStatus', { votedIds, total: active.length });
  }
}

function startDiscussion(room) {
  const active = room.players.filter(p => !p.eliminated);
  room.phase = 'discussion';
  room.discussionMessages = [];
  room.discussionEndsAt = Date.now() + (room.discussionSeconds || 60) * 1000;
  room.readyToVote = {};

  broadcastToRoom(room, 'discussionStart', {
    seconds: room.discussionSeconds || 60,
    endsAt: room.discussionEndsAt,
    activePlayers: active.map(p => ({ id: p.id, name: p.name })),
    allClues: room.clues || []
  });

  if (room.discussionTimer) clearTimeout(room.discussionTimer);
  room.discussionTimer = setTimeout(() => {
    if (room.phase !== 'discussion') return;
    enterVotePhase(room);
  }, (room.discussionSeconds || 60) * 1000);
}

function startTurn(room) {
  const active = room.players.filter(p => !p.eliminated);
  room.clueTurn = room.clueTurn || 0;

  while (room.clueTurn < (room.turnOrder || []).length) {
    const pid = room.turnOrder[room.clueTurn];
    if (room.players.find(p => p.id === pid && !p.eliminated)) break;
    room.clueTurn++;
  }

  if (room.clueTurn >= (room.turnOrder || []).length) {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    startDiscussion(room);
    return;
  }

  const currentPlayerId = room.turnOrder[room.clueTurn];
  const currentPlayer = room.players.find(p => p.id === currentPlayerId);
  room.currentTurnPlayerId = currentPlayer.id;

  broadcastToRoom(room, 'turnChange', {
    currentPlayerId: currentPlayer.id,
    currentPlayerName: currentPlayer.name,
    turnIndex: room.clueTurn + 1,
    totalTurns: active.length,
    timer: TURN_SECONDS,
    submittedClues: room.clues || []
  });

  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    if (room.phase !== 'clue' || room.currentTurnPlayerId !== currentPlayer.id) return;
    handleTurnEnd(room, currentPlayer.id, null);
  }, TURN_SECONDS * 1000);
}

function handleTurnEnd(room, playerId, clue) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;

  if (clue) player.clue = clue;
  else player.clue = '(no clue given)';

  room.clues = room.clues || [];
  room.clues.push({
    name: player.name,
    clue: player.clue,
    isSelf: false
  });

  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.clueTurn++;

  startTurn(room);
}

function findPlayerRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players.find(p => p.id === socketId)) return room;
  }
  return null;
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('createRoom', ({ name, playerCount }) => {
    const cleanName = normalizeName(name);
    if (!isValidPlayerName(cleanName)) {
      io.to(socket.id).emit('joinError', 'Name can contain letters and spaces only');
      return;
    }
    const code = createRoom(socket.id, cleanName, playerCount);
    socket.join('room:' + code);
    const room = getRoom(code);
    io.to(socket.id).emit('roomCreated', { code, roomState: { ...getRoomState(room), isHost: true } });
  });

  socket.on('joinRoom', ({ name, code }) => {
    const cleanName = normalizeName(name);
    if (!isValidPlayerName(cleanName)) { io.to(socket.id).emit('joinError', 'Name can contain letters and spaces only'); return; }
    const roomCode = code.toUpperCase();
    const room = getRoom(roomCode);
    if (!room) { io.to(socket.id).emit('joinError', 'Room not found'); return; }
    if (room.phase !== 'lobby') { io.to(socket.id).emit('joinError', 'Game already started'); return; }
    if (room.players.find(p => p.id === socket.id)) { io.to(socket.id).emit('joinError', 'Already in room'); return; }
    if (room.players.length >= room.playerCount) { io.to(socket.id).emit('joinError', 'Room is full'); return; }

    room.players.push({ id: socket.id, name: cleanName, clue: null, vote: null, eliminated: false, spectator: false, categoryVote: null });
    socket.join('room:' + room.code);
    broadcastToRoom(room, 'roomUpdate', getRoomState(room));
    io.to(socket.id).emit('roomJoined', { code: room.code, roomState: getRoomState(room) });
  });

  socket.on('updatePlayerCount', ({ playerCount }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    room.playerCount = Math.max(3, Math.min(10, playerCount));
    broadcastToRoom(room, 'roomUpdate', getRoomState(room));
  });

  socket.on('updateDiscussionTime', ({ seconds }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    room.discussionSeconds = clampInt(seconds, 30, 200);
    broadcastToRoom(room, 'roomUpdate', getRoomState(room));
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (!playerId || playerId === room.hostId) return;

    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;
    room.players.splice(idx, 1);

    const sock = io.sockets.sockets.get(playerId);
    if (sock) {
      try { sock.leave('room:' + room.code); } catch (e) {}
      io.to(playerId).emit('kicked', { reason: 'Removed by host' });
    }

    broadcastToRoom(room, 'roomUpdate', getRoomState(room));
  });

  socket.on('startGame', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (room.players.length < 3) return;

    room.round = 1;
    room.phase = 'categoryVote';
    room.players.forEach(p => { p.categoryVote = null; });

    broadcastToRoom(room, 'startCategoryVote', {
      categories: Object.keys(CATEGORIES).map(cat => ({
        name: cat,
        icon: CATEGORY_ICONS[cat],
        words: CATEGORIES[cat].length
      })),
      round: room.round
    });
  });

  socket.on('submitCategoryVote', ({ category }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'categoryVote') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;

    player.categoryVote = category;

    const allVoted = room.players.every(p => p.eliminated || p.categoryVote !== null);
    if (allVoted) {
      const result = tallyCategoryVotes(room);
      room.usedWords.clear();

      broadcastToRoom(room, 'categoryResult', {
        chosen: result.chosen,
        icon: CATEGORY_ICONS[result.chosen],
        votes: result.votes,
        round: room.round
      });
    }
  });

  socket.on('revealReady', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'reveal') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;
    room.revealReady[socket.id] = true;

    const allReady = room.players.every(p => p.eliminated || room.revealReady[p.id]);
    if (allReady) {
      broadcastToRoom(room, 'revealComplete', {});
      setTimeout(() => {
        if (room.phase !== 'reveal') return;
        room.phase = 'clue';
        room.clueTurn = 0;
        room.clues = [];
        room.currentTurnPlayerId = null;
        room.players.forEach(p => { p.clue = null; });
        shuffleTurnOrder(room);
        startTurn(room);
      }, 2500);
    }
  });

  socket.on('submitClue', ({ clue }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'clue') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;
    if (socket.id !== room.currentTurnPlayerId) return;

    handleTurnEnd(room, socket.id, clue.trim());
  });

  socket.on('readyToVote', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'discussion') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;

    room.readyToVote = room.readyToVote || {};
    room.readyToVote[socket.id] = true;

    const active = room.players.filter(p => !p.eliminated);
    const readyCount = active.filter(p => room.readyToVote[p.id]).length;

    broadcastToRoom(room, 'readyToVoteStatus', {
      readyCount,
      total: active.length
    });

    // Everyone must agree to end discussion early.
    const allReady = active.every(p => room.readyToVote[p.id]);
    if (allReady) {
      broadcastToRoom(room, 'chatMessage', { name: 'System', text: 'Everyone is ready — voting starts now.', ts: Date.now() });
      enterVotePhase(room);
    }
  });

  socket.on('submitVote', ({ targetIdx, targetId }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || (room.phase !== 'vote' && room.phase !== 'discussion')) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;
    // Back-compat: older clients send targetIdx (index into activePlayers list)
    if (typeof targetId === 'string') {
      player.vote = targetId;
    } else if (Number.isFinite(+targetIdx)) {
      player.vote = Math.floor(+targetIdx);
    } else {
      player.vote = null;
    }

    const active = room.players.filter(p => !p.eliminated);
    const votedIds = active.filter(p => p.vote !== null).map(p => p.id);
    broadcastToRoom(room, 'voteStatus', { votedIds, total: active.length });

    const allVoted = votedIds.length === active.length;
    if (allVoted) {
      if (room.phase === 'discussion') {
        if (room.discussionTimer) { clearTimeout(room.discussionTimer); room.discussionTimer = null; }
        room.phase = 'vote';
      }
      tallyVotes(room);
    }
  });

  socket.on('submitImposterGuess', ({ guess }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'imposterGuess' || !room.imposterGuess) return;
    if (socket.id !== room.imposterGuess.imposterId) return;
    if (room.imposterGuess.attempted) return;

    room.imposterGuess.attempted = true;

    const normalize = (s) => (s || '').toString().trim().toLowerCase();
    const isCorrect = normalize(guess) === normalize(room.word);

    room.phase = 'gameOver';
    room.gameResult = isCorrect ? 'imposter' : 'crew';

    const finalPayload = {
      ...(room.lastVotePayload || {}),
      phase: room.phase,
      gameResult: room.gameResult
    };

    broadcastToRoom(room, 'imposterGuessResolved', {
      ...finalPayload,
      guess: (guess || '').toString().trim(),
      isCorrect
    });
  });

  socket.on('nextRound', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'result') return;
    startNextRound(room);
  });

  socket.on('revealAfterCategory', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'categoryVote') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;

    clearRoomTimers(room);
    assignImposters(room);
    room.phase = 'reveal';

    room.players.forEach(p => {
      const isImp = isImposter(room, p.id);
      const isSpectator = !!p.spectator && p.eliminated;
      io.to(p.id).emit('gameStarted', {
        // Never send the secret word to the imposter client.
        // Also never send the secret word to spectators (voted-out crew).
        word: (isImp || isSpectator) ? null : room.word,
        isImposter: isImp,
        isSpectator,
        category: room.category,
        round: room.round,
        players: room.players.map((pp, i) => ({ id: pp.id, name: pp.name, eliminated: pp.eliminated, spectator: !!pp.spectator }))
      });
    });
  });

  socket.on('playAgain', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'gameOver') return;

    clearRoomTimers(room);
    room.round = 0;
    room.phase = 'lobby';
    room.players.forEach(p => { p.clue = null; p.vote = null; p.eliminated = false; p.spectator = false; p.categoryVote = null; });
    room.clues = [];
    room.eliminationHistory = [];
    room.usedWords.clear();
    room.roundWords = [];
    room.playerCount = room.players.length;
    room.imposterSocketIds = [];
    room.category = null;
    room.readyToVote = {};
    room.imposterGuess = null;
    room.lastVotePayload = null;

    broadcastToRoom(room, 'playAgain', { roomState: { ...getRoomState(room), isHost: room.hostId === socket.id } });
  });

  socket.on('sendChat', ({ text }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'discussion') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;
    const msg = (text || '').toString().trim();
    if (!msg) return;
    if (msg.length > 200) return;

    const payload = { name: player.name, text: msg, ts: Date.now() };
    room.discussionMessages.push(payload);
    broadcastToRoom(room, 'chatMessage', payload);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    for (const [code, room] of rooms) {
      const playerIdx = room.players.findIndex(p => p.id === socket.id);
      if (playerIdx !== -1) {
        if (room.phase === 'lobby') {
          room.players.splice(playerIdx, 1);
          if (room.players.length === 0) {
            rooms.delete(code);
          } else {
            if (room.hostId === socket.id) room.hostId = room.players[0].id;
            broadcastToRoom(room, 'roomUpdate', getRoomState(room));
          }
        } else {
          room.players[playerIdx].eliminated = true;
          room.players[playerIdx].spectator = true;

          const remainingImposters = (room.imposterSocketIds || []).filter(id => {
            const p = room.players.find(pp => pp.id === id);
            return p && !p.eliminated;
          });
          const crewLeft = room.players.filter(p => !p.eliminated && !isImposter(room, p.id)).length;

          if (remainingImposters.length === 0) {
            room.phase = 'gameOver';
            room.gameResult = 'crew';
          } else if (crewLeft === 0) {
            room.phase = 'gameOver';
            room.gameResult = 'imposter';
          }

          const imposterNames = getImposterNames(room);
          broadcastToRoom(room, 'voteResult', {
            eliminatedIdx: -1,
            eliminatedName: room.players[playerIdx].name,
            isImposter: isImposter(room, room.players[playerIdx].id),
            voteCounts: room.players.filter(p => !p.eliminated).map(p => ({ name: p.name, votes: 0 })),
            round: room.round,
            phase: room.phase,
            gameResult: room.gameResult,
            imposterName: imposterNames.join(' & '),
            roundWords: room.roundWords,
            eliminationHistory: room.eliminationHistory,
            category: room.category
          });
        }
        return;
      }
    }
  });
});

function tallyVotes(room) {
  // Default post-vote state (unless we move into imposterGuess / gameOver).
  room.phase = 'result';

  const activePlayers = room.players.filter(p => !p.eliminated);
  const activeIds = new Set(activePlayers.map(p => p.id));

  const votesById = {};
  let skipVotes = 0;

  // Decode votes (supports: legacy index votes, id votes, and 'skip')
  activePlayers.forEach(voter => {
    let raw = voter.vote;
    let targetId = null;

    if (typeof raw === 'number' && raw >= 0 && raw < activePlayers.length) {
      targetId = activePlayers[raw].id;
    } else if (typeof raw === 'string') {
      targetId = raw;
    }

    if (targetId === 'skip') {
      skipVotes++;
    } else if (targetId && activeIds.has(targetId)) {
      votesById[targetId] = (votesById[targetId] || 0) + 1;
    }
  });

  const skipMajority = skipVotes > activePlayers.length / 2;
  let isTie = false;
  let eliminatedId = null;

  if (!skipMajority) {
    let maxVotes = 0;
    for (const count of Object.values(votesById)) {
      if (count > maxVotes) maxVotes = count;
    }

    const top = Object.entries(votesById)
      .filter(([, count]) => count === maxVotes && maxVotes > 0)
      .map(([id]) => id);

    if (top.length === 1) {
      eliminatedId = top[0];
    } else {
      // Tie OR no-one got any player votes (e.g., too many skips but not majority).
      isTie = true;
    }
  }

  let eliminatedPlayer = null;
  let eliminatedIsImposter = false;

  if (eliminatedId) {
    eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
    if (eliminatedPlayer) {
      eliminatedPlayer.eliminated = true;
      eliminatedIsImposter = isImposter(room, eliminatedId);
      eliminatedPlayer.spectator = true;

      room.eliminationHistory.push({
        round: room.round,
        name: eliminatedPlayer.name,
        isImposter: eliminatedIsImposter
      });

      const remainingImposters = (room.imposterSocketIds || []).filter(id => {
        const p = room.players.find(pp => pp.id === id);
        return p && !p.eliminated;
      });
      const crewLeft = room.players.filter(p => !p.eliminated && !isImposter(room, p.id)).length;

      if (remainingImposters.length === 0 && eliminatedIsImposter) {
        // Last remaining imposter gets one final chance to guess the word.
        room.phase = 'imposterGuess';
        room.gameResult = null;
        room.imposterGuess = { imposterId: eliminatedId, attempted: false };
      } else if (crewLeft === 0) {
        room.phase = 'gameOver';
        room.gameResult = 'imposter';
      }
    } else {
      // Defensive fallback
      eliminatedId = null;
      isTie = true;
    }
  }

  const voteCounts = [
    ...activePlayers.map(p => ({
      name: p.name,
      votes: votesById[p.id] || 0,
      eliminated: eliminatedId ? (p.id === eliminatedId) : false
    })),
    { name: 'Skip', votes: skipVotes, eliminated: false, skip: true }
  ];

  const imposterNames = getImposterNames(room);

  const autoNextRound = room.phase === 'result' && (skipMajority || isTie);
  const autoNextRoundSeconds = 4;

  const payload = {
    eliminatedId,
    eliminatedName: eliminatedPlayer ? eliminatedPlayer.name : null,
    isImposter: eliminatedIsImposter,
    voteCounts,
    round: room.round,
    phase: room.phase,
    gameResult: room.gameResult,
    imposterName: imposterNames.join(' & '),
    roundWords: room.roundWords,
    eliminationHistory: room.eliminationHistory,
    category: room.category,
    imposterGuess: room.phase === 'imposterGuess'
      ? { imposterId: room.imposterGuess?.imposterId }
      : null,
    skipMajority,
    tie: isTie,
    autoNextRound,
    autoNextRoundSeconds
  };

  room.lastVotePayload = payload;

  broadcastToRoom(room, 'voteResult', payload);

  if (autoNextRound) {
    if (room.autoNextRoundTimer) clearTimeout(room.autoNextRoundTimer);
    room.autoNextRoundTimer = setTimeout(() => {
      if (room.phase !== 'result') return;
      startNextRound(room);
    }, autoNextRoundSeconds * 1000);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
