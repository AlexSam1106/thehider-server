const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

// --- CORS CONFIGURATION ---
const io = new Server(server, {
  cors: {
    origin: "https://thehidergame.ballongame.io", // ¡IMPORTANTE! Asegúrate que sea EXACTAMENTE tu dominio de Hostinger
    methods: ["GET", "POST"]
  }
});

// NO HAY LÍNEAS DE app.use(express.static) O app.get('/') AQUÍ.
// Este servidor SOLO manejará las conexiones de Socket.IO.

const players = {}; // Almacena el estado de los jugadores (socket.id -> { position, rotation, pitchRotation, flashlightOn, playerAnimationState, username })
const connectedUsernames = new Set(); // Almacena los nombres de usuario actualmente conectados para asegurar la unicidad

io.on('connection', (socket) => {
    console.log('Un usuario se ha conectado:', socket.id);

    // Cuando un jugador intenta registrarse con un nombre de usuario
    socket.on('registerUsername', (username) => {
        const trimmedUsername = username.trim();
        if (!trimmedUsername) {
            socket.emit('registrationFailed', 'El nombre de usuario no puede estar vacío.');
            return;
        }
        if (connectedUsernames.has(trimmedUsername)) {
            socket.emit('registrationFailed', 'El nombre de usuario ya está en uso.');
            return;
        }

        // Si el nombre de usuario es válido y único
        connectedUsernames.add(trimmedUsername);
        players[socket.id] = {
            position: { x: 0, y: 0.27, z: 0 }, // Posición inicial Y para que el jugador esté en el suelo
            rotation: 0, // Rotación Y
            pitchRotation: 0, // Rotación X de la cámara (arriba/abajo)
            flashlightOn: true, // Estado inicial de la linterna
            playerAnimationState: 'idle', // Estado inicial de la animación
            username: trimmedUsername // Almacena el nombre de usuario
        };

        socket.emit('registrationSuccess', { username: trimmedUsername, id: socket.id });

        // Envía a los jugadores actuales al nuevo jugador
        const playersWithIdsAndUsernames = {};
        for (const playerId in players) {
            playersWithIdsAndUsernames[playerId] = { 
                id: playerId, 
                username: players[playerId].username, // Incluye el nombre de usuario
                ...players[playerId] 
            };
        }
        socket.emit('currentPlayers', playersWithIdsAndUsernames);

        // Envía el nuevo jugador (con su ID y nombre de usuario) a los otros jugadores
        socket.broadcast.emit('playerMoved', { 
            id: socket.id, 
            username: players[socket.id].username, // Incluye el nombre de usuario
            ...players[socket.id] 
        }); 

        console.log(`Usuario ${trimmedUsername} (${socket.id}) registrado y conectado.`);
        updateGlobalStats(); // Actualizar las estadísticas globales a todos los clientes del menú
    });

    // Cuando un jugador se mueve
    socket.on('playerMoved', (playerData) => {
        if (players[socket.id]) { // Asegúrate de que el jugador aún exista
            players[socket.id].position = playerData.position;
            players[socket.id].rotation = playerData.rotation;
            players[socket.id].pitchRotation = playerData.pitchRotation;
            players[socket.id].flashlightOn = playerData.flashlightOn; // Actualiza el estado de la linterna
            players[socket.id].playerAnimationState = playerData.playerAnimationState; // Actualiza el estado de la animación

            // Envía la actualización de la posición (con ID, nombre de usuario y nuevo estado) a todos los demás jugadores
            socket.broadcast.emit('playerMoved', { 
                id: socket.id, 
                username: players[socket.id].username, // Incluye el nombre de usuario
                ...players[socket.id] 
            });
        }
    });

    // Cuando un jugador envía un mensaje de chat
    socket.on('chatMessage', (message) => {
        if (players[socket.id]) { // Asegúrate de que el jugador aún exista
            const senderUsername = players[socket.id].username;
            console.log(`Mensaje de chat de ${senderUsername} (${socket.id}): ${message}`);
            // Envía el mensaje a todos los clientes conectados, incluyendo el remitente
            io.emit('chatMessage', { senderUsername: senderUsername, text: message });
        }
    });

    // Cuando un jugador se desconecta
    socket.on('disconnect', () => {
        console.log('Un usuario se ha desconectado:', socket.id);
        if (players[socket.id]) {
            connectedUsernames.delete(players[socket.id].username); // Elimina el nombre de usuario del conjunto
            const disconnectedUsername = players[socket.id].username;
            delete players[socket.id]; // Elimina al jugador del objeto
            // Envía el ID y el nombre de usuario del jugador desconectado a los demás para que lo eliminen de la escena
            io.emit('playerDisconnected', { id: socket.id, username: disconnectedUsername });
            updateGlobalStats(); // Actualizar las estadísticas globales a todos los clientes del menú
        }
    });
});

// --- Lógica de Estadísticas Globales ---
function updateGlobalStats() {
    const currentPlayersCount = Object.keys(players).length;
    // Estos valores son estáticos o simulados para la demostración
    const maxPlayers = 16; 
    const avgTime = "7:30";
    const activeRooms = Math.floor(Math.random() * 3) + 2; // Simulado para salas activas
    const gamesInProgress = Math.floor(Math.random() * 3) + 2; // Simulado para partidas en curso

    io.emit('globalStatsUpdate', {
        currentPlayers: currentPlayersCount,
        maxPlayers: maxPlayers,
        avgTime: avgTime,
        activeRooms: activeRooms,
        gamesInProgress: gamesInProgress,
        serverStatus: "Online", // Asumiendo que si el servidor está emitiendo, está online
        latency: "45ms" // Esto debería ser medido por el cliente
    });
}

// Emite las estadísticas globales cada 5 segundos a los clientes conectados (menú)
setInterval(updateGlobalStats, 5000); 

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
  updateGlobalStats(); // Envía las estadísticas iniciales al iniciar el servidor
});
