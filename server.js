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
    console.log(`Estadísticas de sala actualizadas: Jugadores conectados: ${globalRoomStats.currentPlayers}`);
}

// Función para actualizar y emitir estadísticas generales del servidor
function updateAndEmitServerStats() {
    serverStats.activePlayers = Object.keys(players).length; // Cantidad de sockets conectados
    // Aquí puedes añadir lógica para calcular activeRooms y gamesInProgress si tuvieras un sistema de salas más complejo.
    // Por ahora, estos pueden seguir siendo valores ficticios o simplemente los que ya tiene.
    
    serverStats.latency = Math.floor(Math.random() * 50) + 20; // Simula latencia entre 20ms y 70ms
    io.emit('serverStatsUpdate', serverStats);
    console.log(`Estadísticas de servidor actualizadas: Sockets activos: ${serverStats.activePlayers}`);
}

// Actualizar estadísticas cada cierto intervalo
setInterval(updateAndEmitRoomStats, 5000); // Cada 5 segundos
setInterval(updateAndEmitServerStats, 10000); // Cada 10 segundos


io.on('connection', (socket) => {
    console.log('Un usuario se ha conectado:', socket.id);

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
        const isUsernameTaken = Object.values(userProfiles).some(profile => profile.username.toLowerCase() === normalizedUsername);

        if (isUsernameTaken) {
            console.log(`Intento de registro fallido: Nombre de usuario "${username}" ya está en uso.`);
            socket.emit('usernameValidationResponse', { success: false, message: 'El nombre de usuario ya está en uso. Por favor, elige otro.' });
        } else {
            // Guardar el perfil del usuario
            userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
            usernameToSocketId[normalizedUsername] = socket.id; // Mapear nombre a socket ID

            // Actualizar el objeto 'players' con el nombre de usuario
            if (players[socket.id]) {
                players[socket.id].username = username;
            }

            console.log(`Usuario registrado exitosamente: ${username} (Socket ID: ${socket.id})`);
            socket.emit('usernameValidationResponse', { success: true, message: '¡Perfil guardado correctamente!', userData: userProfiles[socket.id] });
            updateAndEmitRoomStats(); // Actualiza el conteo de jugadores conectados
            updateAndEmitServerStats(); // Actualiza estadísticas generales
        }
    });

    // --- Manejo de reconexión de usuario (desde multiplayer_menu.html) ---
    // Esto ocurre si el usuario ya tenía un perfil y refresca el menú
    socket.on('userReconnected', (data) => {
        const { username, bio } = data;
        const normalizedUsername = username.toLowerCase();

        // Si el username ya estaba asociado a otro socket ID, significa que el usuario tiene una sesión "vieja" en otro lado.
        // Opcional: desconectar el socket antiguo si solo se permite una conexión por usuario.
        if (usernameToSocketId[normalizedUsername] && usernameToSocketId[normalizedUsername] !== socket.id) {
            console.log(`Usuario "${username}" estaba previamente conectado con socket ID ${usernameToSocketId[normalizedUsername]}. Desconectando sesión antigua.`);
            const oldSocket = io.sockets.sockets.get(usernameToSocketId[normalizedUsername]);
            if (oldSocket) {
                oldSocket.emit('admissionError', 'Te has conectado desde otra ubicación. Tu sesión anterior ha sido cerrada.');
                oldSocket.disconnect(true); // Desconectar forzosamente la sesión antigua
            }
            // Eliminar la entrada antigua de userProfiles si existe
            if (userProfiles[usernameToSocketId[normalizedUsername]]) {
                delete userProfiles[usernameToSocketId[normalizedUsername]];
            }
        }
        
        // Actualizar el perfil del usuario con el nuevo socket.id
        userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString() };
        usernameToSocketId[normalizedUsername] = socket.id; // Mapear nombre a socket ID

        if (players[socket.id]) {
            players[socket.id].username = username;
        }

        socket.emit('sessionResumed', userProfiles[socket.id]);
        updateAndEmitRoomStats();
        updateAndEmitServerStats();
    });

    // --- ¡LA PARTE QUE FALTABA Y ES CLAVE! Manejo de la solicitud de unión al Lobby Global (desde multiplayer_menu.html) ---
    socket.on('joinGlobalLobby', (data) => {
        const { username } = data;
        const normalizedUsername = username.toLowerCase();

        console.log(`[JOIN_LOBBY] Solicitud de unión a Lobby Global de "${username}" (Socket ID: ${socket.id}).`);

        // 1. Verificar si el username está registrado en userProfiles Y si el socket.id actual coincide.
        // Esto valida que la sesión de este socket es la que el menú intentó registrar.
        const registeredProfile = userProfiles[socket.id];
        const isUsernameAssignedToThisSocket = registeredProfile && registeredProfile.username.toLowerCase() === normalizedUsername;

        // 2. Verificar si el username está en usernameToSocketId Y si el socket.id asociado es diferente al actual (sesión duplicada).
        const isUsernameTakenByAnotherSocket = usernameToSocketId[normalizedUsername] && usernameToSocketId[normalizedUsername] !== socket.id;

        if (!username || !isUsernameAssignedToThisSocket || isUsernameTakenByAnotherSocket) {
            let errorMessage = '';
            if (!username) {
                errorMessage = 'No se proporcionó un nombre de usuario válido.';
            } else if (!registeredProfile) {
                errorMessage = 'Usuario no registrado para esta sesión. Por favor, regístrate en el menú principal.';
            } else if (registeredProfile.username.toLowerCase() !== normalizedUsername) {
                errorMessage = `El usuario "${username}" no coincide con el perfil registrado para esta sesión.`;
            } else if (isUsernameTakenByAnotherSocket) {
                errorMessage = `El nombre de usuario "${username}" ya está en uso por otra sesión activa. Tu sesión anterior ha sido cerrada.`;
                // Desconectar la sesión antigua
                const oldSocket = io.sockets.sockets.get(usernameToSocketId[normalizedUsername]);
                if (oldSocket) {
                    oldSocket.emit('admissionError', 'Tu sesión ha sido cerrada porque te conectaste desde otra ubicación.');
                    oldSocket.disconnect(true);
                }
            }
            console.warn(`[JOIN_LOBBY] Admisión denegada para ${username || 'N/A'} (Socket ID: ${socket.id}). Motivo: ${errorMessage}`);
            socket.emit('admissionError', errorMessage); // Enviar error al cliente del menú
            return; // Detener el procesamiento
        }

        // Si la validación es exitosa, se considera que el usuario puede entrar al lobby
        // Aquí no se necesita actualizar la posición inicial, eso lo hará el cliente del lobby
        // al cargar el mundo 3D y emitir su posición inicial (si es que aún lo necesita).

        // Enviar al cliente que la admisión fue exitosa (esto redirigirá el cliente a multiplayer_lobby_server.html)
        socket.emit('admissionSuccess'); // Este evento es escuchado por multiplayer_menu.html para redirigir
        console.log(`[JOIN_LOBBY] Admisión exitosa al Lobby Global para ${username} (Socket ID: ${socket.id}).`);

        // A esta altura, el cliente del menú redirigirá a multiplayer_lobby_server.html.
        // Cuando multiplayer_lobby_server.html se cargue, establecerá su propio socket de nuevo
        // y el servidor gestionará su presencia en la sala a través del flujo normal de 'playerMoved'.
    });

    // --- NUEVO OYENTE CRÍTICO PARA EL LOBBY 3D ---
    // Cuando el cliente del lobby (multiplayer_lobby_server.html) se conecta y envía sus datos iniciales.
    socket.on('playerConnectedWithUser', (playerData) => {
        const { id, username, bio, position, rotation, pitchRotation, flashlightOn, playerAnimationState } = playerData;
        const normalizedUsername = username.toLowerCase();

        console.log(`[LOBBY_CONNECT] Recepción de datos iniciales del jugador en Lobby: "${username}" (Socket ID: ${socket.id}).`);

        // 1. Encontrar el perfil de usuario asociado a este username, sin importar el socket.id
        let associatedUserProfile = null;
        let oldSocketIdForUsername = null; // Almacenará el socket.id si encontramos el username en un socket antiguo
        for (const sId in userProfiles) {
            if (userProfiles[sId].username.toLowerCase() === normalizedUsername) {
                associatedUserProfile = userProfiles[sId];
                oldSocketIdForUsername = sId;
                break;
            }
        }
        
        // 2. Si no se encuentra un perfil para este username (indicando acceso directo sin pasar por menú)
        if (!associatedUserProfile) {
            const errorMessage = "No autorizado. Accede desde el menú principal para registrarte o iniciar sesión.";
            console.warn(`[LOBBY_CONNECT] Acceso denegado para ${username || 'N/A'} (Socket ID: ${socket.id}). Motivo: ${errorMessage}`);
            socket.emit('admissionError', errorMessage); // Enviar error al cliente del lobby
            socket.disconnect(true); // Desconectar al cliente no autorizado
            return;
        }

        // 3. Limpiar cualquier registro antiguo del mismo username y transferir el perfil al nuevo socket.id del lobby
        if (oldSocketIdForUsername && oldSocketIdForUsername !== socket.id) {
            console.log(`[LOBBY_CONNECT] Transfiriendo perfil de usuario para "${username}" de antiguo socket ${oldSocketIdForUsername} a nuevo socket ${socket.id}.`);
            // Limpiar datos asociados al socket antiguo (del menú)
            delete userProfiles[oldSocketIdForUsername];
            delete players[oldSocketIdForUsername]; // Asegurarse de que no queden datos de juego antiguos
            // No desconectamos el socket antiguo aquí, ya que es el del menú y podría haberse desconectado o no ser relevante.
        }

        // Actualizar userProfiles y usernameToSocketId para asociar el perfil con el NUEVO socket.id del lobby
        userProfiles[socket.id] = associatedUserProfile; // El perfil completo ahora está ligado a este nuevo socket.id
        usernameToSocketId[normalizedUsername] = socket.id; // Actualizar el mapeo de username a socket ID al nuevo

        // Si la validación es exitosa para el lobby, actualizar los datos del jugador en 'players'
        players[socket.id] = {
            position: position,
            rotation: rotation,
            pitchRotation: pitchRotation,
            flashlightOn: flashlightOn,
            playerAnimationState: playerAnimationState,
            username: username // Asegurar que el username se guarda en 'players'
        };

        // Enviar al cliente del lobby la señal para iniciar el juego 3D
        socket.emit('admissionSuccess');
        console.log(`[LOBBY_CONNECT] Admisión exitosa al juego 3D para ${username} (Socket ID: ${socket.id}).`);

        // Enviar a todos los clientes (incluyendo el recién conectado) los jugadores actuales
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
        io.emit('currentPlayers', currentPlayersData); // Emitir a TODOS los clientes activos

        // Emitir a todos los demás clientes (excepto al recién conectado) que un nuevo jugador se ha unido
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
        if (!userProfiles[socket.id]) { // Ignorar movimientos si el usuario no está registrado/validado
            console.warn(`[PLAYER_MOVED] Movimiento ignorado para socket ${socket.id}: Usuario no validado para juego.`);
            return; 
        }

        // Asegurarse de que playerData tenga un ID de socket.
        // Si el cliente no lo envía (lo cual no debería pasar con el código actual), añadirlo.
        playerData.id = socket.id;

        if (players[socket.id]) {
            players[socket.id].position = playerData.position;
            players[socket.id].rotation = playerData.rotation;
            players[socket.id].pitchRotation = playerData.pitchRotation;
            players[socket.id].flashlightOn = playerData.flashlightOn;
            players[socket.id].playerAnimationState = playerData.playerAnimationState;
            players[socket.id].username = userProfiles[socket.id].username; // Asegurar que el username venga del perfil registrado

            // Combinar datos de juego con datos de perfil para enviar al resto
            const dataToSend = { 
                id: socket.id, 
                ...players[socket.id], 
                username: userProfiles[socket.id].username,
                bio: userProfiles[socket.id].bio || '' 
            };
            socket.broadcast.emit('playerMoved', dataToSend);
        } else {
             // Este es un caso donde el jugador no estaba en el objeto 'players' pero está moviéndose.
             // Podría pasar si se reconecta al lobby sin pasar por el flujo completo de validación.
             // Aquí se puede añadir una lógica para inicializarlo, pero idealmente, debería pasar por 'joinGlobalLobby'
             // o ser añadido por 'currentPlayers' después de que se cargue la página del lobby.
             console.warn(`[PLAYER_MOVED] Jugador ${socket.id} intentó moverse pero no está en el objeto 'players'. Re-inicializando.`);
             players[socket.id] = {
                position: playerData.position,
                rotation: playerData.rotation,
                pitchRotation: playerData.pitchRotation,
                flashlightOn: playerData.flashlightOn,
                playerAnimationState: playerData.playerAnimationState,
                username: userProfiles[socket.id].username || 'Desconocido'
             };
             // Después de re-inicializar, emitir a todos para que sepan que este jugador "apareció"
             const dataToSend = { 
                id: socket.id, 
                ...players[socket.id], 
                username: userProfiles[socket.id].username,
                bio: userProfiles[socket.id].bio || '' 
            };
            io.emit('playerMoved', dataToSend); // Usar io.emit para que lo reciba también el remitente
        }
    });

    // Cuando un jugador envía un mensaje de chat
    socket.on('chatMessage', (data) => {
        if (!userProfiles[socket.id]) { // Ignorar chat si el usuario no está registrado/validado
            console.warn(`[CHAT] Mensaje de chat ignorado para socket ${socket.id}: Usuario no validado.`);
            return;
        }
        const senderName = userProfiles[socket.id].username; // Usar el nombre del perfil registrado
        console.log(`[CHAT] Mensaje de chat de ${senderName} (${socket.id}): ${data.text}`);
        io.emit('chatMessage', { senderId: socket.id, senderName: senderName, text: data.text });
    });

    // Manejo de desconexión
    socket.on('disconnect', () => {
        console.log('[DISCONNECT] Un usuario se ha desconectado:', socket.id);

        let disconnectedUsername = 'Anónimo';
        const userProfile = userProfiles[socket.id];
        if (userProfile) {
            disconnectedUsername = userProfile.username;
            const normalizedUsername = userProfile.username.toLowerCase();
            
            delete userProfiles[socket.id]; // Elimina el perfil del usuario
            if (usernameToSocketId[normalizedUsername] === socket.id) {
                delete usernameToSocketId[normalizedUsername]; // Elimina el mapeo si este era el socket activo
            }
        }
        
        if (players[socket.id]) {
            delete players[socket.id]; // Elimina los datos de juego
        }
        
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
