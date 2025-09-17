// 필요한 라이브러리들을 불러옵니다.
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

// 서버의 기본 설정을 합니다.
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // 모든 주소에서의 접속을 허용합니다.
    methods: ["GET", "POST"]
  },
  // 클라이언트와의 연결이 끊어졌는지 더 빨리 감지하기 위한 설정
  pingInterval: 10000, // 10초마다 ping 전송
  pingTimeout: 5000,   // 5초안에 pong 응답이 없으면 연결 끊김으로 간주
});

const PORT = process.env.PORT || 3000; // Render가 지정하는 포트 또는 3000번 포트를 사용합니다.

// --- 서버 메모리에 저장될 데이터들 ---

// 1. 플레이어 정보 및 상태 저장소
// key: 닉네임(nickname), value: 플레이어 정보 객체
// { socketId, country, advenLv, isReady, isAutoReady, inBattle, isAway }
const players = {};

// 2. 현재 진행중인 게임방 정보
// key: battleId, value: { players: { nickname1: socketId1, nickname2: socketId2 }, rematchState: { nickname1: 'none', nickname2: 'none' } }
const gameRooms = {};


// --- 클라이언트가 접속했을 때 처리할 로직 ---
io.on('connection', (socket) => {
  console.log(`[Connection] New client connected: ${socket.id}`);

  // 클라이언트로부터 자신의 닉네임을 받아서 서버에 등록
  socket.on('register', (nickname) => {
    // 중복 로그인 처리: 이미 같은 닉네임의 유저가 있다면 이전 소켓 연결을 끊고, 새 연결로 교체
    if (players[nickname] && players[nickname].socketId) {
      const oldSocketId = players[nickname].socketId;
      console.log(`[Login] Duplicate login for ${nickname}. Disconnecting old session (${oldSocketId}).`);
      io.to(oldSocketId).emit('force_logout');
      io.sockets.sockets.get(oldSocketId)?.disconnect(true);
    }
    
    // 소켓에 닉네임 정보를 저장하여, 연결이 끊어졌을 때 어떤 유저였는지 알 수 있도록 함
    socket.nickname = nickname;
    console.log(`[Register] Socket ${socket.id} is registered as ${nickname}.`);
  });


  // --- 로비 관련 로직 ---
  socket.on('enterLobby', (playerInfo) => {
    if (!socket.nickname || !playerInfo || playerInfo.nickname !== socket.nickname) {
        console.log(`[Lobby Denied] Nickname mismatch or missing info for socket ${socket.id}.`);
        return;
    }

    const nickname = socket.nickname;
    console.log(`[Lobby Enter] ${nickname}(${socket.id}) entered lobby with info:`, playerInfo);
    
    // 플레이어 정보 업데이트 (isAway 상태는 false로 초기화)
    players[nickname] = {
      ...playerInfo,
      socketId: socket.id,
      isAway: false // 로비에 들어오면 AFK 상태 해제
    };
    
    // 현재 소켓을 'lobby' 룸에 참가시킴
    socket.join('lobby');
    
    // 로비에 있는 모든 클라이언트에게 최신 플레이어 목록을 보내줍니다.
    broadcastLobbyUpdate();
  });

  socket.on('leaveLobby', () => {
    if (!socket.nickname) return;
    socket.leave('lobby');
    console.log(`[Lobby Leave] ${socket.nickname} left lobby.`);
  });
  
  // 준비 상태 변경
  socket.on('toggleReady', (isReady) => {
    if (!socket.nickname || !players[socket.nickname]) return;
    players[socket.nickname].isReady = isReady;
    console.log(`[Lobby] ${socket.nickname} ready status: ${isReady}`);
    broadcastLobbyUpdate();
  });

  // 자동 준비 상태 변경
  socket.on('toggleAutoReady', (isAutoReady) => {
    if (!socket.nickname || !players[socket.nickname]) return;
    players[socket.nickname].isAutoReady = isAutoReady;
    console.log(`[Lobby] ${socket.nickname} auto-ready status: ${isAutoReady}`);

    // 자동 매칭 시작/취소 로직
    if(isAutoReady) {
        findAutoMatchFor(socket.nickname);
    }
    broadcastLobbyUpdate();
  });


  // --- 수동 대결 관련 로직 ---
  socket.on('sendBattleRequest', (data) => {
    const fromNickname = socket.nickname;
    const toNickname = data.opponentNickname;

    if (!fromNickname || !toNickname || !players[fromNickname] || !players[toNickname]) {
      socket.emit('requestFailed', { reason: 'Player not found.' });
      return;
    }
    
    const opponent = players[toNickname];
    if (opponent.inBattle || opponent.isAway) {
      socket.emit('requestFailed', { reason: `${toNickname} is not available right now.` });
      return;
    }

    console.log(`[Manual Request] ${fromNickname} -> ${toNickname}`);
    io.to(opponent.socketId).emit('incomingBattleRequest', {
        fromNickname: fromNickname,
        fromCountry: players[fromNickname].country,
        fromAdvenLv: players[fromNickname].advenLv
    });
    socket.emit('requestSent', { toNickname });
  });

  socket.on('respondToBattleRequest', (data) => {
    const responderNickname = socket.nickname;
    const requesterNickname = data.requesterNickname;
    
    if (!responderNickname || !requesterNickname || !players[responderNickname] || !players[requesterNickname]) return;
    
    const requesterSocketId = players[requesterNickname].socketId;

    if (data.accepted) {
        console.log(`[Manual Request] ${responderNickname} accepted request from ${requesterNickname}.`);
        // 양쪽 다 준비되었는지 한번 더 확인
        if (players[requesterNickname] && !players[requesterNickname].inBattle && players[responderNickname] && !players[responderNickname].inBattle) {
            startBattle(requesterNickname, responderNickname);
        } else {
            // 한쪽이 이미 게임에 들어간 경우
            socket.emit('requestFailed', { reason: 'Match could not be started.' });
            io.to(requesterSocketId).emit('requestFailed', { reason: 'Match could not be started.' });
        }
    } else {
        console.log(`[Manual Request] ${responderNickname} declined request from ${requesterNickname}.`);
        io.to(requesterSocketId).emit('requestDeclined', { fromNickname: responderNickname });
    }
  });


  // --- 게임 플레이 중 데이터 중계 로직 ---
  socket.on('joinRoom', (battleId) => {
    socket.join(battleId);
    console.log(`[Game Join] ${socket.nickname} joined room: ${battleId}`);
  });

  socket.on('sendGridData', (data) => {
    // battleId로만 전송하고, 보낸 사람은 제외 (socket.to)
    socket.to(data.battleId).emit('receiveGridData', data.gridData);
  });

  socket.on('sendAttack', (data) => {
    socket.to(data.battleId).emit('receiveAttack', data.attackData);
  });
  
  socket.on('sendGameIsFinished', (data) => {
    // 승패 여부(won)와 함께 전송
    socket.to(data.battleId).emit('receiveGameIsFinished', { won: data.won });
  });

  socket.on('setAwayStatus', (data) => {
    if (!socket.nickname || !players[socket.nickname]) return;
    players[socket.nickname].isAway = data.isAway;
    // 상대방에게만 나의 away 상태를 알림
    if (data.battleId) {
        socket.to(data.battleId).emit('opponentAwayStatus', { isAway: data.isAway });
    }
  });

  // --- 재대결 로직 ---
  socket.on('requestRematch', (data) => {
    const battleId = data.battleId;
    const room = gameRooms[battleId];
    if (!room || !socket.nickname) return;

    room.rematchState[socket.nickname] = 'requested';
    
    const opponentNickname = Object.keys(room.players).find(nick => nick !== socket.nickname);
    if(opponentNickname && players[opponentNickname]) {
        io.to(players[opponentNickname].socketId).emit('rematchRequested');
    }

    // 두명 모두 요청했는지 확인
    if (Object.values(room.rematchState).every(state => state === 'requested')) {
        console.log(`[Rematch] Both players agreed. Starting rematch in room ${battleId}.`);
        io.to(battleId).emit('startRematch');
        // 재대결 상태 초기화
        Object.keys(room.rematchState).forEach(nick => room.rematchState[nick] = 'none');
    }
  });
  
  socket.on('answerRematch', (data) => {
      const battleId = data.battleId;
      const room = gameRooms[battleId];
      if (!room || !socket.nickname) return;

      const opponentNickname = Object.keys(room.players).find(nick => nick !== socket.nickname);
      if(!opponentNickname || !players[opponentNickname]) return;
      
      const opponentSocketId = players[opponentNickname].socketId;

      if(data.accepted) {
        room.rematchState[socket.nickname] = 'accepted'; // accepted 상태로 변경 (클라이언트 요청에 따라)

        // 상대가 이미 요청한 상태인지 확인
        if (room.rematchState[opponentNickname] === 'requested') {
             console.log(`[Rematch] ${socket.nickname} accepted. Starting rematch in room ${battleId}.`);
             io.to(battleId).emit('startRematch');
             Object.keys(room.rematchState).forEach(nick => room.rematchState[nick] = 'none');
        } else {
            // 상대가 아직 요청하지 않았으므로, 내가 수락했다는 사실만 알림
            io.to(opponentSocketId).emit('rematchAccepted');
        }
      } else {
        // 거절했을 때
        io.to(opponentSocketId).emit('rematchDeclined');
      }
  });

  // --- 접속 해제 처리 ---
  socket.on('disconnect', (reason) => {
    const nickname = socket.nickname;
    console.log(`[Disconnect] Client ${nickname}(${socket.id}) disconnected. Reason: ${reason}`);

    if (nickname && players[nickname]) {
      // 진행중인 게임이 있었는지 확인
      const battleId = Object.keys(gameRooms).find(id => gameRooms[id].players[nickname]);
      if (battleId) {
        const room = gameRooms[battleId];
        const opponentNickname = Object.keys(room.players).find(nick => nick !== nickname);

        if (opponentNickname && players[opponentNickname]) {
          // 상대방에게 내가 나갔음을 알림
          io.to(players[opponentNickname].socketId).emit('opponentLeft');
        }
        // 게임방 삭제
        delete gameRooms[battleId];
        console.log(`[Game Room] Room ${battleId} closed due to disconnect.`);
      }
      
      // 플레이어 목록에서 제거
      delete players[nickname];
      
      // 로비에 변경사항 전파
      broadcastLobbyUpdate();
    }
  });
});

