// 필요한 라이브러리들을 불러옵니다.
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { v4: uuidv4 } = require('uuid'); // 고유 ID 생성을 위한 라이브_러리

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
  console.log(`[Connection] New client connected: ${socket.id}`);

  // 클라이언트가 자신의 닉네임을 등록 (기존 앱의 비밀번호 인증은 생략)
  socket.on('register', (nickname) => {
    if (!nickname) return;

    // 다른 소켓에서 이미 사용 중인 닉네임인 경우 (중복 로그인 처리)
    if (players[nickname] && players[nickname].socketId && players[nickname].socketId !== socket.id) {
      const oldSocketId = players[nickname].socketId;
      console.log(`[Login] Duplicate login for ${nickname}. Disconnecting old session: ${oldSocketId}`);
      io.to(oldSocketId).emit('force_logout'); // 기존 클라이언트에게 접속 해제 신호 전송
    }

    console.log(`[Register] Client ${socket.id} is registered as ${nickname}`);
    socketIdToNickname[socket.id] = nickname;
    players[nickname] = { ...(players[nickname] || {}), socketId: socket.id }; // 기존 정보가 있다면 유지하고 socketId만 갱신
  });

  // --- 대기실(Lobby) 관련 로직 ---
  socket.on('enterLobby', (playerInfo) => {
    const nickname = playerInfo.nickname;
    if (!nickname || !players[nickname]) return;

    console.log(`[Lobby Enter] ${nickname}(${socket.id}) entered with info:`, playerInfo);
    players[nickname] = {
      ...playerInfo,
      socketId: socket.id,
      inBattle: false,
    };
    socket.join('lobby'); // 모든 로비 유저를 'lobby' 룸에 참가시킴
    broadcastLobbyUpdate();
  });

  socket.on('leaveLobby', () => {
    // 게임방으로 이동하기 직전에 클라이언트가 호출. 로비 업데이트에서 제외됨.
    const nickname = socketIdToNickname[socket.id];
    if (nickname) {
        socket.leave('lobby');
        console.log(`[Lobby Leave] ${nickname} left the lobby to join a game.`);
    }
  });


  // --- 준비 상태 변경 ---
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

  // --- 대결 신청 (수동/자동) ---
  const handleRequest = (requesterNickname, targetNickname, isAutoMatch) => {
    if (!requesterNickname || !targetNickname || !players[requesterNickname] || !players[targetNickname]) {
      return;
    }
    if (players[targetNickname].inBattle) {
       socket.emit('requestFailed', { reason: `${targetNickname} is already in a match.` });
       return;
    }

    const targetSocketId = players[targetNickname].socketId;
    const requestType = isAutoMatch ? 'incomingAutoMatchRequest' : 'incomingManualRequest';

    console.log(`[Request][${isAutoMatch ? 'Auto' : 'Manual'}] ${requesterNickname} -> ${targetNickname}`);
    io.to(targetSocketId).emit(requestType, {
      fromNickname: requesterNickname,
    });
  };
  
  // 수동 신청
  socket.on('sendManualRequest', (data) => {
    const requesterNickname = socketIdToNickname[socket.id];
    handleRequest(requesterNickname, data.opponentNickname, false);
  });
  
  // 자동 신청 (클라이언트의 _findAutoMatch 로직에 의해 호출됨)
  socket.on('sendAutoMatchRequest', (data) => {
    const requesterNickname = socketIdToNickname[socket.id];
    handleRequest(requesterNickname, data.opponentNickname, true);
  });
  
  // 대결 신청에 대한 응답
  socket.on('respondToRequest', (data) => {
    const { requesterNickname, accepted, isAutoMatch } = data;
    const responderNickname = socketIdToNickname[socket.id];

    if (!players[requesterNickname] || !players[responderNickname]) return;

    const requesterSocketId = players[requesterNickname].socketId;

    if (accepted) {
      console.log(`[Request] ${responderNickname} accepted request from ${requesterNickname}.`);
      startBattle(requesterNickname, responderNickname);
    } else {
      console.log(`[Request] ${responderNickname} declined request from ${requesterNickname}.`);
      const declineEvent = isAutoMatch ? 'autoMatchRequestDeclined' : 'manualRequestDeclined';
      io.to(requesterSocketId).emit(declineEvent, { fromNickname: responderNickname });
    }
  });


  // --- 게임 플레이 중 데이터 중계 로직 ---
  socket.on('joinRoom', (battleId) => {
    if(!battleId) return;
    socket.join(battleId);
    const nickname = socketIdToNickname[socket.id];
    console.log(`[Game Join] ${nickname} joined room: ${battleId}`);
  });

  socket.on('playerReadyForStart', (data) => {
    const { battleId } = data;
    const room = gameRooms[battleId];
    const nickname = socketIdToNickname[socket.id];
    if (!room || !nickname) return;

    room.readyStates[nickname] = true;
    
    // 두 명 모두 준비되었는지 확인
    if (Object.values(room.readyStates).every(state => state === true)) {
        console.log(`[Game Ready] Both players ready. Starting battle ${battleId}`);
        io.to(battleId).emit('gameStart');
    }
  });

  socket.on('sendGridData', (data) => {
    if(!data || !data.battleId || data.gridData === undefined) return;
    socket.to(data.battleId).emit('opponentGridUpdate', data.gridData);
  });

  socket.on('sendAttack', (data) => {
    if(!data || !data.battleId || !data.attackData) return;
    socket.to(data.battleId).emit('incomingAttack', data.attackData);
  });
  
  // 패배 선언
  socket.on('declareDefeat', (data) => {
    if(!data || !data.battleId) return;
    const loserNickname = socketIdToNickname[socket.id];
    const room = gameRooms[data.battleId];
    if(!room) return;

    const winner = room.players.find(p => p.nickname !== loserNickname);
    console.log(`[Game Over] ${loserNickname} lost. Winner is ${winner?.nickname}.`);
    io.to(data.battleId).emit('gameOver', { winner: winner?.nickname, loser: loserNickname });
  });

  // 자리비움(AFK) 처리
  socket.on('setAwayStatus', (data) => {
    const { battleId, isAway } = data;
    socket.to(battleId).emit('opponentAwayStatus', { isAway: isAway });
  });

  // KO 발생 (클라이언트가 카운트다운 후 서버에 보고)
  socket.on('reportKO', (data) => {
      const { battleId, opponentNickname } = data; // KO 당한 상대 닉네임
      const room = gameRooms[battleId];
      if (!room) return;

      room.outCounts[opponentNickname]++;
      console.log(`[KO Report] ${opponentNickname} timed out. Out count: ${room.outCounts[opponentNickname]}`);
      io.to(battleId).emit('updateOutCount', room.outCounts);

      if (room.outCounts[opponentNickname] >= 3) {
          const winnerNickname = socketIdToNickname[socket.id];
          console.log(`[KO Game Over] ${opponentNickname} is KO'd. Winner is ${winnerNickname}.`);
          io.to(battleId).emit('gameOver', { winner: winnerNickname, loser: opponentNickname, reason: 'KO' });
          delete gameRooms[battleId];
      }
  });


  // --- 재대결 로직 ---
  socket.on('requestRematch', (data) => {
    const { battleId } = data;
    const room = gameRooms[battleId];
    const nickname = socketIdToNickname[socket.id];
    if (!room || !nickname) return;

    room.rematchState[nickname] = 'requested';
    console.log(`[Rematch] ${nickname} requested a rematch in room ${battleId}.`);
    socket.to(battleId).emit('rematchRequested');
  });
  
  socket.on('answerRematch', (data) => {
      const { battleId, accepted } = data;
      const nickname = socketIdToNickname[socket.id];
      const room = gameRooms[battleId];
      if (!room || !nickname) return;
      
      if(accepted){
          room.rematchState[nickname] = 'accepted';
          socket.to(battleId).emit('rematchAccepted');

          const allReady = Object.values(room.rematchState).every(state => state === 'requested' || state === 'accepted');
          if (allReady) {
              console.log(`[Rematch] Both players agreed. Starting rematch in room ${battleId}.`);
              
              // 재대결 상태 초기화
              Object.keys(room.rematchState).forEach(nick => room.rematchState[nick] = 'none');
              Object.keys(room.outCounts).forEach(nick => room.outCounts[nick] = 0);
              Object.keys(room.readyStates).forEach(nick => room.readyStates[nick] = false);

              io.to(battleId).emit('startRematch');
          }
      } else {
          socket.to(battleId).emit('rematchDeclined');
          // 한 명이라도 거절하면 재대결 상태 초기화
          Object.keys(room.rematchState).forEach(nick => room.rematchState[nick] = 'none');
      }
  });

  socket.on('playerReadyForRematch', (data) => {
    const { battleId } = data;
    const room = gameRooms[battleId];
    const nickname = socketIdToNickname[socket.id];
    if (!room || !nickname) return;

    room.readyStates[nickname] = true;

    if (Object.values(room.readyStates).every(state => state === true)) {
        console.log(`[Rematch Ready] Both players ready. Starting rematch battle ${battleId}`);
        io.to(battleId).emit('gameStart');
    }
  });


  // --- 접속 해제 처리 ---
  socket.on('disconnect', () => {
    const disconnectedNickname = socketIdToNickname[socket.id];
    console.log(`[Disconnect] Client ${disconnectedNickname}(${socket.id}) disconnected.`);

    if (disconnectedNickname && players[disconnectedNickname]) {
      // 게임 중이었는지 확인
      const battleId = Object.keys(gameRooms).find(id => gameRooms[id].players.some(p => p.nickname === disconnectedNickname));
      if (battleId) {
        const room = gameRooms[battleId];
        console.log(`[Disconnect] ${disconnectedNickname} left match ${battleId}. Notifying opponent.`);
        socket.to(battleId).emit('opponentLeft');
        delete gameRooms[battleId];
      }
      
      delete players[disconnectedNickname];
      delete socketIdToNickname[socket.id];
      
      broadcastLobbyUpdate();
    }
  });
});

// --- 헬퍼 함수들 ---

function broadcastLobbyUpdate() {
  const lobbyPlayers = Object.values(players).filter(p => p.socketId && !p.inBattle).map(p => ({
    nickname: p.nickname,
    country: p.country,
    advenLv: p.advenLv,
    isReady: p.isReady,
    isAutoReady: p.isAutoReady,
    inBattle: p.inBattle,
  }));
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
