const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// --- In-memory Data Store ---
// NOTE: In a production environment, you might want to use Redis or another persistent store.
// For Render's free tier, in-memory is fine as the server restarts.
const players = {}; // key: nickname, value: player data
const socketIdToNickname = {}; // key: socket.id, value: nickname
const pendingRequests = {}; // Stores pending battle requests

// --- Auto-matchmaking Queue ---
const autoMatchQueue = new Set();


// === WebSocket Connection Logic ===
io.on('connection', (socket) => {
  console.log(`[Connection] User connected: ${socket.id}`);

  // --- 1. Registration & Lobby Management ---
  socket.on('register', (data) => {
    const { nickname } = data;
    if (!nickname) return;

    // Handle duplicate connections
    if (players[nickname] && players[nickname].socketId !== socket.id) {
      const oldSocketId = players[nickname].socketId;
      console.log(`[Duplicate] Disconnecting old session for ${nickname}`);
      io.to(oldSocketId).emit('force_logout', { event: 'force_logout', data: {}});
      io.sockets.sockets.get(oldSocketId)?.disconnect();
    }
    
    socketIdToNickname[socket.id] = nickname;
    players[nickname] = {
      ...(players[nickname] || {}), // Preserve old data if exists
      socketId: socket.id,
      nickname: nickname,
      isAway: false,
    };
    console.log(`[Register] '${nickname}' registered with socket ${socket.id}`);
  });

  socket.on('enterLobby', (data) => {
    const nickname = socketIdToNickname[socket.id];
    if (!players[nickname]) return;

    socket.join('lobby');
    players[nickname] = {
        ...players[nickname],
        country: data.country,
        advenLv: data.advenLv,
        isReady: data.isReady,
        isAutoReady: data.isAutoReady,
        inBattle: false,
        isAway: false,
    };
    console.log(`[Lobby] ${nickname} entered.`);
    broadcastLobbyUpdate();
  });
  
  socket.on('leaveLobby', () => {
     const nickname = socketIdToNickname[socket.id];
     if (players[nickname]) {
         socket.leave('lobby');
         console.log(`[Lobby] ${nickname} left.`);
         // Don't delete player data, just update status
         players[nickname].isReady = false;
         players[nickname].isAutoReady = false;
         broadcastLobbyUpdate();
     }
  });

  socket.on('toggleReady', (data) => {
    const nickname = socketIdToNickname[socket.id];
    if (players[nickname]) {
      players[nickname].isReady = data.isReady;
      broadcastLobbyUpdate();
    }
  });

  socket.on('toggleAutoReady', (data) => {
    const nickname = socketIdToNickname[socket.id];
    if (players[nickname]) {
      players[nickname].isAutoReady = data.isAutoReady;
      if (data.isAutoReady) {
        autoMatchQueue.add(nickname);
      } else {
        autoMatchQueue.delete(nickname);
      }
      broadcastLobbyUpdate();
      processAutoMatchQueue();
    }
  });
  
  socket.on('setAwayStatus', (data) => {
      const nickname = socketIdToNickname[socket.id];
      if (players[nickname]) {
          players[nickname].isAway = data.isAway;
          if (data.isAway) {
              players[nickname].isReady = false;
              players[nickname].isAutoReady = false;
              autoMatchQueue.delete(nickname);
          }
          broadcastLobbyUpdate();
      }
  });

  // --- 2. Matchmaking Logic ---

  socket.on('sendRequest', (data) => {
    const requesterNick = socketIdToNickname[socket.id];
    const targetNick = data.to;
    const target = players[targetNick];

    if (!requesterNick || !target || target.isAway || target.inBattle) {
      socket.emit('request_cancelled', { event: 'request_cancelled', data: { from: targetNick } });
      return;
    }

    const requestId = uuidv4();
    pendingRequests[requestId] = {
        from: requesterNick,
        to: targetNick,
        status: 'pending_opponent',
        type: data.type
    };
    
    // Send request to the target player
    io.to(target.socketId).emit('incoming_request', { event: 'incoming_request', data: { from: requesterNick, type: data.type, requestId: requestId }});
  });

  socket.on('respondToRequest', (data) => {
    const responderNick = socketIdToNickname[socket.id];
    const requesterNick = data.from;
    const requester = players[requesterNick];
    
    if (!requester) return;

    if (data.accepted) {
        // Notify requester that opponent accepted, waiting for final confirmation
        io.to(requester.socketId).emit('opponent_accepted', { event: 'opponent_accepted', data: { from: responderNick, type: 'manual' }});
    } else {
        io.to(requester.socketId).emit('opponent_declined', { event: 'opponent_declined', data: { from: responderNick, type: 'manual' }});
    }
  });

  socket.on('finalConfirm', (data) => {
      const requesterNick = socketIdToNickname[socket.id];
      const responderNick = data.to;
      const responder = players[responderNick];

      if (!requesterNick || !responder) return;

      if (data.confirmed) {
          startBattle(requesterNick, responderNick);
      } else {
          io.to(responder.socketId).emit('opponent_declined', { event: 'opponent_declined', data: { from: requesterNick, type: 'manual' }});
      }
  });


  // --- 3. Disconnect Handling ---
  socket.on('disconnect', () => {
    console.log(`[Disconnection] User disconnected: ${socket.id}`);
    const nickname = socketIdToNickname[socket.id];
    if (nickname) {
        // Clean up any pending requests involving this user
        Object.keys(pendingRequests).forEach(id => {
            const request = pendingRequests[id];
            if (request.from === nickname || request.to === nickname) {
                 const otherPlayerNick = request.from === nickname ? request.to : request.from;
                 const otherPlayer = players[otherPlayerNick];
                 if(otherPlayer) {
                    io.to(otherPlayer.socketId).emit('request_cancelled', { event: 'request_cancelled', data: { from: nickname } });
                 }
                 delete pendingRequests[id];
            }
        });
        
        autoMatchQueue.delete(nickname);
        delete players[nickname];
        delete socketIdToNickname[socket.id];
        broadcastLobbyUpdate();
    }
  });
});


