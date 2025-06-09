const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");
const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- Память комнат и участников ---
const rooms = {};

// --- Список активных комнат для админ-панели ---
function getActiveRooms() {
  return Object.entries(rooms).map(([id, users]) => ({
    id,
    users
  }));
}

io.on("connection", (socket) => {
  // --- Вход в комнату ---
  socket.on("join-room", ({ roomId, user }) => {
    socket.join(roomId);
    user.id = socket.id;
    socket.roomId = roomId;
    user.socketId = socket.id;

    if (!rooms[roomId]) rooms[roomId] = [];
    // Обновляем если уже есть этот пользователь
    const idx = rooms[roomId].findIndex(u => u.id === socket.id);
    if (idx === -1) {
      rooms[roomId].push(user);
    } else {
      rooms[roomId][idx] = user;
    }

    io.to(roomId).emit("participants", rooms[roomId]);
    io.emit("active-rooms", getActiveRooms());
  });

  // --- Чат ---
  socket.on("chat-message", ({ roomId, user, text }) => {
    io.to(roomId).emit("chat-message", { user, text });
  });

  // --- Screen share ---
  socket.on("request-screen-share", ({ roomId, from, to }) => {
    io.to(to).emit("request-screen-share", { from });
  });
  socket.on("screen-share-signal", ({ to, data }) => {
    io.to(to).emit("screen-share-signal", { from: socket.id, data });
  });
  socket.on("screen-share-stopped", ({ adminId }) => {
    io.to(adminId).emit("screen-share-stopped");
  });

  // --- Video ---
  socket.on("request-video", ({ roomId, from, to }) => {
    io.to(to).emit("request-video", { from });
  });
  socket.on("video-signal", ({ to, data }) => {
    io.to(to).emit("video-signal", { from: socket.id, data });
  });
  socket.on("video-stopped", ({ adminId }) => {
    io.to(adminId).emit("video-stopped");
  });

  // --- Audio (user→admin) ---
  socket.on("audio-signal", ({ to, data }) => {
    io.to(to).emit("audio-signal", { from: socket.id, data });
  });

  // --- Audio (admin→user) ---
  socket.on("admin-audio-signal", ({ to, data }) => {
    io.to(to).emit("admin-audio-signal", { from: socket.id, data });
  });

  // --- Завершение комнаты админом ---
  socket.on("admin-close-room", ({ roomId }) => {
    if (rooms[roomId]) {
      // Оповещаем всех
      io.to(roomId).emit("room-closed");
      // Чистим память
      delete rooms[roomId];
      io.emit("active-rooms", getActiveRooms());
    }
  });

  // --- Отключение пользователя ---
  socket.on("disconnect", () => {
    const { roomId } = socket;
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
      io.to(roomId).emit("participants", rooms[roomId]);
      // Если комната пуста — удаляем
      if (rooms[roomId].length === 0) delete rooms[roomId];
      io.emit("active-rooms", getActiveRooms());
    }
  });
});
  app.use(express.static(path.join(__dirname, "build")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "build", "index.html"));
  });  
server.listen(5000, () => {
  console.log("Сервер запущен на http://localhost:5000");
});
