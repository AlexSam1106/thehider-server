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

const players = {}; // Almacena el estado de los jugadores por socket.id (datos de juego como posición, rotación, animación)
const userProfiles = {}; // Almacena el perfil completo del usuario { socket.id: { username, bio, connectedAt } }
// Para un mapeo rápido de username a socket.id para verificación de unicidad de sesión
const usernameToSocketId = {}; // { normalizedUsername: socket.id }

// --- ELIMINADO: Ya no se utiliza un token de sesión para la validación estricta ---


let globalRoomStats = {
    currentPlayers: 0,
    maxPlayers: 16, // Puedes ajustar este máximo de jugadores por sala global
    avgTime: "07:30" // Tiempo promedio de partida (hardcoded por ahora)
};

let serverStats = {
    activePlayers: 0, // Jugadores actualmente conectados al servidor (basado en 'players' object)
    activeRooms: 0,   // Salas de juego activas (lógica a implementar si hay múltiples salas)
    gamesInProgress: 0, // Partidas en curso (lógica a implementar)
    avgTime: "08:45",   // Tiempo promedio de juego en el servidor
    topHunter: "ShadowHunter", // Mejor cazador (hardcoded por ahora)
    latency: 0 // Se calculará con un ping simple
};

// Función para actualizar y emitir estadísticas de la sala global
function updateAndEmitRoomStats() {
    // Cuenta la cantidad de nombres de usuario únicos actualmente conectados, lo que refleja los jugadores activos.
    globalRoomStats.currentPlayers = Object.keys(usernameToSocketId).length;
    io.emit('roomStatsUpdate', globalRoomStats);
    console.log(`[STATS] Estadísticas de sala actualizadas: Jugadores conectados: ${globalRoomStats.currentPlayers}`);
}

// Función para actualizar y emitir estadísticas generales del servidor
function updateAndEmitServerStats() {
    serverStats.activePlayers = Object.keys(players).length; // Cantidad de sockets conectados
    // Aquí puedes añadir lógica para calcular activeRooms y gamesInProgress si tuvieras un sistema de salas más complejo.
    // Por ahora, estos pueden seguir siendo valores ficticios o simplemente los que ya tiene.
    
    serverStats.latency = Math.floor(Math.random() * 50) + 20; // Simula latencia entre 20ms y 70ms
    io.emit('serverStatsUpdate', serverStats);
    console.log(`[STATS] Estadísticas de servidor actualizadas: Sockets activos: ${serverStats.activePlayers}`);
}

// Actualizar estadísticas cada cierto intervalo
setInterval(updateAndEmitRoomStats, 5000); // Cada 5 segundos
setInterval(updateAndEmitServerStats, 10000); // Cada 10 segundos