// --- 헬퍼 함수들 ---

// 로비에 있는 모든 플레이어에게 현재 로비 상태를 전송
function broadcastLobbyUpdate() {
  // 클라이언트가 기대하는 데이터 형식에 맞추어 가공
  // isReady, inBattle, isAway 등의 상태를 포함하여 전송
  const lobbyPlayers = Object.values(players)
    .filter(p => p.socketId && io.sockets.sockets.get(p.socketId)?.rooms.has('lobby')) // 로비 룸에 있는 사람만 필터링
    .map(p => ({
        nickname: p.nickname,
        country: p.country,
        isReady: p.isReady || false,
        isAutoReady: p.isAutoReady || false,
        inBattle: p.inBattle || false,
        isAway: p.isAway || false,
        advenLv: p.advenLv || 0
    }));

  io.to('lobby').emit('lobbyUpdate', lobbyPlayers);
  console.log(`[Lobby Update] Broadcasting info of ${lobbyPlayers.length} player(s) to lobby.`);
}

// 자동 매칭 로직
function findAutoMatchFor(nickname) {
    const me = players[nickname];
    if (!me || !me.isAutoReady || me.inBattle) return;

    // 나를 제외하고, 자동매칭을 원하며, 게임중이 아닌 다른 플레이어를 찾음
    const opponentNickname = Object.keys(players).find(nick => 
        nick !== nickname &&
        players[nick].isAutoReady &&
        !players[nick].inBattle
    );
    
    if (opponentNickname) {
        console.log(`[Auto Match] Found a match: ${nickname} vs ${opponentNickname}`);
        // 두 플레이어의 자동 매칭 상태를 해제
        players[nickname].isAutoReady = false;
        players[opponentNickname].isAutoReady = false;
        startBattle(nickname, opponentNickname);
    }
}

