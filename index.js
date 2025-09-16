// 필요한 라이브러리들을 불러옵니다.
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
// Socket.IO 서버를 10001번 포트에서 실행합니다. Render가 자동으로 포트를 조정해줍니다.
const io = new Server(server, {
  cors: {
    origin: "*", // 모든 주소에서의 접속을 허용합니다 (테스트용). 실제 출시 시에는 앱 주소로 변경하는 것이 좋습니다.
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 10001;

// 게임 룸 상태를 관리하기 위한 객체
let gameRooms = {};

// 클라이언트가 서버에 접속했을 때의 처리를 정의합니다.
io.on('connection', (socket) => {
  console.log(`A user connected: ${socket.id}`);

  // 'joinRoom' 이벤트를 받으면 실행됩니다.
  socket.on('joinRoom', (battleId, nickname) => {
    socket.join(battleId);
    console.log(`${nickname} (${socket.id}) joined room: ${battleId}`);

    // 방이 없으면 새로 만듭니다.
    if (!gameRooms[battleId]) {
      gameRooms[battleId] = { players: {} };
    }
    gameRooms[battleId].players[socket.id] = { nickname };

    // 상대방에게 내가 접속했음을 알립니다.
    socket.to(battleId).emit('opponentJoined', nickname);
  });

  // 'sendGridData' 이벤트를 받으면, 같은 방의 상대방에게 그리드 데이터를 그대로 전달합니다.
  socket.on('sendGridData', (battleId, gridData) => {
    socket.to(battleId).emit('receiveGridData', gridData);
  });
  
  // 'sendAttack' 이벤트를 받으면, 상대방에게 공격 데이터를 전달합니다.
  socket.on('sendAttack', (battleId, attackData) => {
    socket.to(battleId).emit('receiveAttack', attackData);
  });

  // 'sendGameOver' 이벤트를 받으면, 상대방에게 게임 종료(승리)를 알립니다.
  socket.on('sendGameOver', (battleId) => {
      socket.to(battleId).emit('opponentLost');
  });


  // 클라이언트 접속이 끊어졌을 때의 처리를 정의합니다.
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // 플레이어가 속해있던 방을 찾아 상대방에게 접속이 끊어졌음을 알립니다.
    for (const battleId in gameRooms) {
      if (gameRooms[battleId].players[socket.id]) {
        const nickname = gameRooms[battleId].players[socket.id].nickname;
        socket.to(battleId).emit('opponentLeft', `${nickname} has left the game.`);
        delete gameRooms[battleId].players[socket.id];
        break;
      }
    }
  });
});

// 서버를 시작합니다.
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
