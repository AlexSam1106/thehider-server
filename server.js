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

const players = {}; // Almacena el estado de los jugadores por socket.id
const registeredUsers = {}; // Almacena los nombres de usuario registrados { username: socket.id }
const userProfiles = {}; // Almacena el perfil completo del usuario { socket.id: { username, bio, connectedAt } }

let globalRoomStats = {
    currentPlayers: 0,
    maxPlayers: 16, // Puedes ajustar este máximo de jugadores por sala global
    avgTime: "07:30" // Tiempo promedio de partida (hardcoded por ahora)
};

let serverStats = {
    activePlayers: 0, // Jugadores actualmente conectados al servidor
    activeRooms: 0,   // Salas de juego activas
    gamesInProgress: 0, // Partidas en curso
    avgTime: "08:45",   // Tiempo promedio de juego en el servidor
    topHunter: "ShadowHunter", // Mejor cazador (hardcoded por ahora)
    latency: 0 // Se calculará con un ping simple
};

// Función para actualizar y emitir estadísticas de la sala global
function updateAndEmitRoomStats() {
    globalRoomStats.currentPlayers = Object.keys(userProfiles).length; // Número de usuarios con perfil cargado
    io.emit('roomStatsUpdate', globalRoomStats);
}

// Función para actualizar y emitir estadísticas generales del servidor
function updateAndEmitServerStats() {
    serverStats.activePlayers = Object.keys(players).length; // Jugadores conectados via socket
    // Aquí podrías añadir lógica para calcular activeRooms y gamesInProgress si tuvieras un sistema de salas más complejo.
    // Por ahora, usamos valores ficticios o simplemente los que ya tiene si no hay lógica para actualizar.
    
    // Calcular latencia simple (esto es muy básico y no es una latencia real precisa)
    // Para una latencia real se necesitaría un mecanismo de ping/pong
    serverStats.latency = Math.floor(Math.random() * 50) + 20; // Simula latencia entre 20ms y 70ms

    io.emit('serverStatsUpdate', serverStats);
}

// Actualizar estadísticas cada cierto intervalo
setInterval(updateAndEmitRoomStats, 5000); // Cada 5 segundos
setInterval(updateAndEmitServerStats, 10000); // Cada 10 segundos


