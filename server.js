const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

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
    players: [{ id: hostId, name: hostName, clue: null, vote: -1, eliminated: false, categoryVote: null }],
    playerCount: Math.max(3, Math.min(10, playerCount)),
    word: null,
    category: null,
    imposterSocketId: null,
    round: 0,
    phase: 'lobby',
    clues: [],
    eliminationHistory: [],
    roundWords: [],
    usedWords: new Set(),
    revealReady: {}
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

function assignImposter(room) {
  const activePlayers = room.players.filter(p => !p.eliminated);
  const imposter = activePlayers[Math.floor(Math.random() * activePlayers.length)];
  room.imposterSocketId = imposter.id;
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

  const imposterIdx = shuffled.findIndex(p => p.id === room.imposterSocketId);
  if (imposterIdx === 0 && shuffled.length > 1) {
    const swapIdx = Math.floor(Math.random() * (shuffled.length - 1)) + 1;
    [shuffled[0], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[0]];
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
    phase: room.phase
  };
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
    const code = createRoom(socket.id, name, playerCount);
    socket.join('room:' + code);
    const room = getRoom(code);
    io.to(socket.id).emit('roomCreated', { code, roomState: { ...getRoomState(room), isHost: true } });
  });

  socket.on('joinRoom', ({ name, code }) => {
    const roomCode = code.toUpperCase();
    const room = getRoom(roomCode);
    if (!room) { io.to(socket.id).emit('joinError', 'Room not found'); return; }
    if (room.phase !== 'lobby') { io.to(socket.id).emit('joinError', 'Game already started'); return; }
    if (room.players.find(p => p.id === socket.id)) { io.to(socket.id).emit('joinError', 'Already in room'); return; }
    if (room.players.length >= room.playerCount) { io.to(socket.id).emit('joinError', 'Room is full'); return; }

    room.players.push({ id: socket.id, name, clue: null, vote: -1, eliminated: false, categoryVote: null });
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
    if (!player) return;

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

  const TURN_SECONDS = 30;
  let turnTimer = null;

  function startTurn(room) {
    const active = room.players.filter(p => !p.eliminated);
    room.clueTurn = room.clueTurn || 0;

    while (room.clueTurn < (room.turnOrder || []).length) {
      const pid = room.turnOrder[room.clueTurn];
      if (room.players.find(p => p.id === pid && !p.eliminated)) break;
      room.clueTurn++;
    }

    if (room.clueTurn >= (room.turnOrder || []).length) {
      clearTimeout(turnTimer);
      room.phase = 'vote';
      room.readyToVote = {};
      broadcastToRoom(room, 'phaseChange', {
        phase: 'vote',
        activePlayers: active.map(p => ({ id: p.id, name: p.name })),
        allClues: room.clues || []
      });
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

    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
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

    clearTimeout(turnTimer);
    room.clueTurn++;

    startTurn(room);
  }

  socket.on('revealReady', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'reveal') return;
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
    if (socket.id !== room.currentTurnPlayerId) return;

    handleTurnEnd(room, socket.id, clue.trim());
  });

  socket.on('submitVote', ({ targetIdx }) => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'vote') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.vote = targetIdx;

    const allVoted = room.players.every(p => p.eliminated || p.vote !== -1);
    if (allVoted) {
      tallyVotes(room);
    }
  });

  socket.on('nextRound', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;

    room.round++;
    room.phase = 'categoryVote';
    room.clueTurn = 0;
    room.clues = [];
    room.currentTurnPlayerId = null;
    room.players.forEach(p => { p.clue = null; p.vote = -1; p.categoryVote = null; });

    broadcastToRoom(room, 'startCategoryVote', {
      categories: Object.keys(CATEGORIES).map(cat => ({
        name: cat,
        icon: CATEGORY_ICONS[cat],
        words: CATEGORIES[cat].length
      })),
      round: room.round
    });
  });

  socket.on('revealAfterCategory', () => {
    const room = findPlayerRoom(socket.id);
    if (!room || room.phase !== 'categoryVote') return;

    assignImposter(room);
    room.phase = 'reveal';

    room.players.forEach(p => {
      const isImposter = p.id === room.imposterSocketId;
      io.to(p.id).emit('gameStarted', {
        word: room.word,
        isImposter,
        category: room.category,
        round: room.round,
        players: room.players.map((pp, i) => ({ id: pp.id, name: pp.name, eliminated: pp.eliminated }))
      });
    });
  });

  socket.on('playAgain', () => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;

    room.round = 0;
    room.phase = 'lobby';
    room.players.forEach(p => { p.clue = null; p.vote = -1; p.eliminated = false; p.categoryVote = null; });
    room.clues = [];
    room.eliminationHistory = [];
    room.usedWords.clear();
    room.roundWords = [];
    room.playerCount = room.players.length;
    room.imposterSocketId = null;
    room.category = null;

    broadcastToRoom(room, 'playAgain', { roomState: { ...getRoomState(room), isHost: room.hostId === socket.id } });
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
          const imposterStillPlaying = room.players.some(p => !p.eliminated && p.id === room.imposterSocketId);
          if (!imposterStillPlaying) {
            room.phase = 'gameOver';
            room.gameResult = 'crew';
          } else {
            const crewLeft = room.players.filter(p => !p.eliminated && p.id !== room.imposterSocketId).length;
            if (crewLeft === 0) {
              room.phase = 'gameOver';
              room.gameResult = 'imposter';
            }
          }
          const imposterPlayer = room.players.find(p => p.id === room.imposterSocketId);
          broadcastToRoom(room, 'voteResult', {
            eliminatedIdx: -1,
            eliminatedName: room.players[playerIdx].name,
            isImposter: false,
            voteCounts: room.players.filter(p => !p.eliminated).map(p => ({ name: p.name, votes: 0 })),
            round: room.round,
            phase: room.phase,
            gameResult: room.gameResult,
            imposterName: imposterPlayer?.name || 'Unknown',
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
  room.phase = 'result';

  const activePlayers = room.players.filter(p => !p.eliminated);
  const votes = {};
  activePlayers.forEach((p, idx) => {
    if (p.vote >= 0 && p.vote < activePlayers.length) {
      const target = activePlayers[p.vote];
      votes[target.id] = (votes[target.id] || 0) + 1;
    }
  });

  let maxVotes = 0;
  for (const count of Object.values(votes)) {
    if (count > maxVotes) maxVotes = count;
  }

  const tied = Object.entries(votes)
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => id);

  const eliminatedId = tied[Math.floor(Math.random() * tied.length)];
  const eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
  eliminatedPlayer.eliminated = true;

  const isImposter = eliminatedId === room.imposterSocketId;

  room.eliminationHistory.push({
    round: room.round,
    name: eliminatedPlayer.name,
    isImposter
  });

  if (isImposter) {
    room.phase = 'gameOver';
    room.gameResult = 'crew';
  } else {
    const crewLeft = room.players.filter(p => !p.eliminated && p.id !== room.imposterSocketId).length;
    if (crewLeft === 0) {
      room.phase = 'gameOver';
      room.gameResult = 'imposter';
    }
  }

  const voteCounts = activePlayers.map(p => ({
    name: p.name,
    votes: votes[p.id] || 0,
    eliminated: p.id === eliminatedId
  }));

  const imposterPlayer = room.players.find(p => p.id === room.imposterSocketId);

  broadcastToRoom(room, 'voteResult', {
    eliminatedName: eliminatedPlayer.name,
    isImposter,
    voteCounts,
    round: room.round,
    phase: room.phase,
    gameResult: room.gameResult,
    imposterName: imposterPlayer?.name || 'Unknown',
    roundWords: room.roundWords,
    eliminationHistory: room.eliminationHistory,
    category: room.category
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
