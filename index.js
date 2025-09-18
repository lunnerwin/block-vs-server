// 필요한 라이브러리들을 불러옵니다.
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { v4: uuidv4 } = require('uuid'); // 고유 ID 생성을 위한 라이브러리

// 서버의 기본 설정을 합니다.
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // 모든 주소에서의 접속을 허용합니다.
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000; // Render가 지정하는 포트 또는 3000번 포트를 사용합니다.

// --- 서버 메모리에 저장될 데이터들 ---

// 1. 플레이어 정보 및 상태 저장소
// key: 닉네임, value: 플레이어 정보 객체 { socketId, nickname, country, advenLv, isReady, isAutoReady, inBattle }
const players = {};
// 2. 소켓 ID와 닉네임을 매핑하는 저장소 (연결 끊김 시 빠른 조회를 위함)
const socketIdToNickname = {};

// 3. 현재 진행중인 게임방 정보
// key: battleId, value: { players: [ {nickname, socketId}, ... ], ... }
const gameRooms = {};


// --- 클라이언트가 접속했을 때 처리할 로직 ---
io.on('connection', (socket) => {
  console.log(`[Connection] A user connected: ${socket.id}`);

  // --- 1. 로그인 및 중복 접속 처리 ---
  socket.on('register', (nickname) => {
    if (players[nickname] && players[nickname].socketId !== socket.id) {
        // 이미 다른 소켓으로 접속 중인 유저가 있다면, 이전 소켓의 연결을 끊습니다.
        console.log(`[Duplicate Login] ${nickname} logged in from a new device. Disconnecting old session.`);
        const oldSocketId = players[nickname].socketId;
        io.to(oldSocketId).emit('force_logout');
        io.sockets.sockets.get(oldSocketId)?.disconnect();
    }
    socketIdToNickname[socket.id] = nickname;
    players[nickname] = { ...players[nickname], socketId: socket.id, nickname: nickname };
    console.log(`[Register] User '${nickname}' registered with socket ID ${socket.id}`);
  });


  // --- 2. 로비(대기실) 관련 로직 ---
  socket.on('enterLobby', (playerData) => {
    const nickname = socketIdToNickname[socket.id];
    if (!nickname) return;

    socket.join('lobby'); // 'lobby'라는 채널(방)에 참여시킵니다.
    players[nickname] = {
        ...players[nickname],
        country: playerData.country,
        advenLv: playerData.advenLv,
        isReady: playerData.isReady,
        isAutoReady: playerData.isAutoReady,
        inBattle: false, // 로비에 들어오면 항상 false로 초기화
    };
    console.log(`[Enter Lobby] ${nickname} entered the lobby.`);
    broadcastLobbyUpdate();
  });

  socket.on('leaveLobby', () => {
    socket.leave('lobby');
    console.log(`[Leave Lobby] ${socketIdToNickname[socket.id]} left the lobby for a match.`);
  });

  socket.on('toggleReady', (isReady) => {
    const nickname = socketIdToNickname[socket.id];
    if (players[nickname]) {
      players[nickname].isReady = isReady;
      broadcastLobbyUpdate();
    }
  });

  socket.on('toggleAutoReady', (isAutoReady) => {
    const nickname = socketIdToNickname[socket.id];
    if (players[nickname]) {
      players[nickname].isAutoReady = isAutoReady;
      broadcastLobbyUpdate();
    }
  });


  // --- 3. 매치메이킹 관련 로직 ---
  socket.on('sendManualRequest', (data) => {
    handleRequest(socket, data.opponentNickname, false);
  });
  socket.on('sendAutoMatchRequest', (data) => {
    handleRequest(socket, data.opponentNickname, true);
  });

  socket.on('respondToRequest', (data) => {
    const myNickname = socketIdToNickname[socket.id];
    const requesterNickname = data.requesterNickname;
    const requester = players[requesterNickname];
    
    if (!requester) return;

    if (data.accepted) {
        startBattle(requesterNickname, myNickname);
    } else {
        const eventName = data.isAutoMatch ? 'autoMatchRequestDeclined' : 'manualRequestDeclined';
        io.to(requester.socketId).emit(eventName, { fromNickname: myNickname });
    }
  });

  // --- 4. 게임방(Battle Room) 관련 로직 ---
  socket.on('joinRoom', (battleId) => {
      socket.join(battleId);
      console.log(`[Join Room] ${socketIdToNickname[socket.id]} joined battle room: ${battleId}`);
  });
  socket.on('leaveRoom', (data) => {
      const battleId = data.battleId;
      socket.leave(battleId);
      console.log(`[Leave Room] ${socketIdToNickname[socket.id]} left battle room: ${battleId}`);
  });

  socket.on('playerReadyForStart', (data) => {
      handlePlayerReady(socket, data.battleId, 'readyStates');
  });
  socket.on('playerReadyForRematch', (data) => {
      handlePlayerReady(socket, data.battleId, 'rematchReadyStates');
  });

  socket.on('sendGridData', (data) => {
    socket.to(data.battleId).emit('opponentGridUpdate', data.gridData);
  });

  socket.on('sendAttack', (data) => {
    socket.to(data.battleId).emit('incomingAttack', data.attackData);
  });

  socket.on('setAwayStatus', (data) => {
    socket.to(data.battleId).emit('opponentAwayStatus', { isAway: data.isAway });
  });

  socket.on('reportKO', (data) => {
      const battle = gameRooms[data.battleId];
      if (!battle) return;
      
      const opponentNickname = data.opponentNickname;
      battle.outCounts[opponentNickname] = (battle.outCounts[opponentNickname] || 0) + 1;
      
      const outCounts = battle.outCounts;
      io.to(data.battleId).emit('updateOutCount', outCounts);

      if (outCounts[opponentNickname] >= 3) {
          io.to(data.battleId).emit('gameOver', { winner: socketIdToNickname[socket.id], reason: 'KO' });
      }
  });

  socket.on('declareDefeat', (data) => {
    const battle = gameRooms[data.battleId];
    if (!battle) return;
    
    const loser = socketIdToNickname[socket.id];
    const winner = battle.players.find(p => p.nickname !== loser)?.nickname;

    io.to(data.battleId).emit('gameOver', { winner: winner, loser: loser, reason: data.hasLeft ? 'left' : 'defeat' });
  });

  // --- 5. 재대결 로직 ---
  socket.on('requestRematch', (data) => {
      const battle = gameRooms[data.battleId];
      if (!battle) return;
      const requester = socketIdToNickname[socket.id];
      const opponent = battle.players.find(p => p.nickname !== requester);
      if (opponent) {
          io.to(opponent.socketId).emit('rematchRequested');
      }
  });

  socket.on('answerRematch', (data) => {
      const battle = gameRooms[data.battleId];
      if (!battle) return;
      const responder = socketIdToNickname[socket.id];
      const requester = battle.players.find(p => p.nickname !== responder);

      if (requester) {
          if (data.accepted) {
              io.to(requester.socketId).emit('rematchAccepted');
              // 양쪽 모두 준비 상태를 초기화하고 재대결 시작
              battle.rematchReadyStates = { [requester.nickname]: false, [responder.nickname]: false };
              io.to(data.battleId).emit('startRematch');
          } else {
              io.to(requester.socketId).emit('rematchDeclined');
          }
      }
  });
  

  // --- 6. 연결 끊김 처리 ---
  socket.on('disconnect', () => {
    console.log(`[Disconnection] A user disconnected: ${socket.id}`);
    const nickname = socketIdToNickname[socket.id];
    if (nickname) {
        // 게임 중이던 방 찾기
        const battleId = Object.keys(gameRooms).find(id => gameRooms[id].players.some(p => p.nickname === nickname));
        if (battleId) {
            io.to(battleId).emit('opponentLeft');
            delete gameRooms[battleId];
        }

        delete players[nickname];
        delete socketIdToNickname[socket.id];
        broadcastLobbyUpdate(); // 로비에 있는 유저들에게 변경사항 알림
    }
  });
});