io.on('connection', (socket) => {
    console.log('Un usuario se ha conectado:', socket.id);

    // Inicializar jugador en 'players' (para el juego 3D, si se usa)
    players[socket.id] = {
        position: { x: 0, y: 0.27, z: 0 },
        rotation: 0,
        pitchRotation: 0,
        flashlightOn: true,
        playerAnimationState: 'idle'
    };

    // Envía a los jugadores actuales al nuevo jugador (si aplica a tu lógica de juego 3D)
    const playersWithIds = {};
    for (const playerId in players) {
        playersWithIds[playerId] = { id: playerId, ...players[playerId] };
    }
    socket.emit('currentPlayers', playersWithIds);

    // Envía el nuevo jugador (con su ID) a los otros jugadores
    socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id] });

    // Actualiza las estadísticas al conectar
    updateAndEmitRoomStats();
    updateAndEmitServerStats();

    // --- Manejo de registro de usuario ---
    socket.on('registerUser', (data) => {
        const { username, bio } = data;
        
        // Convertir el username a minúsculas para una comparación sin distinción de mayúsculas
        const lowerCaseUsername = username.toLowerCase();

        // Verificar si el nombre de usuario ya está en uso
        const isUsernameTaken = Object.values(userProfiles).some(profile => profile.username.toLowerCase() === lowerCaseUsername);

        if (isUsernameTaken) {
            socket.emit('usernameValidationResponse', { success: false, message: 'El nombre de usuario ya está en uso. Por favor, elige otro.' });
        } else {
            // Guardar el perfil del usuario
            userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
            registeredUsers[lowerCaseUsername] = socket.id; // Guarda la referencia al socket.id

            // AÑADIDO: Incluir mensaje de éxito en la respuesta
            socket.emit('usernameValidationResponse', { success: true, message: '¡Perfil guardado correctamente!', userData: userProfiles[socket.id] });
            updateAndEmitRoomStats(); // Actualiza el conteo de jugadores conectados
            updateAndEmitServerStats(); // Actualiza estadísticas generales
        }
    });

    // Manejo de reconexión de usuario (si el usuario ya tenía un perfil)
    socket.on('userReconnected', (data) => {
        const { username, bio } = data;
        const lowerCaseUsername = username.toLowerCase();

        // Si el username ya estaba registrado por otro socket (por ejemplo, sesión antigua o refresco rápido)
        // Podrías añadir lógica para invalidar la sesión anterior o manejarlo según tu juego.
        // Por simplicidad, si el socket.id es diferente pero el username existe, lo actualizamos.
        if (registeredUsers[lowerCaseUsername] && registeredUsers[lowerCaseUsername] !== socket.id) {
            console.log(`Usuario ${username} ya estaba conectado con otro socket ID. Actualizando.`);
            // Opcional: desconectar el socket anterior si solo quieres una sesión por usuario
            // io.sockets.sockets.get(registeredUsers[lowerCaseUsername])?.disconnect();
        }
        
        // Actualizar o crear el perfil con el nuevo socket.id
        userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
        registeredUsers[lowerCaseUsername] = socket.id; // Asegura que el nuevo socket.id esté asociado al username

        socket.emit('sessionResumed', userProfiles[socket.id]); // Notificar al cliente que la sesión ha sido reanudada
        updateAndEmitRoomStats();
        updateAndEmitServerStats();
    });

    // --- Manejo de unión a la sala global ---
    socket.on('joinGlobalLobby', (data) => {
        const { username } = data;
        const user = userProfiles[socket.id];

        if (user && user.username.toLowerCase() === username.toLowerCase()) {
            // Si el usuario tiene un perfil validado y coincide con el nombre que está intentando usar
            console.log(`${username} se está uniendo a la sala global.`);
            socket.emit('admittedToLobby');
            // Aquí podrías añadir lógica para unirte a una sala de juego real, etc.
        } else {
            // Si el usuario no tiene un perfil validado o hay una inconsistencia
            socket.emit('admissionError', 'Debes tener un perfil de usuario válido y único para unirte a la sala.');
        }
    });

    // Cuando un jugador se mueve
    socket.on('playerMoved', (playerData) => {
        if (players[socket.id]) {
            players[socket.id].position = playerData.position;
            players[socket.id].rotation = playerData.rotation;
            players[socket.id].pitchRotation = playerData.pitchRotation;
            players[socket.id].flashlightOn = playerData.flashlightOn;
            players[socket.id].playerAnimationState = playerData.playerAnimationState;
            // AÑADIDO: Incluir el username si está disponible en userProfiles
            const username = userProfiles[socket.id] ? userProfiles[socket.id].username : undefined;

            socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id], username: username });
        }
    });

    // Cuando un jugador envía un mensaje de chat
    socket.on('chatMessage', (message) => {
        const sender = userProfiles[socket.id] ? userProfiles[socket.id].username : 'Anónimo';
        console.log(`Mensaje de chat de ${sender} (${socket.id}): ${message}`);
        io.emit('chatMessage', { senderId: socket.id, senderName: sender, text: message });
    });

    // Manejo de desconexión
    socket.on('disconnect', () => {
        console.log('Un usuario se ha desconectado:', socket.id);

        // Almacenar el nombre de usuario antes de eliminarlo del perfil
        let disconnectedUsername = 'Anónimo';
        if (userProfiles[socket.id]) {
            disconnectedUsername = userProfiles[socket.id].username;
            const usernameToRemove = userProfiles[socket.id].username.toLowerCase();
            delete userProfiles[socket.id];
            if (registeredUsers[usernameToRemove] === socket.id) {
                delete registeredUsers[usernameToRemove]; // Solo elimina si este socket era el último en usar ese nombre
            }
        }
        
        if (players[socket.id]) {
            delete players[socket.id];
        }
        
        // Envía el ID y el nombre de usuario del jugador desconectado a los demás para que lo eliminen de la escena
        io.emit('playerDisconnected', { id: socket.id, username: disconnectedUsername });

        updateAndEmitRoomStats(); // Actualiza el conteo de jugadores
        updateAndEmitServerStats(); // Actualiza estadísticas generales
    });

    // Para cuando el usuario cierra la sesión desde el cliente (resetea perfil)
    socket.on('userLoggedOut', () => {
        if (userProfiles[socket.id]) {
            const usernameToClear = userProfiles[socket.id].username.toLowerCase();
            delete userProfiles[socket.id];
            if (registeredUsers[usernameToClear] === socket.id) {
                 delete registeredUsers[usernameToClear];
            }
            console.log(`Usuario ${usernameToClear} ha cerrado sesión.`);
            updateAndEmitRoomStats();
            updateAndEmitServerStats();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
});
