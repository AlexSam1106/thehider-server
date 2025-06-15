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
const usernameToSocketId = new Map(); // Almacena los nombres de usuario actualmente conectados y sus IDs de socket (username -> socket.id)

io.on('connection', (socket) => {
    console.log('Un usuario se ha conectado:', socket.id);

    // Cuando un jugador intenta registrarse con un nombre de usuario
    socket.on('registerUsername', (username) => {
        const trimmedUsername = username.trim();
        if (!trimmedUsername) {
            socket.emit('registrationFailed', 'El nombre de usuario no puede estar vacío.');
            return;
        }

        // Verifica si el nombre de usuario ya está en uso por otro socket activo
        if (usernameToSocketId.has(trimmedUsername)) {
            const existingSocketId = usernameToSocketId.get(trimmedUsername);
            // Si el socket actualmente asociado con este nombre de usuario sigue vivo Y no es el socket actual
            if (io.sockets.sockets.has(existingSocketId) && existingSocketId !== socket.id) {
                socket.emit('registrationFailed', `El nombre de usuario '${trimmedUsername}' ya está en uso.`);
                return;
            } else if (existingSocketId === socket.id) {
                // Esto significa que el mismo cliente está intentando volver a registrarse con el mismo nombre de usuario y ID de socket.
                // Esto es generalmente aceptable; simplemente confirmamos que todo está bien.
                console.log(`Intento de re-registro para el nombre de usuario ${trimmedUsername} con el mismo ID de socket ${socket.id}.`);
                socket.emit('registrationSuccess', { username: trimmedUsername, id: socket.id });
                return;
            } else {
                // Este caso ocurre si usernameToSocketId tiene el nombre de usuario, pero el socket asociado está inactivo o desconectado.
                // Limpiamos la entrada antigua y procedemos con este nuevo registro.
                console.log(`El nombre de usuario '${trimmedUsername}' estaba asociado con un socket obsoleto/desconectado (${existingSocketId}). Reclamando.`);
                if (players[existingSocketId]) {
                    delete players[existingSocketId];
                }
                usernameToSocketId.delete(trimmedUsername);
            }
        }

        // Si llegamos aquí, el nombre de usuario está disponible para este socket.
        usernameToSocketId.set(trimmedUsername, socket.id);
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
            const disconnectedUsername = players[socket.id].username;
            // Solo elimina el nombre de usuario del mapa si este ID de socket específico es el que está actualmente vinculado.
            // Esto evita una condición de carrera donde un nuevo socket se conecta y reclama el nombre
            // antes de que la desconexión del socket antiguo se procese completamente y borre la asignación antigua.
            if (usernameToSocketId.get(disconnectedUsername) === socket.id) {
                usernameToSocketId.delete(disconnectedUsername);
                console.log(`Asignación de nombre de usuario '${disconnectedUsername}' eliminada.`);
            } else {
                console.log(`Asignación de nombre de usuario '${disconnectedUsername}' no eliminada del mapa ya que está vinculada a un ID de socket diferente.`);
            }
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
