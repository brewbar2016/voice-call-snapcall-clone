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

const rooms = {};

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, user }) => {
    socket.join(roomId);
    user.id = socket.id;
    if (!rooms[roomId]) rooms[roomId] = [];
    rooms[roomId] = rooms[roomId].filter(u => u.id !== user.id); // на всякий
    rooms[roomId].push(user);

    io.to(roomId).emit("participants", rooms[roomId]);
    io.emit("active-rooms", Object.entries(rooms).map(([id, users]) => ({ id, users })));
  });

  socket.on("chat-message", msg => {
    io.to(msg.roomId).emit("chat-message", msg);
  });

  // --- SCREEN/VIDEO ---(оставь свои обработчики!)
  socket.on("request-screen-share", ({ to, from, roomId }) => {
    io.to(to).emit("request-screen-share", { from });
  });
  socket.on("screen-share-signal", ({ to, data }) => {
    io.to(to).emit("screen-share-signal", { from: socket.id, data });
  });
  socket.on("screen-share-stopped", ({ adminId }) => {
    io.to(adminId).emit("screen-share-stopped");
  });

  socket.on("request-video", ({ to, from, roomId }) => {
    io.to(to).emit("request-video", { from });
  });
  socket.on("video-signal", ({ to, data }) => {
    io.to(to).emit("video-signal", { from: socket.id, data });
  });
  socket.on("video-stopped", ({ adminId }) => {
    io.to(adminId).emit("video-stopped");
  });

  // --- Admin: закрытие комнаты
  socket.on("admin-close-room", ({ roomId }) => {
    if (rooms[roomId]) {
      io.to(roomId).emit("room-closed");
      delete rooms[roomId];
      io.emit("active-rooms", Object.entries(rooms).map(([id, users]) => ({ id, users })));
    }
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
      if (!rooms[roomId].length) delete rooms[roomId];
      io.to(roomId).emit("participants", rooms[roomId]);
    }
    io.emit("active-rooms", Object.entries(rooms).map(([id, users]) => ({ id, users })));
  });
});

app.use(express.static(path.join(__dirname, "build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

server.listen(5000, () => {
  console.log("Сервер запущен на http://localhost:5000");
});
