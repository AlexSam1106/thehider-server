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
    globalRoomStats.currentPlayers = Object.keys(userProfiles).length;
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

    // Inicializar jugador en 'players' (para el juego 3D)
    // Su posición inicial será actualizada por el cliente al cargar el lobby
    players[socket.id] = {
        position: { x: 0, y: 0.27, z: 0 },
        rotation: 0,
        pitchRotation: 0,
        flashlightOn: true,
        playerAnimationState: 'idle',
        username: 'Cargando...' // Valor temporal hasta que se envíe el nombre
    };

    // Actualiza las estadísticas al conectar (antes de que el usuario se registre)
    updateAndEmitRoomStats();
    updateAndEmitServerStats();

    // --- Manejo de registro de usuario (desde multiplayer_menu.html) ---
    socket.on('registerUser', (data) => {
        const { username, bio } = data;
        const normalizedUsername = username.toLowerCase();

        // Verificar si el nombre de usuario ya está en uso por CUALQUIER socket activo
        // Mejorado para verificar si el socket asociado al username es el mismo que el actual
        if (usernameToSocketId[normalizedUsername] && usernameToSocketId[normalizedUsername] !== socket.id) {
            console.log(`[REGISTER] Intento de registro fallido: Nombre de usuario "${username}" ya está en uso por otro socket (${usernameToSocketId[normalizedUsername]}).`);
            socket.emit('usernameValidationResponse', { success: false, message: 'El nombre de usuario ya está en uso. Por favor, elige otro o reconéctate con tu usuario.' });
            return;
        }

        // Si el username no está en uso o es la misma sesión, actualizar/crear
        userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
        usernameToSocketId[normalizedUsername] = socket.id; // Mapear nombre a socket ID

        if (players[socket.id]) {
            players[socket.id].username = username; // Asegurar que el objeto players también tenga el username
        }

        console.log(`[REGISTER] Usuario registrado/actualizado exitosamente: ${username} (Socket ID: ${socket.id})`);
        socket.emit('usernameValidationResponse', { success: true, message: '¡Perfil guardado correctamente!', userData: userProfiles[socket.id] });
        updateAndEmitRoomStats(); // Actualiza el conteo de jugadores conectados
        updateAndEmitServerStats(); // Actualiza estadísticas generales
    });

    // --- Manejo de reconexión de usuario (desde multiplayer_menu.html) ---
    // Esto ocurre si el usuario ya tenía un perfil y refresca el menú
    socket.on('userReconnected', (data) => {
        const { username, bio } = data;
        const normalizedUsername = username.toLowerCase();

        console.log(`[RECONNECT_MENU] Usuario "${username}" intentando reconectar desde menú (Socket ID: ${socket.id}).`);

        // Si el username ya estaba asociado a otro socket ID, desconectar la sesión antigua
        if (usernameToSocketId[normalizedUsername] && usernameToSocketId[normalizedUsername] !== socket.id) {
            const oldSocketId = usernameToSocketId[normalizedUsername];
            console.log(`[RECONNECT_MENU] Usuario "${username}" estaba previamente conectado con socket ID ${oldSocketId}. Desconectando sesión antigua.`);
            const oldSocket = io.sockets.sockets.get(oldSocketId);
            if (oldSocket) {
                oldSocket.emit('admissionError', 'Te has conectado desde otra ubicación. Tu sesión anterior ha sido cerrada.');
                oldSocket.disconnect(true); // Desconectar forzosamente la sesión antigua
            }
            // Limpiar las entradas del socket antiguo
            if (userProfiles[oldSocketId]) delete userProfiles[oldSocketId];
            if (players[oldSocketId]) delete players[oldSocketId];
        }
        
        // Asociar el perfil de usuario con el nuevo socket.id del menú
        userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
        usernameToSocketId[normalizedUsername] = socket.id; // Mapear nombre a socket ID

        if (players[socket.id]) {
            players[socket.id].username = username;
        }

        socket.emit('sessionResumed', userProfiles[socket.id]);
        updateAndEmitRoomStats();
        updateAndEmitServerStats();
    });

    // --- Manejo de la solicitud de unión al Lobby Global (desde multiplayer_menu.html) ---
    socket.on('joinGlobalLobby', (data) => {
        const { username } = data;
        const normalizedUsername = username.toLowerCase();

        console.log(`[JOIN_LOBBY] Solicitud de unión a Lobby Global de "${username}" (Socket ID: ${socket.id}).`);

        // Verificar que el socket actual está asociado con el perfil de usuario.
        // Si el usuario intentó un copy-paste directo, el socket.id del lobby no tendrá un userProfile asociado
        // o el username no coincidirá con el registrado para este socket.id.
        const registeredProfile = userProfiles[socket.id];
        const isUsernameAssignedToThisSocket = registeredProfile && registeredProfile.username.toLowerCase() === normalizedUsername;

        if (!username || !isUsernameAssignedToThisSocket) {
            let errorMessage = 'No autorizado. Accede desde el menú principal para registrarte o iniciar sesión.';
            console.warn(`[JOIN_LOBBY] Admisión denegada para ${username || 'N/A'} (Socket ID: ${socket.id}). Motivo: ${errorMessage}`);
            socket.emit('admissionError', errorMessage); // Enviar error al cliente del menú
            return; // Detener el procesamiento
        }

        // Si la validación es exitosa, enviar al cliente la señal para redirigir
        socket.emit('admissionSuccess'); // Este evento es escuchado por multiplayer_menu.html para redirigir
        console.log(`[JOIN_LOBBY] Admisión exitosa al Lobby Global para ${username} (Socket ID: ${socket.id}). Cliente redirigiendo...`);
    });

    // --- OYENTE CRÍTICO PARA EL LOBBY 3D: Maneja la conexión desde multiplayer_lobby_server.html ---
    socket.on('playerConnectedWithUser', (playerData) => {
        const { id, username, bio, position, rotation, pitchRotation, flashlightOn, playerAnimationState } = playerData;
        const normalizedUsername = username.toLowerCase();

        console.log(`[LOBBY_INIT] Nuevo socket del lobby conectado: "${username}" (Socket ID: ${socket.id}). Datos recibidos:`, playerData);

        // 1. Verificar si ya existe un socket activo para este username (indicando posible sesión duplicada o transferencia de menú a lobby)
        const existingSocketIdForUser = usernameToSocketId[normalizedUsername];
        
        // Si el username ya está mapeado a un socket diferente al actual
        if (existingSocketIdForUser && existingSocketIdForUser !== socket.id) {
            console.log(`[LOBBY_INIT] Detectado usuario "${username}" ya conectado con socket ${existingSocketIdForUser}. Nuevo socket es ${socket.id}.`);
            
            // Disconnect the old socket if it's still active (e.g., the menu page's socket)
            const oldSocket = io.sockets.sockets.get(existingSocketIdForUser);
            if (oldSocket) {
                console.log(`[LOBBY_INIT] Desconectando socket antiguo (${oldSocketIdForUser}) para usuario "${username}".`);
                oldSocket.emit('admissionError', 'Tu sesión ha sido transferida a una nueva ventana de juego. Si esta no eres tú, por favor, reconecta.');
                oldSocket.disconnect(true); // Forzar desconexión
            }
            
            // Limpiar datos asociados al socket antiguo (del menú)
            delete userProfiles[existingSocketIdForUser];
            delete players[existingSocketIdForUser];
        }

        // 2. Asociar el perfil de usuario al NUEVO socket.id del lobby
        userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
        usernameToSocketId[normalizedUsername] = socket.id; // Actualizar el mapeo de username al nuevo socket ID

        // 3. Inicializar los datos de juego para este nuevo socket.id
        players[socket.id] = {
            position: position,
            rotation: rotation,
            pitchRotation: pitchRotation,
            flashlightOn: flashlightOn,
            playerAnimationState: playerAnimationState,
            username: username
        };

        // 4. Enviar al cliente del lobby la señal para iniciar el juego 3D
        socket.emit('admissionSuccess');
        console.log(`[LOBBY_INIT] Admisión exitosa al juego 3D para "${username}" (Socket ID: ${socket.id}).`);

        // 5. Enviar a todos los clientes (incluyendo el recién conectado) los jugadores actuales
        const currentPlayersData = {};
        for (const playerId in players) {
            const playerGameData = players[playerId];
            const userProfileData = userProfiles[playerId] || {};

            currentPlayersData[playerId] = { 
                id: playerId, 
                ...playerGameData, 
                username: userProfileData.username || playerGameData.username,
                bio: userProfileData.bio || '' 
            };
        }
        io.emit('currentPlayers', currentPlayersData); // Emitir a TODOS los clientes activos (incluido el nuevo)

        // 6. Emitir a todos los demás clientes (excepto al recién conectado) que un nuevo jugador se ha unido
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
        // Asegurarse de que el socket que envía el movimiento esté validado y tenga un perfil asociado.
        if (!userProfiles[socket.id]) {
            console.warn(`[PLAYER_MOVED] Movimiento ignorado para socket ${socket.id}: Usuario no validado. Posible intento de manipulación.`);
            socket.disconnect(true); // Desconectar al cliente no autorizado
            return; 
        }

        const username = userProfiles[socket.id].username; // Obtener el username del perfil validado

        // Actualizar los datos de posición y estado del jugador
        if (players[socket.id]) {
            players[socket.id].position = playerData.position;
            players[socket.id].rotation = playerData.rotation;
            players[socket.id].pitchRotation = playerData.pitchRotation;
            players[socket.id].flashlightOn = playerData.flashlightOn;
            players[socket.id].playerAnimationState = playerData.playerAnimationState;
            players[socket.id].username = username; // Asegurar que el username venga del perfil registrado

            // Emitir la actualización a todos los demás jugadores
            socket.broadcast.emit('playerMoved', { 
                id: socket.id, 
                ...players[socket.id], 
                username: username, // Enviar el username con los datos de movimiento
                bio: userProfiles[socket.id].bio || '' 
            });
        } else {
            // Este caso puede ocurrir si un jugador se reconecta muy rápido o hay un desincronización.
            // Re-inicializar sus datos aquí, aunque lo ideal es que pase por playerConnectedWithUser
            console.warn(`[PLAYER_MOVED] Jugador ${username} (${socket.id}) intentó moverse pero no estaba en 'players'. Re-inicializando.`);
            players[socket.id] = {
                position: playerData.position,
                rotation: playerData.rotation,
                pitchRotation: playerData.pitchRotation,
                flashlightOn: playerData.flashlightOn,
                playerAnimationState: playerData.playerAnimationState,
                username: username
            };
            // Una vez re-inicializado, emitir a todos (incluido él mismo) para sincronizar
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
        if (!userProfiles[socket.id]) { // Ignorar chat si el usuario no está registrado/validado
            console.warn(`[CHAT] Mensaje de chat ignorado para socket ${socket.id}: Usuario no validado.`);
            return;
        }
        const senderName = userProfiles[socket.id].username; // Usar el nombre del perfil registrado
        console.log(`[CHAT] Mensaje de chat de ${senderName} (${socket.id.substring(0,4)}...): ${data.text}`);
        io.emit('chatMessage', { senderId: socket.id, senderName: senderName, text: data.text });
    });

    // Manejo de desconexión
    socket.on('disconnect', () => {
        let disconnectedUsername = 'Anónimo (Desconocido)';
        const userProfile = userProfiles[socket.id];
        if (userProfile) {
            disconnectedUsername = userProfile.username;
            const normalizedUsername = userProfile.username.toLowerCase();
            
            // Eliminar el perfil solo si este socket era el último asociado con ese username
            if (usernameToSocketId[normalizedUsername] === socket.id) {
                delete usernameToSocketId[normalizedUsername]; // Elimina el mapeo
            }
            delete userProfiles[socket.id]; // Elimina el perfil del usuario
        }
        
        if (players[socket.id]) {
            delete players[socket.id]; // Elimina los datos de juego
        }
        
        console.log(`[DISCONNECT] Un usuario se ha desconectado: ${disconnectedUsername} (Socket ID: ${socket.id}).`);
        
        // Envía el ID y el nombre de usuario del jugador desconectado a los demás
        io.emit('playerDisconnected', { id: socket.id, username: disconnectedUsername });

        updateAndEmitRoomStats(); // Actualiza el conteo de jugadores
        updateAndEmitServerStats(); // Actualiza estadísticas generales
    });

    // Para cuando el usuario cierra la sesión desde el cliente (resetea perfil)
    socket.on('userLoggedOut', () => {
        if (userProfiles[socket.id]) {
            const usernameToClear = userProfiles[socket.id].username.toLowerCase();
            delete userProfiles[socket.id];
            if (usernameToSocketId[usernameToClear] === socket.id) {
                 delete usernameToSocketId[usernameToClear];
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