// --- 헬퍼 함수들 ---

function handleRequest(socket, opponentNickname, isAutoMatch) {
  const requesterNickname = socketIdToNickname[socket.id];
  const opponent = players[opponentNickname];
  if (!opponent || !requesterNickname) return;

  const eventName = isAutoMatch ? 'incomingAutoMatchRequest' : 'incomingManualRequest';
  io.to(opponent.socketId).emit(eventName, { fromNickname: requesterNickname });
}

function handlePlayerReady(socket, battleId, readyStateType) {
    const battle = gameRooms[battleId];
    if (!battle) return;

    const nickname = socketIdToNickname[socket.id];
    if (!battle[readyStateType]) {
        battle[readyStateType] = {};
    }
    battle[readyStateType][nickname] = true;

    const allReady = battle.players.every(p => battle[readyStateType][p.nickname]);
    if (allReady) {
        const eventName = readyStateType === 'readyStates' ? 'gameStart' : 'startRematch';
        io.to(battleId).emit(eventName);
    }
}

function broadcastLobbyUpdate() {
  const lobbyPlayers = Object.values(players).filter(p => !p.inBattle && p.socketId);
  io.to('lobby').emit('lobbyUpdate', lobbyPlayers);
  console.log(`[Lobby Update] Broadcasting info of ${lobbyPlayers.length} player(s).`);
}

function startBattle(player1Nickname, player2Nickname) {
    const player1 = players[player1Nickname];
    const player2 = players[player2Nickname];

    if (!player1 || !player2) return;

    const battleId = `battle_${uuidv4()}`;
    player1.inBattle = true;
    player2.inBattle = true;
    
    gameRooms[battleId] = {
        players: [
            {nickname: player1.nickname, socketId: player1.socketId},
            {nickname: player2.nickname, socketId: player2.socketId}
        ],
        rematchState: { [player1.nickname]: 'none', [player2.nickname]: 'none' },
        outCounts: { [player1.nickname]: 0, [player2.nickname]: 0 },
        readyStates: { [player1.nickname]: false, [player2.nickname]: false },
    };
    
    console.log(`[Battle Start] ${player1.nickname} vs ${player2.nickname}. Battle ID: ${battleId}`);

    io.to(player1.socketId).emit('matchFound', { 
        battleId: battleId, 
        opponent: { nickname: player2.nickname, country: player2.country },
        isPlayer1: true
    });
    io.to(player2.socketId).emit('matchFound', { 
        battleId: battleId, 
        opponent: { nickname: player1.nickname, country: player1.country },
        isPlayer1: false
    });
    
    broadcastLobbyUpdate();
}

server.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