// 배틀 시작 함수
function startBattle(nickname1, nickname2) {
    const player1 = players[nickname1];
    const player2 = players[nickname2];

    if (!player1 || !player2 || player1.inBattle || player2.inBattle) {
        console.log(`[Battle Start Failed] One of the players is not available.`);
        return;
    }

    const battleId = `battle_${nickname1}_vs_${nickname2}_${Date.now()}`;
    
    // 플레이어 상태를 '게임 중'으로 변경
    player1.inBattle = true;
    player2.inBattle = true;
    player1.isReady = false;
    player2.isReady = false;

    // 게임방 생성
    gameRooms[battleId] = {
      players: { [nickname1]: player1.socketId, [nickname2]: player2.socketId },
      rematchState: { [nickname1]: 'none', [nickname2]: 'none' }
    };
    
    console.log(`[Battle Start] ${nickname1} vs ${nickname2}. Battle ID: ${battleId}`);

    // 각 플레이어에게 매칭 성공 이벤트 전송
    // 클라이언트가 기대하는 opponent 객체 형식에 맞춰 전송
    io.to(player1.socketId).emit('matchFound', { 
        battleId: battleId, 
        opponent: {
            nickname: player2.nickname, 
            country: player2.country
        },
        isPlayer1: true // 내가 플레이어1임을 알려줌
    });
    io.to(player2.socketId).emit('matchFound', { 
        battleId: battleId, 
        opponent: {
            nickname: player1.nickname, 
            country: player1.country
        },
        isPlayer1: false // 내가 플레이어2임을 알려줌
    });
    
    // 로비에 있는 모든 유저에게 상태 변경 알림
    broadcastLobbyUpdate();
}

server.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
