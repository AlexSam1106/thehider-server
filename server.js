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
const userProfiles = {}; // Almacena el perfil completo del usuario { socket.id: { username, bio, connectedAt, sessionToken } }
// Para un mapeo rápido de username a socket.id para verificación de unicidad de sesión
const usernameToSocketId = {}; // { normalizedUsername: socket.id }
// Nuevo mapeo para sessionToken a socket.id, esencial para re-asociar perfiles.
const sessionTokenToSocketId = {}; // { sessionToken: socket.id }

// Función para generar un token de sesión simple (para esta demo)
// En un entorno de producción, usarías UUIDs más seguros o JWTs.
function generateSessionToken() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}


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

        let currentSessionToken = null;
        // Si el usuario ya está registrado en *este* socket (ej. refrescó la página y volvió a registrarse), mantén su token.
        if (userProfiles[socket.id] && userProfiles[socket.id].username.toLowerCase() === normalizedUsername) {
            userProfiles[socket.id].bio = bio; // Actualiza la bio
            currentSessionToken = userProfiles[socket.id].sessionToken; // Recupera el token existente
            console.log(`[REGISTER] Perfil existente para "${username}" (Socket ID: ${socket.id}) actualizado.`);
        } else {
            // Nuevo registro para este socket. Genera un nuevo token de sesión.
            currentSessionToken = generateSessionToken();
            userProfiles[socket.id] = { username, bio, connectedAt: new Date().toISOString(), sessionToken: currentSessionToken };
            console.log(`[REGISTER] Nuevo perfil para "${username}" (Socket ID: ${socket.id}) creado con token: ${currentSessionToken.substring(0,8)}...`);
        }
        
        // Actualiza los mapeos para el socket actual
        usernameToSocketId[normalizedUsername] = socket.id;
        sessionTokenToSocketId[currentSessionToken] = socket.id;

        // Inicializa/actualiza los datos del jugador en el objeto 'players' (importante para el estado del juego)
        players[socket.id] = players[socket.id] || {
            position: { x: 0, y: 0.27, z: 0 },
            rotation: 0,
            pitchRotation: 0,
            flashlightOn: true,
            playerAnimationState: 'idle'
        };
        players[socket.id].username = username; // Asegura que el objeto players también tenga el username

        // Envía el token de sesión en la respuesta
        socket.emit('usernameValidationResponse', { success: true, message: '¡Perfil guardado correctamente!', userData: userProfiles[socket.id] });
        updateAndEmitRoomStats();
        updateAndEmitServerStats();
    });

    // --- Manejo de reconexión de usuario (desde multiplayer_menu.html) ---
    // Esto ocurre si el usuario ya tenía un perfil y actualiza el menú
    socket.on('userReconnected', (data) => {
        const { username, bio, sessionToken } = data; // Recibe el sessionToken
        const normalizedUsername = username.toLowerCase();

        console.log(`[RECONNECT_MENU] Usuario "${username}" (Token: ${sessionToken ? sessionToken.substring(0,8) + '...' : 'N/A'}) intentando reconectar desde menú (Socket ID: ${socket.id}).`);

        // Si el token de sesión ya está mapeado a un ID de socket *diferente* y activo, desconecta la sesión antigua.
        if (sessionToken && sessionTokenToSocketId[sessionToken] && sessionTokenToSocketId[sessionToken] !== socket.id) {
            const oldSocketId = sessionTokenToSocketId[sessionToken];
            console.log(`[RECONNECT_MENU] Token ${sessionToken.substring(0,8)}... estaba previamente conectado con socket ID ${oldSocketId}. Desconectando sesión antigua.`);
            const oldSocket = io.sockets.sockets.get(oldSocketId);
            if (oldSocket) {
                oldSocket.emit('admissionError', 'Te has conectado desde otra ubicación. Tu sesión anterior ha sido cerrada.');
                oldSocket.disconnect(true); // Desconecta forzosamente la sesión antigua
            }
            // Los datos del perfil y del jugador antiguos serán limpiados por el manejador de desconexión del socket antiguo.
        }
        
        // Asocia el perfil de usuario con el nuevo socket.id del menú
        userProfiles[socket.id] = userProfiles[socket.id] || {};
        userProfiles[socket.id].username = username;
        userProfiles[socket.id].bio = bio;
        userProfiles[socket.id].connectedAt = new Date().toISOString();
        userProfiles[socket.id].sessionToken = sessionToken || generateSessionToken(); // Usa el token existente o genera uno nuevo

        // Actualiza los mapeos al nuevo socket.id
        usernameToSocketId[normalizedUsername] = socket.id;
        sessionTokenToSocketId[userProfiles[socket.id].sessionToken] = socket.id;

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
        const { username, sessionToken } = data; // Recibe el sessionToken
        const normalizedUsername = username.toLowerCase();

        console.log(`[JOIN_LOBBY] Solicitud de unión a Lobby Global de "${username}" (Token: ${sessionToken ? sessionToken.substring(0,8) + '...' : 'N/A'}) (Socket ID: ${socket.id}).`);

        // Verifica que el socket actual esté asociado con el perfil de usuario Y que el sessionToken coincida.
        const registeredProfile = userProfiles[socket.id];
        const isSessionValidForThisSocket = registeredProfile 
                                         && registeredProfile.username.toLowerCase() === normalizedUsername
                                         && registeredProfile.sessionToken === sessionToken;

        if (!username || !sessionToken || !isSessionValidForThisSocket) {
            let errorMessage = 'No autorizado. Accede desde el menú principal para registrarte o iniciar sesión con una sesión válida.';
            console.warn(`[JOIN_LOBBY] Admisión denegada para ${username || 'N/A'} (Socket ID: ${socket.id}). Motivo: ${errorMessage}`);
            socket.emit('admissionError', errorMessage); // Envía el error al cliente del menú
            return; // Detiene el procesamiento
        }

        // Si la validación es exitosa, envía la señal al cliente para redirigir
        socket.emit('admissionSuccess'); // Este evento es escuchado por multiplayer_menu.html para la redirección
        console.log(`[JOIN_LOBBY] Admisión exitosa al Lobby Global para ${username} (Socket ID: ${socket.id}). Cliente redirigiendo...`);
    });

    // --- OYENTE CRÍTICO PARA EL LOBBY 3D: Maneja la conexión desde multiplayer_lobby_server.html ---
    socket.on('playerConnectedWithUser', (playerData) => {
        const { username, bio, sessionToken, position, rotation, pitchRotation, flashlightOn, playerAnimationState } = playerData;
        const normalizedUsername = username.toLowerCase();

        console.log(`[LOBBY_INIT] Nuevo socket del lobby conectado: "${username}" (Token: ${sessionToken ? sessionToken.substring(0,8) + '...' : 'N/A'}) (Socket ID: ${socket.id}).`);

        // Primero, intentar encontrar el perfil usando el sessionToken recibido.
        let associatedUserProfile = null;
        let oldSocketIdForSessionToken = null;

        if (sessionToken && sessionTokenToSocketId[sessionToken]) {
            oldSocketIdForSessionToken = sessionTokenToSocketId[sessionToken];
            associatedUserProfile = userProfiles[oldSocketIdForSessionToken];
            
            // Si el token está mapeado a un socket diferente al actual, significa que el usuario ha redirigido.
            // Transferir la sesión.
            if (oldSocketIdForSessionToken !== socket.id) {
                console.log(`[LOBBY_INIT] Transfiriendo perfil para "${username}" (Token: ${sessionToken.substring(0,8)}...) de socket ${oldSocketIdForSessionToken} a nuevo socket ${socket.id}.`);
                
                // Limpia los datos del socket antiguo, ya que esta nueva conexión lo reemplaza.
                // Es importante que esto sea una limpieza, no un borrado global del token.
                if (userProfiles[oldSocketIdForSessionToken]) {
                    delete userProfiles[oldSocketIdForSessionToken];
                }
                if (players[oldSocketIdForSessionToken]) {
                    delete players[oldSocketIdForSessionToken];
                }
                // Desconecta el socket antiguo si sigue activo (importante para evitar fantasmas)
                const oldSocket = io.sockets.sockets.get(oldSocketIdForSessionToken);
                if (oldSocket) {
                    oldSocket.emit('admissionError', 'Tu sesión ha sido transferida a una nueva ventana de juego. Si esta no eres tú, por favor, reconecta.');
                    oldSocket.disconnect(true);
                }
            } else {
                console.log(`[LOBBY_INIT] Usuario "${username}" ya mapeado a este mismo socket (${socket.id}) con token ${sessionToken.substring(0,8)}.... Re-inicializando.`);
            }
        }

        // Si después de la lógica de transferencia no hay un perfil asociado al token, o el username no coincide
        if (!sessionToken || !associatedUserProfile || associatedUserProfile.username.toLowerCase() !== normalizedUsername) {
            const errorMessage = "No autorizado. Accede desde el menú principal para registrarte o iniciar sesión con una sesión válida.";
            console.warn(`[LOBBY_INIT] Acceso denegado para "${username}" (Token: ${sessionToken ? sessionToken.substring(0,8) + '...' : 'N/A'}) (Socket ID: ${socket.id}). Motivo: ${errorMessage}`);
            socket.emit('admissionError', errorMessage);
            socket.disconnect(true); // Desconecta al cliente no autorizado
            return;
        }

        // Si llegamos aquí, el token y el perfil son válidos. Asocia el perfil al nuevo socket.id.
        userProfiles[socket.id] = associatedUserProfile;
        if (bio) userProfiles[socket.id].bio = bio; 
        userProfiles[socket.id].connectedAt = new Date().toISOString(); 

        // Actualiza los mapeos globales para que apunten a este nuevo socket.id.
        usernameToSocketId[normalizedUsername] = socket.id;
        sessionTokenToSocketId[sessionToken] = socket.id; // ¡Esta es la clave! Ahora el token apunta al nuevo socket.

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
            const sessionToken = userProfile.sessionToken;
            
            // NOTA CLAVE: YA NO ELIMINAMOS usernameToSocketId ni sessionTokenToSocketId aquí.
            // Esa gestión se hace en playerConnectedWithUser cuando un nuevo socket reclama el token.
            // Solo limpiaremos si realmente NO hay otro socket usando este token.
            // Pero para simplificar y asegurar la transición, simplemente borramos los datos específicos de este socket.
            // El mapeo de token se actualizará cuando el NUEVO socket del lobby se conecte.
            
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

        // Update stats based on what's left in the maps (which are managed by playerConnectedWithUser for session bridging)
        updateAndEmitRoomStats(); 
        updateAndEmitServerStats(); 
    });

    // Para cuando el usuario cierra la sesión desde el cliente (restablece el perfil)
    socket.on('userLoggedOut', () => {
        if (userProfiles[socket.id]) {
            const usernameToClear = userProfiles[socket.id].username.toLowerCase();
            const sessionTokenToClear = userProfiles[socket.id].sessionToken;

            delete userProfiles[socket.id];
            
            // Aquí sí borramos los mapeos, porque el usuario está indicando un cierre de sesión definitivo.
            if (usernameToSocketId[usernameToClear] === socket.id) {
                 delete usernameToSocketId[usernameToClear];
                 console.log(`[LOGOUT] Mapeo de usuario "${usernameToClear}" eliminado por logout.`);
            }
            if (sessionTokenToClear && sessionTokenToSocketId[sessionTokenToClear] === socket.id) {
                 delete sessionTokenToSocketId[sessionTokenToClear];
                 console.log(`[LOGOUT] Mapeo de token "${sessionTokenToClear.substring(0,8)}..." eliminado por logout.`);
            }
            console.log(`[LOGOUT] Usuario ${usernameToClear} (Token: ${sessionTokenToClear ? sessionTokenToClear.substring(0,8) + '...' : 'N/A'}) ha cerrado sesión.`);
            updateAndEmitRoomStats();
            updateAndEmitServerStats();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
});