io.on('connection', (socket) => {
    console.log(`[CONNECT] Un nuevo usuario se ha conectado: ${socket.id}`);

    updateAndEmitRoomStats();
    updateAndEmitServerStats();

    // --- Manejo de registro de usuario (desde multiplayer_menu.html) ---
    socket.on('registerUser', (data) => {
        const { username, bio } = data;
        const normalizedUsername = username.toLowerCase();

        console.log(`[REGISTER] Intento de registro de "${username}" (Socket ID: ${socket.id}).`);

        // Verifica si el nombre de usuario ya está en uso por un socket *diferente* y activo.
        // Si es así, significa que el usuario ya tiene una sesión en otra pestaña/navegador.
        if (usernameToSocketId[normalizedUsername] && usernameToSocketId[normalizedUsername] !== socket.id) {
            console.log(`[REGISTER] Intento de registro fallido: Nombre de usuario "${username}" ya está en uso por otro socket (${usernameToSocketId[normalizedUsername]}).`);
            socket.emit('usernameValidationResponse', { success: false, message: 'El nombre de usuario ya está en uso. Por favor, elige otro o reconéctate con tu usuario.' });
            return;
        }

        // Si el usuario ya está registrado en *este* socket (ej. refrescó la página y volvió a registrarse), actualiza su bio.
        if (userProfiles[socket.id] && userProfiles[socket.id].username.toLowerCase() === normalizedUsername) {
            userProfiles[socket.id].bio = bio; // Actualiza la bio
            console.log(`[REGISTER] Perfil existente para "${username}" (Socket ID: ${socket.id}) actualizado.`);
        } else {
            // Nuevo registro para este socket.
            userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
            console.log(`[REGISTER] Nuevo perfil para "${username}" (Socket ID: ${socket.id}) creado.`);
        }
        
        // Actualiza los mapeos para el socket actual
        usernameToSocketId[normalizedUsername] = socket.id;

        // Inicializa/actualiza los datos del jugador en el objeto 'players' (importante para el estado del juego)
        players[socket.id] = players[socket.id] || {
            position: { x: 0, y: 0.27, z: 0 },
            rotation: 0,
            pitchRotation: 0,
            flashlightOn: true,
            playerAnimationState: 'idle'
        };
        players[socket.id].username = username; // Asegura que el objeto players también tenga el username

        // Envía la respuesta con los datos de usuario (sin sessionToken)
        socket.emit('usernameValidationResponse', { success: true, message: '¡Perfil guardado correctamente!', userData: userProfiles[socket.id] });
        updateAndEmitRoomStats();
        updateAndEmitServerStats();
    });

    // --- Manejo de reconexión de usuario (desde multiplayer_menu.html) ---
    // Esto ocurre si el usuario ya tenía un perfil y actualiza el menú.
    socket.on('userReconnected', (data) => {
        const { username, bio } = data; // Ya no se espera sessionToken
        const normalizedUsername = username.toLowerCase();

        console.log(`[RECONNECT_MENU] Usuario "${username}" intentando reconectar desde menú (Socket ID: ${socket.id}).`);

        // Simplemente actualiza el perfil para este socket, o crea uno si no existe.
        userProfiles[socket.id] = userProfiles[socket.id] || {};
        userProfiles[socket.id].username = username;
        userProfiles[socket.id].bio = bio;
        userProfiles[socket.id].connectedAt = new Date().toISOString();

        // Actualiza los mapeos al nuevo socket.id. Si el username ya estaba asociado a otro socket, se sobrescribe.
        usernameToSocketId[normalizedUsername] = socket.id;

        // Asegura que los datos del jugador existan y tengan el nombre de usuario
        players[socket.id] = players[socket.id] || {
            position: { x: 0, y: 0.27, z: 0 }, rotation: 0, pitchRotation: 0, flashlightOn: true, playerAnimationState: 'idle'
        };
        players[socket.id].username = username;

        socket.emit('sessionResumed', userProfiles[socket.id]);
        updateAndEmitRoomStats();
        updateAndEmitServerStats();
    });

    // --- Manejo de la solicitud de unión al Lobby Global (desde multiplayer_menu.html) ---
    socket.on('joinGlobalLobby', (data) => {
        const { username } = data; // Ya no se espera sessionToken
        const normalizedUsername = username.toLowerCase();

        console.log(`[JOIN_LOBBY] Solicitud de unión a Lobby Global de "${username}" (Socket ID: ${socket.id}).`);

        // Validación simple: Solo verifica que el username esté presente y que el socket actual esté asociado a un perfil.
        // La lógica de token estricta ha sido eliminada.
        if (!username || !userProfiles[socket.id] || userProfiles[socket.id].username.toLowerCase() !== normalizedUsername) {
            let errorMessage = 'Acceso denegado. Asegúrate de tener un perfil de usuario registrado.';
            console.warn(`[JOIN_LOBBY] Admisión denegada para ${username || 'N/A'} (Socket ID: ${socket.id}). Motivo: ${errorMessage}`);
            socket.emit('admissionError', errorMessage); // Envía el error al cliente del menú
            return; // Detiene el procesamiento
        }

        // Si la validación simple es exitosa, envía la señal al cliente para redirigir
        socket.emit('admissionSuccess'); // Este evento es escuchado por multiplayer_menu.html para la redirección
        console.log(`[JOIN_LOBBY] Admisión exitosa al Lobby Global para ${username} (Socket ID: ${socket.id}). Cliente redirigiendo...`);
    });

    // --- OYENTE CRÍTICO PARA EL LOBBY 3D: Maneja la conexión desde multiplayer_lobby_server.html ---
    socket.on('playerConnectedWithUser', (playerData) => {
        const { username, bio, position, rotation, pitchRotation, flashlightOn, playerAnimationState } = playerData; // Ya no se espera sessionToken
        const normalizedUsername = username.toLowerCase();

        console.log(`[LOBBY_INIT] Nuevo socket del lobby conectado: "${username}" (Socket ID: ${socket.id}).`);

        // Simplemente asocia el username y bio recibidos a este socket.
        // No hay validación de token ni transferencia de sesión estricta.
        userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
        usernameToSocketId[normalizedUsername] = socket.id;

        // Inicializa/actualiza los datos del jugador para este nuevo socket.id
        players[socket.id] = {
            position: position,
            rotation: rotation,
            pitchRotation: pitchRotation,
            flashlightOn: flashlightOn,
            playerAnimationState: playerAnimationState,
            username: username
        };

        socket.emit('admissionSuccess');
        console.log(`[LOBBY_INIT] Admisión exitosa al juego 3D para "${username}" (Socket ID: ${socket.id}).`);

        const currentPlayersData = {};
        for (const playerId in players) {
            const playerGameData = players[playerId];
            const profile = userProfiles[playerId]; 

            if (profile && profile.username) { // Solo incluye jugadores con perfiles válidos
                currentPlayersData[playerId] = { 
                    id: playerId, 
                    ...playerGameData, 
                    username: profile.username,
                    bio: profile.bio || '' 
                };
            }
        }
        io.emit('currentPlayers', currentPlayersData); // Emite a TODOS los clientes activos (incluido el nuevo)

        // Emite a todos los demás clientes (excepto al recién conectado) que un nuevo jugador se ha unido
        socket.broadcast.emit('playerMoved', { 
            id: socket.id, 
            ...players[socket.id], 
            username: username 
        }); 

        updateAndEmitRoomStats(); 
        updateAndEmitServerStats(); 
    });

    // Cuando un jugador se mueve (este evento es manejado por multiplayer_lobby_server.html)
    socket.on('playerMoved', (playerData) => {
        // Asegura que el socket que envía el movimiento esté validado y tenga un perfil asociado.
        // Aquí seguimos validando que tenga un perfil, aunque sea simple.
        if (!userProfiles[socket.id]) {
            console.warn(`[PLAYER_MOVED] Movimiento ignorado para socket ${socket.id}: Usuario no validado. Posible intento de manipulación.`);
            socket.disconnect(true); // Desconecta al cliente no autorizado
            return; 
        }

        const username = userProfiles[socket.id].username; // Obtiene el nombre de usuario del perfil validado

        // Actualiza los datos de posición y estado del jugador
        if (players[socket.id]) {
            players[socket.id].position = playerData.position;
            players[socket.id].rotation = playerData.rotation;
            players[socket.id].pitchRotation = playerData.pitchRotation;
            players[socket.id].flashlightOn = playerData.flashlightOn;
            players[socket.id].playerAnimationState = playerData.playerAnimationState;
            players[socket.id].username = username; // Asegura que el nombre de usuario venga del perfil registrado

            // Emite la actualización a todos los demás jugadores
            socket.broadcast.emit('playerMoved', { 
                id: socket.id, 
                ...players[socket.id], 
                username: username, // Envía el nombre de usuario con los datos de movimiento
                bio: userProfiles[socket.id].bio || '' 
            });
        } else {
            // Este caso puede ocurrir si un jugador se reconecta muy rápido o hay una desincronización.
            // Reinicializa sus datos aquí, aunque lo ideal es que pase por playerConnectedWithUser
            console.warn(`[PLAYER_MOVED] Jugador "${username}" (${socket.id}) intentó moverse pero no estaba en 'players'. Re-inicializando.`);
            players[socket.id] = {
                position: playerData.position,
                rotation: playerData.rotation,
                pitchRotation: playerData.pitchRotation,
                flashlightOn: playerData.flashlightOn,
                playerAnimationState: playerData.playerAnimationState,
                username: username
            };
            // Una vez reinicializado, emite a todos (incluido él mismo) para sincronizar
            io.emit('playerMoved', { 
                id: socket.id, 
                ...players[socket.id], 
                username: username,
                bio: userProfiles[socket.id].bio || ''
            });
        }
    });

    // Cuando un jugador envía un mensaje de chat
    socket.on('chatMessage', (data) => {
        if (!userProfiles[socket.id]) { // Ignora el chat si el usuario no está registrado/validado
            console.warn(`[CHAT] Mensaje de chat ignorado para socket ${socket.id}: Usuario no validado.`);
            return;
        }
        const senderName = userProfiles[socket.id].username; // Usa el nombre del perfil registrado
        console.log(`[CHAT] Mensaje de chat de ${senderName} (${socket.id.substring(0,4)}...): ${data.text}`);
        io.emit('chatMessage', { senderId: socket.id, senderName: senderName, text: data.text });
    });

    // Manejo de desconexión
    socket.on('disconnect', () => {
        let disconnectedUsername = 'Anónimo (Desconocido)';
        const userProfile = userProfiles[socket.id]; // Obtiene el perfil asociado a este socket que se desconecta
        
        if (userProfile) {
            disconnectedUsername = userProfile.username;
            const normalizedUsername = userProfile.username.toLowerCase();
            
            // Elimina los mapeos y el perfil asociado a este socket.
            if (usernameToSocketId[normalizedUsername] === socket.id) {
                delete usernameToSocketId[normalizedUsername];
                console.log(`[DISCONNECT] Mapeo de usuario "${disconnectedUsername}" eliminado ya que su socket activo (${socket.id}) se desconectó.`);
            }
            
            delete userProfiles[socket.id]; 
            console.log(`[DISCONNECT] Perfil de usuario para "${disconnectedUsername}" (Socket ID: ${socket.id}) eliminado.`);
        } else {
            console.log(`[DISCONNECT] Socket no identificado se desconectó: ${socket.id}.`);
        }
        
        // Los datos del juego del jugador (posición, rotación, etc.) para este socket específico se pueden eliminar inmediatamente.
        if (players[socket.id]) {
            delete players[socket.id]; 
            console.log(`[DISCONNECT] Datos de juego para Socket ID: ${socket.id} eliminados.`);
        }
        
        console.log(`[DISCONNECT] Un usuario se ha desconectado: ${disconnectedUsername} (Socket ID: ${socket.id}).`);
        
        // Envía el ID y el nombre de usuario del jugador desconectado a los demás
        io.emit('playerDisconnected', { id: socket.id, username: disconnectedUsername });

        updateAndEmitRoomStats(); 
        updateAndEmitServerStats(); 
    });

    // Para cuando el usuario cierra la sesión desde el cliente (restablece el perfil)
    socket.on('userLoggedOut', () => {
        if (userProfiles[socket.id]) {
            const usernameToClear = userProfiles[socket.id].username.toLowerCase();

            delete userProfiles[socket.id];
            
            // Aquí sí borramos los mapeos, porque el usuario está indicando un cierre de sesión definitivo.
            if (usernameToSocketId[usernameToClear] === socket.id) {
                 delete usernameToSocketId[usernameToClear];
                 console.log(`[LOGOUT] Mapeo de usuario "${usernameToClear}" eliminado por logout.`);
            }
            console.log(`[LOGOUT] Usuario ${usernameToClear} ha cerrado sesión.`);
            updateAndEmitRoomStats();
            updateAndEmitServerStats();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
});
