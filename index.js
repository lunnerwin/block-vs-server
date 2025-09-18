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
const players = {}; // key: 닉네임, value: 플레이어 정보 객체
const socketIdToNickname = {}; // key: 소켓 ID, value: 닉네임
const gameRooms = {}; // key: battleId, value: 게임방 정보


// --- 클라이언트가 접속했을 때 처리할 로직 ---
io.on('connection', (socket) => {
  console.log(`[Connection] A user connected: ${socket.id}`);

  // --- 1. 로그인 및 중복 접속 처리 ---
  socket.on('register', (nickname) => {
    if (players[nickname] && players[nickname].socketId !== socket.id) {
        console.log(`[Duplicate Login] ${nickname} logged in from a new device. Disconnecting old session.`);
        const oldSocketId = players[nickname].socketId;
        io.to(oldSocketId).emit('force_logout');
        io.sockets.sockets.get(oldSocketId)?.disconnect();
    }
    socketIdToNickname[socket.id] = nickname;
    players[nickname] = { ...players[nickname], socketId: socket.id, nickname: nickname, isAway: false }; // AFK 상태 초기화
    console.log(`[Register] User '${nickname}' registered with socket ID ${socket.id}`);
  });


  // --- 2. 로비(대기실) 관련 로직 ---
  socket.on('enterLobby', (playerData) => {
    const nickname = socketIdToNickname[socket.id];
    if (!nickname) return;

    socket.join('lobby');
    players[nickname] = {
        ...players[nickname],
        country: playerData.country,
        advenLv: playerData.advenLv,
        isReady: playerData.isReady,
        isAutoReady: playerData.isAutoReady,
        inBattle: false,
        isAway: false, // 로비 진입 시 AFK 상태 해제
    };
    console.log(`[Enter Lobby] ${nickname} entered the lobby.`);
    broadcastLobbyUpdate();
  });

  socket.on('leaveLobby', () => {
    const nickname = socketIdToNickname[socket.id];
    if (players[nickname]) {
      socket.leave('lobby');
      console.log(`[Leave Lobby] ${nickname} left the lobby.`);
    }
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


  // --- 3. 매치메이킹 관련 로직 (Firebase UI/UX 복원을 위해 전면 수정) ---

  // 3-1. (요청자)가 (상대방)에게 대결 신청
  socket.on('sendManualRequest', (data) => {
    const requesterNickname = socketIdToNickname[socket.id];
    const opponentNickname = data.opponentNickname;
    const opponent = players[opponentNickname];

    if (!requesterNickname || !opponent) return;

    // 상대가 자리에 없거나, 다른 게임 중이면 요청자에게 바로 알림
    if (opponent.isAway || opponent.inBattle) {
        socket.emit('opponentIsAfk', { fromNickname: opponentNickname });
        return;
    }
    
    // 상대방에게 요청 전달
    io.to(opponent.socketId).emit('incomingManualRequest', { 
        fromNickname: requesterNickname,
        type: 'manual' 
    });
  });
  
  // 3-2. (상대방)이 요청에 응답 (수락/거절)
  socket.on('respondToRequest', (data) => {
    const responderNickname = socketIdToNickname[socket.id];
    const requesterNickname = data.requesterNickname;
    const requester = players[requesterNickname];
    
    if (!responderNickname || !requester) return;

    if (data.accepted) {
        // 수락했다면, 요청자에게 "상대가 수락했으니 최종 확인해달라"고 알림
        io.to(requester.socketId).emit('opponentAccepted', {
            fromNickname: responderNickname,
            type: data.isAutoMatch ? 'auto' : 'manual',
            opponentAcceptedAt: new Date().toISOString() // 수락 시각을 함께 보냄
        });
    } else {
        // 거절했다면, 요청자에게 "상대가 거절했다"고 알림
        io.to(requester.socketId).emit('opponentDeclined', { 
            fromNickname: responderNickname,
            type: data.isAutoMatch ? 'auto' : 'manual'
        });
    }
  });

  // 3-3. (요청자)가 상대방의 수락에 대해 최종 확인
  socket.on('finalConfirmRequest', (data) => {
      const requesterNickname = socketIdToNickname[socket.id];
      const opponentNickname = data.opponentNickname;
      const opponent = players[opponentNickname];

      if(!requesterNickname || !opponent) return;

      if (data.confirmed) {
          // 최종 수락 시, 양쪽 모두에게 매치 성사 알림
          startBattle(requesterNickname, opponentNickname);
      } else {
          // 요청자가 최종 거절 시, 상대방에게도 거절 알림
          io.to(opponent.socketId).emit('opponentDeclined', {
              fromNickname: requesterNickname,
              type: 'manual' // 최종 단계는 항상 manual 타입으로 간주
          });
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

  // AFK (자리비움) 상태 처리
  socket.on('setAwayStatus', (isAway) => {
      const nickname = socketIdToNickname[socket.id];
      if (players[nickname]) {
          players[nickname].isAway = isAway;
          // AFK 상태가 되면 대결 준비 상태를 모두 해제
          if (isAway) {
              players[nickname].isReady = false;
              players[nickname].isAutoReady = false;
          }
          broadcastLobbyUpdate();

          // 만약 내가 AFK 상태가 되면서 진행 중이던 요청이 있었다면, 상대방에게 알려줌
          // (이 로직은 복잡하므로 우선순위를 낮춤. 현재는 연결 끊김으로 처리)
      }
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
        const battleId = Object.keys(gameRooms).find(id => gameRooms[id].players.some(p => p.nickname === nickname));
        if (battleId) {
            io.to(battleId).emit('opponentLeft');
            delete gameRooms[battleId];
        }
        delete players[nickname];
        delete socketIdToNickname[socket.id];
        broadcastLobbyUpdate();
    }
  });
});

// --- 헬퍼 함수들 ---

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
        outCounts: { [player1.nickname]: 0, [player2.nickname]: 0 },
        readyStates: { [player1.nickname]: false, [player2.nickname]: false },
    };
    
    console.log(`[Battle Start] ${player1.nickname} vs ${player2.nickname}. Battle ID: ${battleId}`);

    io.to(player1.socketId).emit('matchFound', { 
        battleId: battleId, 
        opponent: { nickname: player2.nickname, country: player2.country, advenLv: player2.advenLv },
        isPlayer1: true
    });
    io.to(player2.socketId).emit('matchFound', { 
        battleId: battleId, 
        opponent: { nickname: player1.nickname, country: player1.country, advenLv: player1.advenLv },
        isPlayer1: false
    });
    
    broadcastLobbyUpdate();
}

server.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});

