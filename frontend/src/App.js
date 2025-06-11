import React, { useState, useRef, useEffect } from "react";
import io from "socket.io-client";
import SimplePeer from "simple-peer";

const SOCKET_URL = "https://backend-ccs4.onrender.com";
const AVATARS = ["😀", "🦁", "🐼", "🦊", "🐸", "🐨"];

function App() {
  // --- Состояния ---
  const [step, setStep] = useState("login");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [role, setRole] = useState("user");
  const [roomId, setRoomId] = useState("");
  const [participants, setParticipants] = useState([]);
  const [chat, setChat] = useState([]);
  const [message, setMessage] = useState("");
  const [activeRooms, setActiveRooms] = useState([]);
  const [showScreenRequest, setShowScreenRequest] = useState(null);
  const [showVideoRequest, setShowVideoRequest] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [videoStream, setVideoStream] = useState(null);
  const [sharingUserId, setSharingUserId] = useState(null);
  const [sharingVideoUserId, setSharingVideoUserId] = useState(null);

  // --- Audio
  const audioPeers = useRef({});
  const [audioStreams, setAudioStreams] = useState({});
  const [adminMicStream, setAdminMicStream] = useState(null);
  const [adminMicEnabled, setAdminMicEnabled] = useState(false);
  const adminAudioPeer = useRef(null);

  const socketRef = useRef();
  const screenPeerRef = useRef();
  const videoPeerRef = useRef();
  const screenVideoRef = useRef();
  const cameraVideoRef = useRef();

  // --- socket.io events ---
  useEffect(() => {
    socketRef.current = io(SOCKET_URL, { transports: ["websocket"] });

    socketRef.current.on("participants", setParticipants);
    socketRef.current.on("chat-message", msg => setChat(prev => [...prev, msg]));
    socketRef.current.on("active-rooms", setActiveRooms);

    // Screen
    socketRef.current.on("request-screen-share", ({ from }) => setShowScreenRequest({ from }));
    socketRef.current.on("screen-share-signal", async ({ from, data }) => {
      if (screenPeerRef.current) await screenPeerRef.current.signal(data);
    });
    socketRef.current.on("screen-share-stopped", () => {
      setScreenStream(null);
      screenPeerRef.current = null;
      setSharingUserId(null);
    });

    // Video
    socketRef.current.on("request-video", ({ from }) => setShowVideoRequest({ from }));
    socketRef.current.on("video-signal", async ({ from, data }) => {
      if (videoPeerRef.current) await videoPeerRef.current.signal(data);
    });
    socketRef.current.on("video-stopped", () => {
      setVideoStream(null);
      videoPeerRef.current = null;
      setSharingVideoUserId(null);
    });

    // Audio
    socketRef.current.on("audio-signal", async ({ from, data }) => {
      if (audioPeers.current[from]) await audioPeers.current[from].signal(data);
    });

    // Получать поток микрофона админа
    socketRef.current.on("admin-audio-signal", async ({ from, data }) => {
      if (adminAudioPeer.current) await adminAudioPeer.current.signal(data);
    });

    socketRef.current.on("room-closed", () => {
      alert("Сеанс завершён администратором!");
      window.location.reload();
    });

    return () => { if (socketRef.current) socketRef.current.disconnect(); };
  }, []);

  // --- Запрашиваем микрофон при входе в комнату ---
  useEffect(() => {
    if (step !== "room") return;

    if (role === "user") {
      const myId = socketRef.current?.id || "self";
      if (!audioStreams[myId]) {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
          setAudioStreams(s => ({ ...s, [myId]: stream }));
        }).catch(() => {
          alert("Разрешите доступ к микрофону для голосовой связи!");
        });
      }
    }

    if (role === "admin" && !adminMicStream) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        setAdminMicStream(stream);
      }).catch(() => {
        alert("Разрешите доступ к микрофону для голосовой связи!");
      });
    }
  }, [step, role, audioStreams, adminMicStream]);

  // --- 1. Пользователь даёт микрофон при входе (автоматически) ---
  useEffect(() => {
    if (step !== "room" || !roomId) return;

    if (role === "user") {
      const myId = socketRef.current?.id || "self";
      let stream = audioStreams[myId];
      const ensureStream = async () => {
        if (!stream) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            setAudioStreams(s => ({ ...s, [myId]: stream }));
          } catch (e) {
            alert("Разрешите доступ к микрофону для голосовой связи!");
            return;
          }
        }

        participants
          .filter(u => u.role === "admin")
          .forEach(admin => {
            if (audioPeers.current[admin.id]) return;
            const peer = new SimplePeer({ initiator: true, trickle: false, stream });
            peer.on("signal", data => {
              socketRef.current.emit("audio-signal", { to: admin.id, data });
            });
            audioPeers.current[admin.id] = peer;
          });
      };
      ensureStream();
    }

    // --- 2. Админ слушает всех юзеров (peer per user) ---
    if (role === "admin") {
      participants
        .filter(u => u.role === "user")
        .forEach(user => {
          if (audioPeers.current[user.id]) return;
          const peer = new SimplePeer({ initiator: false, trickle: false });
          peer.on("signal", data => {
            socketRef.current.emit("audio-signal", { to: user.id, data });
          });
          peer.on("stream", stream => {
            setAudioStreams(s => ({ ...s, [user.id]: stream }));
          });
          audioPeers.current[user.id] = peer;
        });
    }

    // Очистка peer'ов
    return () => {
      Object.values(audioPeers.current).forEach(peer => peer && peer.destroy && peer.destroy());
      audioPeers.current = {};
      setAudioStreams({});
    };
  }, [step, roomId, role, participants]);

  // --- 2. Админ: может ВКЛ/ВЫКЛ свой микрофон (mute/unmute) ---
  useEffect(() => {
    if (role !== "admin" || step !== "room") return;
    if (adminMicEnabled && !adminAudioPeer.current) {
      const startPeer = (stream) => {
        const peer = new SimplePeer({ initiator: true, trickle: false, stream });
        participants
          .filter(u => u.role === "user")
          .forEach(user => {
            peer.on("signal", data => {
              socketRef.current.emit("admin-audio-signal", { to: user.id, data });
            });
          });
        adminAudioPeer.current = peer;
      };

      if (adminMicStream) {
        startPeer(adminMicStream);
      } else {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
          setAdminMicStream(stream);
          startPeer(stream);
        });
      }
    }
    if (!adminMicEnabled && adminMicStream) {
      // Выключить микрофон
      adminMicStream.getTracks().forEach(track => track.stop());
      setAdminMicStream(null);
      if (adminAudioPeer.current) {
        adminAudioPeer.current.destroy();
        adminAudioPeer.current = null;
      }
    }
  }, [adminMicEnabled, step, role, participants, adminMicStream]);

  // --- Video & Screen logic смотри как раньше (ничего не меняем) ---
  async function handleScreenShareConsent(agree) {
    if (agree && showScreenRequest) {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      setScreenStream(stream);
      const peer = new SimplePeer({ initiator: true, trickle: false, stream });
      peer.on("signal", data => {
        socketRef.current.emit("screen-share-signal", { to: showScreenRequest.from, data });
      });
      peer.on("close", () => {
        screenPeerRef.current = null;
        setScreenStream(null);
        setShowScreenRequest(null);
        socketRef.current.emit("screen-share-stopped", { adminId: showScreenRequest.from });
      });
      screenPeerRef.current = peer;
      setShowScreenRequest(null);
    } else {
      setShowScreenRequest(null);
    }
  }
  async function handleAdminScreenPeer(userId) {
    const peer = new SimplePeer({ initiator: false, trickle: false });
    peer.on("signal", data => {
      socketRef.current.emit("screen-share-signal", { to: userId, data });
    });
    peer.on("stream", stream => {
      setScreenStream(stream);
      setSharingUserId(userId);
      if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
    });
    screenPeerRef.current = peer;
  }
  function requestScreenShare(userId) {
    handleAdminScreenPeer(userId);
    socketRef.current.emit("request-screen-share", { roomId, from: socketRef.current.id, to: userId });
  }

  async function handleVideoConsent(agree) {
    if (agree && showVideoRequest) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      setVideoStream(stream);
      const peer = new SimplePeer({ initiator: true, trickle: false, stream });
      peer.on("signal", data => {
        socketRef.current.emit("video-signal", { to: showVideoRequest.from, data });
      });
      peer.on("close", () => {
        videoPeerRef.current = null;
        setVideoStream(null);
        setShowVideoRequest(null);
        socketRef.current.emit("video-stopped", { adminId: showVideoRequest.from });
      });
      videoPeerRef.current = peer;
      setShowVideoRequest(null);
    } else {
      setShowVideoRequest(null);
    }
  }
  async function handleAdminVideoPeer(userId) {
    const peer = new SimplePeer({ initiator: false, trickle: false });
    peer.on("signal", data => {
      socketRef.current.emit("video-signal", { to: userId, data });
    });
    peer.on("stream", stream => {
      setVideoStream(stream);
      setSharingVideoUserId(userId);
      if (cameraVideoRef.current) cameraVideoRef.current.srcObject = stream;
    });
    videoPeerRef.current = peer;
  }
  function requestVideo(userId) {
    handleAdminVideoPeer(userId);
    socketRef.current.emit("request-video", { roomId, from: socketRef.current.id, to: userId });
  }

  // --- UI ---
  if (step === "login") {
    return (
      <div style={{ minHeight: "100vh", background: "#f8f9fc", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <form style={{ padding: 32, borderRadius: 16, background: "#fff", boxShadow: "0 0 24px #eee", minWidth: 360 }} onSubmit={e => {
          e.preventDefault();
          if (!name.trim() || !roomId.trim()) return;
          socketRef.current.emit("join-room", { roomId, user: { name, avatar, role } });
          setStep("room");
        }}>
          <h2 style={{ textAlign: "center" }}>Вход</h2>
          <input placeholder="Ваше имя" value={name} onChange={e => setName(e.target.value)} style={{ width: "100%", margin: "8px 0", padding: 10 }} />
          <input placeholder="ID комнаты" value={roomId} onChange={e => setRoomId(e.target.value)} style={{ width: "100%", margin: "8px 0", padding: 10 }} />
          <div style={{ margin: "10px 0" }}>Выбери аватар:</div>
          <div style={{ display: "flex", gap: 12 }}>
            {AVATARS.map(av =>
              <button key={av} type="button" style={{ fontSize: 28, background: avatar === av ? "#d4e6fa" : "#fff", border: "2px solid #eee", borderRadius: 10, cursor: "pointer" }} onClick={() => setAvatar(av)}>{av}</button>
            )}
          </div>
          <div style={{ margin: "10px 0", display: "flex", gap: 10 }}>
            <label><input type="radio" checked={role === "user"} onChange={() => setRole("user")} /> Пользователь</label>
            <label><input type="radio" checked={role === "admin"} onChange={() => setRole("admin")} /> Админ</label>
          </div>
          <button type="submit" style={{ width: "100%", background: "#3476F4", color: "#fff", border: 0, borderRadius: 8, padding: 12, fontSize: 18, marginTop: 12 }}>Войти</button>
        </form>
      </div>
    );
  }

  // --- UI Room ---
  return (
    <div style={{ maxWidth: 1200, margin: "30px auto", display: "flex", gap: 20 }}>
      {/* Admin panel: список всех комнат */}
      {role === "admin" && (
        <div style={{ marginBottom: 12 }}>
          <b style={{ fontSize: 18, color: "#2567d2" }}>Все комнаты:</b>
          <ul style={{ marginLeft: 12 }}>
            {activeRooms.map(room =>
              <li key={room.id} style={{ marginBottom: 4 }}>
                <span style={{ fontWeight: "bold", color: "#333" }}>{room.id}</span>
                <span style={{ color: "#888", marginLeft: 8 }}>({room.users.length} чел.)</span>
                <button
                  style={{ marginLeft: 10, background: "#db3e5a", color: "#fff", border: 0, borderRadius: 6, padding: "2px 10px", fontSize: 12, cursor: "pointer" }}
                  onClick={() => socketRef.current.emit("admin-close-room", { roomId: room.id })}
                >Завершить</button>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Участники */}
      <div style={{ minWidth: 180, background: "#fff", borderRadius: 12, padding: 16, boxShadow: "0 0 12px #f0f2fa" }}>
        <b style={{ fontSize: 18 }}>Участники</b>
        <ul style={{ marginTop: 16, padding: 0, listStyle: "none" }}>
          {participants.map(u => (
            <li key={u.id} style={{ margin: "10px 0", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 28 }}>{u.avatar}</span>
              <span style={{ fontWeight: u.role === "admin" ? "bold" : 500 }}>{u.name}</span>
              <span style={{
                fontSize: 12, color: "#fff", background: u.role === "admin" ? "#db3e5a" : "#888", borderRadius: 6, padding: "2px 6px", marginLeft: 6
              }}>{u.role}</span>
              {role === "admin" && u.id !== socketRef.current.id && (
                <>
                  <button style={{ marginLeft: 8, fontSize: 12, padding: "2px 7px", borderRadius: 6, background: "#3a81f3", color: "#fff", border: 0, cursor: "pointer" }}
                    onClick={() => requestScreenShare(u.id)}>Экран</button>
                  <button style={{ marginLeft: 8, fontSize: 12, padding: "2px 7px", borderRadius: 6, background: "#4ad144", color: "#fff", border: 0, cursor: "pointer" }}
                    onClick={() => requestVideo(u.id)}>Видео</button>
                </>
              )}
            </li>
          ))}
        </ul>
        <button onClick={() => {
          const url = `${window.location.origin}?room=${encodeURIComponent(roomId)}`;
          navigator.clipboard.writeText(url);
          alert("Ссылка на комнату скопирована!");
        }} style={{ width: "100%", marginTop: 10, background: "#eee", border: 0, padding: 8, borderRadius: 7, cursor: "pointer" }}>Пригласить по ссылке</button>
        <button onClick={() => window.location.reload()} style={{ width: "100%", marginTop: 10, background: "#db3e5a", color: "#fff", border: 0, padding: 8, borderRadius: 7, cursor: "pointer" }}>Завершить сеанс</button>
        {/* --- Админ микрофон --- */}
        {role === "admin" && (
          <button
            style={{
              width: "100%", marginTop: 10, background: adminMicEnabled ? "#21b131" : "#aaa", color: "#fff",
              border: 0, padding: 8, borderRadius: 7, cursor: "pointer"
            }}
            onClick={() => setAdminMicEnabled(e => !e)}
          >
            {adminMicEnabled ? "Микрофон ВКЛ" : "Микрофон ВЫКЛ"}
          </button>
        )}
      </div>

      {/* Центр — Экран и Видео */}
      <div style={{ flex: 1, background: "#fff", borderRadius: 12, padding: 24, minHeight: 320, boxShadow: "0 0 12px #f0f2fa" }}>
        {screenStream &&
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: "#3476f4", marginBottom: 2 }}>
              Демонстрация экрана
            </div>
            <video ref={screenVideoRef} autoPlay controls style={{ width: 320, height: 180, borderRadius: 10, background: "#000" }} />
            <div>
              <button
                onClick={() => screenVideoRef.current?.requestFullscreen()}
                style={{ margin: "8px 8px 8px 0", background: "#3476F4", color: "#fff", border: 0, borderRadius: 8, padding: "3px 14px", fontSize: 13, cursor: "pointer" }}>
                Развернуть
              </button>
              <button
                onClick={() => {
                  const popup = window.open('', '_blank', 'width=800,height=500');
                  popup.document.write(`
                    <html>
                      <body style="margin:0;display:flex;justify-content:center;align-items:center;height:100vh;background:#222;">
                        <video id="remoteScreen" autoplay playsinline controls style="width:90vw;height:90vh;border-radius:20px;background:#000;"></video>
                      </body>
                    </html>
                  `);
                  setTimeout(() => {
                    const video = popup.document.getElementById('remoteScreen');
                    if (video) {
                      video.srcObject = screenStream;
                      video.play();
                    }
                  }, 400);
                }}
                style={{ margin: "8px 0", background: "#222", color: "#fff", border: 0, borderRadius: 8, padding: "3px 14px", fontSize: 13, cursor: "pointer" }}>
                В окне
              </button>
            </div>
          </div>
        }

        {videoStream &&
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: "#28c36a", marginBottom: 2 }}>
              Камера пользователя
            </div>
            <video ref={cameraVideoRef} autoPlay controls style={{ width: 320, height: 180, borderRadius: 10, background: "#000" }} />
            <div>
              <button
                onClick={() => cameraVideoRef.current?.requestFullscreen()}
                style={{ margin: "8px 8px 8px 0", background: "#3476F4", color: "#fff", border: 0, borderRadius: 8, padding: "3px 14px", fontSize: 13, cursor: "pointer" }}>
                Развернуть
              </button>
              <button
                onClick={() => {
                  const popup = window.open('', '_blank', 'width=800,height=500');
                  popup.document.write(`
                    <html>
                      <body style="margin:0;display:flex;justify-content:center;align-items:center;height:100vh;background:#222;">
                        <video id="remoteCamera" autoplay playsinline controls style="width:90vw;height:90vh;border-radius:20px;background:#000;"></video>
                      </body>
                    </html>
                  `);
                  setTimeout(() => {
                    const video = popup.document.getElementById('remoteCamera');
                    if (video) {
                      video.srcObject = videoStream;
                      video.play();
                    }
                  }, 400);
                }}
                style={{ margin: "8px 0", background: "#222", color: "#fff", border: 0, borderRadius: 8, padding: "3px 14px", fontSize: 13, cursor: "pointer" }}>
                В окне
              </button>
            </div>
          </div>
        }

        {/* Админ слышит пользователей */}
        {role === "admin" && Object.entries(audioStreams).map(([userId, stream]) => (
          <audio key={userId} srcObject={stream} autoPlay controls style={{ display: "block", marginTop: 16 }} />
        ))}
      </div>

      {/* Чат */}
      <div style={{ minWidth: 270, background: "#fff", borderRadius: 12, padding: 16, boxShadow: "0 0 12px #f0f2fa", display: "flex", flexDirection: "column", height: 320 }}>
        <b style={{ fontSize: 18, marginBottom: 8 }}>Чат</b>
        <div style={{ flex: 1, overflowY: "auto", marginBottom: 10, background: "#f8f9fc", borderRadius: 8, padding: 10, minHeight: 100 }}>
          {chat.map((msg, idx) =>
            <div key={idx} style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 18 }}>{msg.user.avatar}</span>
              <b style={{ marginLeft: 4, marginRight: 5 }}>{msg.user.name}:</b>
              <span>{msg.text}</span>
            </div>
          )}
        </div>
        <form onSubmit={e => {
          e.preventDefault();
          if (message && socketRef.current) {
            socketRef.current.emit("chat-message", {
              roomId,
              user: { name, avatar, role },
              text: message
            });
            setMessage("");
          }
        }} style={{ display: "flex", gap: 7 }}>
          <input value={message} onChange={e => setMessage(e.target.value)} placeholder="Ваше сообщение..." style={{ flex: 1, padding: 7, borderRadius: 7, border: "1px solid #ccc" }} />
          <button type="submit" style={{ background: "#3476F4", color: "#fff", border: 0, borderRadius: 8, padding: "7px 16px" }}>Отправить</button>
        </form>
      </div>

      {/* Popup: screen/video request */}
      {showScreenRequest && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", padding: 30, borderRadius: 10, minWidth: 300, textAlign: "center" }}>
            <h3>Сервис запрашивает демонстрацию экрана</h3>
            <div style={{ margin: 20 }}>
              <button onClick={() => handleScreenShareConsent(true)} style={{ padding: 10, marginRight: 10, background: "#3a81f3", color: "#fff", border: 0, borderRadius: 8 }}>Разрешить</button>
              <button onClick={() => handleScreenShareConsent(false)} style={{ padding: 10, background: "#aaa", color: "#fff", border: 0, borderRadius: 8 }}>Отказать</button>
            </div>
          </div>
        </div>
      )}
      {showVideoRequest && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", padding: 30, borderRadius: 10, minWidth: 300, textAlign: "center" }}>
            <h3>Сервис запрашивает доступ к вашей камере</h3>
            <div style={{ margin: 20 }}>
              <button onClick={() => handleVideoConsent(true)} style={{ padding: 10, marginRight: 10, background: "#4ad144", color: "#fff", border: 0, borderRadius: 8 }}>Разрешить</button>
              <button onClick={() => handleVideoConsent(false)} style={{ padding: 10, background: "#aaa", color: "#fff", border: 0, borderRadius: 8 }}>Отказать</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