// === HTTP API Endpoints ===
app.use(express.json());

// Simple health check
app.get('/', (req, res) => {
  res.send({ status: 'Server is running', playerCount: Object.keys(players).length });
});

// Get user stats (replace with your actual database call)
app.get('/stats/:nickname', (req, res) => {
    const { nickname } = req.params;
    // This is a mock. You should fetch this data from your Firestore/DB.
    console.log(`[API] Stats requested for ${nickname}`);
    res.status(200).send({
        bestPlayedRecords: {
            block_w_stage: {
                block_stage: players[nickname]?.advenLv || 0,
                timeRecord: "00:00:00"
            }
        }
    });
});


// === Helper Functions ===

function broadcastLobbyUpdate() {
  const lobbyPlayers = Object.values(players)
    .filter(p => p.socketId && io.sockets.sockets.get(p.socketId)) // Ensure player is connected
    .map(({ socketId, ...rest }) => rest); // Don't send socketId to clients

  io.to('lobby').emit('lobby_update', { event: 'lobby_update', data: lobbyPlayers });
}

function startBattle(player1Nick, player2Nick) {
    const player1 = players[player1Nick];
    const player2 = players[player2Nick];

    if (!player1 || !player2) return;

    const battleId = `battle_${uuidv4()}`;
    player1.inBattle = true;
    player2.inBattle = true;
    autoMatchQueue.delete(player1Nick);
    autoMatchQueue.delete(player2Nick);

    console.log(`[Battle] Match found: ${player1Nick} vs ${player2Nick}. ID: ${battleId}`);
    
    const matchData = {
        event: 'match_found',
        data: {
            battleId: battleId,
            player1: player1Nick,
            player2: player2Nick,
        }
    };

    io.to(player1.socketId).to(player2.socketId).emit('match_found', matchData);
    
    // Update lobby for everyone else
    broadcastLobbyUpdate();
}

function processAutoMatchQueue() {
    while (autoMatchQueue.size >= 2) {
        const playersToMatch = Array.from(autoMatchQueue).slice(0, 2);
        const [player1Nick, player2Nick] = playersToMatch;

        // Remove from queue
        autoMatchQueue.delete(player1Nick);
        autoMatchQueue.delete(player2Nick);

        startBattle(player1Nick, player2Nick);
    }
}


server.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});