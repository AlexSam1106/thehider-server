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

// Este servidor SOLO manejará las conexiones de Socket.IO.
// No hay rutas de Express para servir archivos estáticos aquí.

// players ahora almacenará el estado completo de CADA USUARIO, indexado por su userId (persistente)
// Ejemplo: { 'userId1': { username: 'Player1', bio: '...', menuSocketId: 'socketIdMenu1', gameSocketId: 'socketIdGame1', roomId: 'room123', position: {...}, ... } }
const players = {}; 

// socketIdMap para mapear rápidamente socket.id a userId
// Ejemplo: { 'socketIdMenu1': 'userId1', 'socketIdGame1': 'userId1' }
const socketIdMap = {};

// rooms almacenará el estado de las salas
// rooms[roomId].players ahora será un OBJETO (mapa) indexado por userId, conteniendo REFERENCIAS a los objetos de 'players'
// SOLO los usuarios con un gameSocketId ACTIVO se considerarán "en juego" para el conteo.
// Ejemplo: { 'room123': { id: 'room123', name: 'Sala de Prueba', hostUserId: 'userId1', hostUsername: 'Player1', players: { 'userId1': playerObjectRef, 'userId2': playerObjectRef }, maxPlayers: 6, status: 'waiting' } }
const rooms = {};

// Función para generar un ID único para las salas
function generateRoomId() {
    return Math.random().toString(36).substring(2, 9); // Genera una cadena alfanumérica corta
}

// Función para generar un ID de usuario único (simple, para propósitos de ejemplo)
function generateUserId() {
    return 'user_' + Math.random().toString(36).substring(2, 9);
}

// Función para obtener una lista de salas para enviar a los clientes (para el menú)
function getPublicRoomList() {
    console.log("[SERVER] Generando lista de salas públicas...");
    const publicRooms = [];
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const activeGamePlayersInRoom = Object.values(room.players).filter(p => p.gameSocketId && io.sockets.sockets.has(p.gameSocketId)).length;

        publicRooms.push({
            id: room.id,
            name: room.name,
            hostUserId: room.hostUserId, // Incluir el ID del host (el userId que la creó)
            hostUsername: room.hostUsername, // Incluir el nombre de usuario del host
            currentPlayers: activeGamePlayersInRoom, // Contar SOLO los jugadores 3D activos
            maxPlayers: room.maxPlayers,
            status: room.status // 'waiting', 'playing', 'full'
        });
    }
    console.log("[SERVER] Lista de salas generada:", publicRooms.length, "salas.");
    return publicRooms;
}

// Función para limpiar una sala y notificar a los jugadores
function cleanupRoom(roomId, message = 'La sala ha sido cerrada.') {
    const room = rooms[roomId];
    if (room) {
        console.log(`[SERVER] Limpiando sala ${room.name} (${roomId}). Mensaje: ${message}`);
        // Notificar a todos los jugadores en la sala que se cerró (si tienen un gameSocketId activo en la sala)
        for (const userId in room.players) {
            const player = room.players[userId];
            if (player.gameSocketId && io.sockets.sockets.has(player.gameSocketId)) {
                const playerSocket = io.sockets.sockets.get(player.gameSocketId);
                playerSocket.leave(roomId); // Sacar de la room de Socket.IO
                playerSocket.emit('roomClosed', { roomId: roomId, message: message });
            }
            // Limpiar roomId en el objeto player global
            player.roomId = null; 
        }

        delete rooms[roomId]; // Eliminar la sala del objeto 'rooms'
        console.log(`[SERVER] Sala ${roomId} eliminada.`);
        io.emit('updateRoomList', getPublicRoomList()); // Actualizar la lista de salas globalmente
    }
}


io.on('connection', (socket) => {
    console.log(`[CONEXIÓN] Un usuario se ha conectado: ${socket.id}`);

    // En el momento de la conexión, no sabemos el userId todavía.
    // Lo asociamos al socket.id temporalmente o esperamos el evento 'initConnection'.

    // --- ENVIAR LISTA DE SALAS INICIAL AL CLIENTE QUE SE CONECTA ---
    socket.emit('updateRoomList', getPublicRoomList()); 
    console.log(`[LOBBY] Lista de salas inicial enviada a nuevo cliente ${socket.id}.`);

    // --- INICIALIZACIÓN DE LA CONEXIÓN CON UN USER_ID ---
    // Este evento es CRUCIAL para asociar un socket.id con un userId persistente.
    socket.on('initConnection', (data) => {
        let { userId, username, bio, isGameClient } = data;

        if (!userId) {
            userId = generateUserId(); // Genera un nuevo userId si no se proporciona (primera vez o localStorage vacío)
            console.log(`[INIT] Generado nuevo userId: ${userId} para socket: ${socket.id}`);
        } else {
            console.log(`[INIT] Conexión inicializada con userId existente: ${userId} para socket: ${socket.id}`);
        }

        // Mapea el socket.id al userId
        socketIdMap[socket.id] = userId;

        // Si el usuario no existe en 'players', créalo
        if (!players[userId]) {
            players[userId] = {
                id: userId,
                username: username || userId.substring(0,6), // Usa el username proporcionado o un default
                bio: bio || "",
                menuSocketId: null, // Socket.id del cliente del menú
                gameSocketId: null, // Socket.id del cliente del juego 3D
                roomId: null, // ID de la sala actual del usuario
                position: { x: 0, y: 0.27, z: 0 }, 
                rotation: 0, 
                pitchRotation: 0, 
                flashlightOn: true, 
                playerAnimationState: 'idle'
            };
        }

        // Actualiza el socket.id correspondiente (menú o juego)
        if (isGameClient) {
            players[userId].gameSocketId = socket.id;
        } else {
            players[userId].menuSocketId = socket.id;
        }
        
        // Asigna propiedades al socket para fácil acceso
        socket.userId = userId;
        socket.username = players[userId].username; // Usamos el username del objeto players
        socket.isGameClient = isGameClient; // Para saber qué tipo de cliente es este socket
        socket.roomId = players[userId].roomId; // Carga el roomId actual del jugador

        // Envía el userId de vuelta al cliente si fue generado o para confirmación
        socket.emit('connectionInitialized', { userId: userId, username: players[userId].username, bio: players[userId].bio });
        console.log(`[INIT] Socket ${socket.id} asociado a userId ${userId}. Tipo: ${isGameClient ? 'Juego' : 'Menú'}`);

        // Si el usuario ya estaba en una sala (e.g., reconexión), y es un cliente de juego, haz que se una a la sala de Socket.IO
        if (socket.isGameClient && socket.roomId && rooms[socket.roomId]) {
            socket.join(socket.roomId);
            console.log(`[INIT] Cliente de juego ${socket.username} (${socket.id}) reconectado y unido a sala de Socket.IO: ${socket.roomId}`);
            const room = rooms[socket.roomId];
            
            // Notificar a los demás jugadores en la sala sobre la reconexión de este jugador de juego
            const playersInCurrentRoom = {};
            for (const uId in room.players) {
                // Envía una COPIA del objeto, no la referencia directa.
                playersInCurrentRoom[uId] = { ...room.players[uId], id: room.players[uId].gameSocketId }; // Enviar el gameSocketId como 'id'
            }
            socket.emit('currentPlayers', playersInCurrentRoom);
            socket.to(socket.roomId).emit('playerConnected', { id: socket.id, ...players[userId] }); // Enviar el objeto completo del jugador
        }
        io.emit('updateRoomList', getPublicRoomList());
    });

    // --- Manejo del registro de usuario desde la página del menú ---
    socket.on('registerUser', (userData) => {
        const { userId, username, bio } = userData; // Ahora recibimos userId también
        console.log(`[REGISTRO] Usuario '${username}' (${userId} / ${socket.id}) intentando registrarse.`);

        if (!players[userId]) {
            console.log(`[REGISTRO FALLIDO] userId ${userId} no inicializado para registro.`);
            socket.emit('roomError', { message: 'Error de inicialización de usuario. Por favor, recarga la página.' });
            return;
        }

        // Valida si el nombre de usuario ya está en uso por otro *usuario* (no solo socket)
        const usernameExists = Object.values(players).some(p => p.id !== userId && p.username === username);

        if (usernameExists) {
            console.log(`[REGISTRO FALLIDO] Nombre de usuario '${username}' ya existe.`);
            socket.emit('usernameExists', { username: username });
        } else {
            // Actualiza los datos del jugador para este userId
            players[userId].username = username;
            players[userId].bio = bio;
            socket.username = username; // Actualiza también el username en el socket (si aplica)

            console.log(`[REGISTRO EXITOSO] Usuario '${username}' registrado con éxito para ID: ${userId}.`);
            socket.emit('usernameRegistered', { username: username, bio: bio, userId: userId });

            // Envía la lista de salas actualizada a todos los clientes (especialmente al menú)
            io.emit('updateRoomList', getPublicRoomList());
            console.log(`[LOBBY] Lista de salas actualizada emitida a todos los clientes después de registro.`);
        }
    });

    // --- Manejo de la creación de salas (desde el menú) ---
    socket.on('createRoom', (roomData) => {
        const { roomName, maxPlayers } = roomData;
        const creatorUserId = socket.userId; // Usamos el userId
        const creatorSocketId = socket.id; // Guardamos el socket.id del menú que creó la sala

        if (!creatorUserId || !players[creatorUserId] || !players[creatorUserId].username) {
            console.log(`[CREAR SALA FALLIDO] Creador no registrado o sin nombre: ${creatorUserId}`);
            socket.emit('roomError', { message: 'Debes registrar un perfil de usuario primero.' });
            return;
        }

        const creatorUsername = players[creatorUserId].username;

        // Comprobar si el jugador ya está en una sala (a nivel de userId)
        if (players[creatorUserId].roomId) {
            console.log(`[CREAR SALA FALLIDO] Jugador ${creatorUsername} ya está en la sala ${players[creatorUserId].roomId}.`);
            socket.emit('roomError', { message: 'Ya estás en una sala. Abandónala para crear una nueva.' });
            return;
        }

        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            name: roomName,
            hostUserId: creatorUserId, // Host es el userId del usuario que creó la sala
            hostMenuSocketId: creatorSocketId, // Guardamos el socket.id del menú para verificar la conexión del host
            hostUsername: creatorUsername, 
            players: {}, // Vacío inicialmente, se llenará con usuarios (userIds)
            maxPlayers: maxPlayers,
            status: 'waiting' // Estado inicial de la sala
        };

        // Asocia el roomId al userId del creador
        players[creatorUserId].roomId = roomId; 
        socket.roomId = roomId; // También en el socket para fácil acceso

        console.log(`[SALA CREADA] Sala '${roomName}' (ID: ${roomId}) creada por ${creatorUsername} (userId: ${creatorUserId}).`);
        socket.emit('roomCreated', { roomId: roomId, roomName: roomName });

        // Envía la lista de salas actualizada a todos los clientes
        io.emit('updateRoomList', getPublicRoomList());
        console.log(`[LOBBY] Lista de salas actualizada después de creación de '${roomName}'.`);
    });

    // --- Manejo de unirse a una sala (desde el menú) ---
    socket.on('joinRoom', (data) => {
        const { roomId } = data;
        const joiningUserId = socket.userId; // Usamos userId
        const joiningMenuSocketId = socket.id; // El socket del menú que pide unirse

        if (!joiningUserId || !players[joiningUserId] || !players[joiningUserId].username) {
            console.log(`[UNIRSE SALA MENU FALLIDO] Jugador no inicializado o sin nombre: ${joiningUserId}`);
            socket.emit('roomError', { message: 'Debes registrar un perfil de usuario primero.' });
            return;
        }

        const joiningPlayerUsername = players[joiningUserId].username;
        console.log(`[UNIRSE SALA MENU] Jugador '${joiningPlayerUsername}' (userId: ${joiningUserId}) intentando unirse a sala ${roomId}.`);

        // Si el jugador ya está en una sala diferente, lo "saca" lógicamente
        if (players[joiningUserId].roomId && players[joiningUserId].roomId !== roomId) {
            const oldRoomId = players[joiningUserId].roomId;
            const oldRoom = rooms[oldRoomId];

            if (oldRoom) {
                // Si el jugador saliente tenía un cliente de juego 3D activo en la sala antigua, lo quita
                if (players[joiningUserId].gameSocketId && oldRoom.players[joiningUserId]) {
                    const gameSocket = io.sockets.sockets.get(players[joiningUserId].gameSocketId);
                    if (gameSocket) {
                        gameSocket.leave(oldRoomId);
                        gameSocket.emit('roomClosed', { roomId: oldRoomId, message: `Has sido movido a la sala ${roomId}.` });
                    }
                    delete oldRoom.players[joiningUserId];
                    io.to(oldRoomId).emit('playerLeftRoom', { socketId: players[joiningUserId].gameSocketId, username: joiningPlayerUsername });
                    console.log(`[SALA] Cliente de juego ${joiningPlayerUsername} dejó la sala ${oldRoom.name} (${oldRoomId}).`);
                } else {
                    console.log(`[SALA] Cliente de menú ${joiningPlayerUsername} dejó la sala ${oldRoom.name} (${oldRoomId}).`);
                }
                
                // Lógica para reasignar host o limpiar sala si el host del MENÚ se va
                if (oldRoom.hostUserId === joiningUserId) { // Si el que se va era el host de la sala
                    console.log(`[SALA] Host del menú (${joiningPlayerUsername}) de sala ${oldRoom.name} (${oldRoomId}) se va.`);
                    // Mantenemos la sala SOLO si hay clientes de juego 3D activos O si el nuevo host es un cliente 3D
                    const activeGamePlayersInOldRoom = Object.values(oldRoom.players).filter(p => p.gameSocketId && io.sockets.sockets.has(p.gameSocketId));

                    if (activeGamePlayersInOldRoom.length > 0) {
                        const newHostPlayer = activeGamePlayersInOldRoom[0];
                        oldRoom.hostUserId = newHostPlayer.id; // Asigna el userId del primer cliente 3D restante como nuevo host
                        oldRoom.hostUsername = newHostPlayer.username;
                        oldRoom.hostMenuSocketId = null; // Ya no hay un host de menú
                        io.to(oldRoom.id).emit('hostChanged', { newHostId: newHostPlayer.gameSocketId, newHostUsername: newHostPlayer.username }); // Notifica con el gameSocketId del nuevo host
                        console.log(`[SALA] Host de ${oldRoom.name} cambió a ${oldRoom.hostUsername} (userId: ${oldRoom.hostUserId}).`);
                    } else {
                        // Si no quedan clientes de juego 3D, y el host del menú se va, limpiar la sala.
                        cleanupRoom(oldRoomId, `El anfitrión original (${joiningPlayerUsername}) ha abandonado la sala.`);
                    }
                } else {
                    // Si un NO-host de menú se va, y no quedan clientes de juego 3D, verificar la sala
                     const activeGamePlayersInOldRoom = Object.values(oldRoom.players).filter(p => p.gameSocketId && io.sockets.sockets.has(p.gameSocketId)).length;
                     const hostMenuSocketActive = players[oldRoom.hostUserId] && players[oldRoom.hostUserId].menuSocketId && io.sockets.sockets.has(players[oldRoom.hostUserId].menuSocketId);

                    if (activeGamePlayersInOldRoom === 0 && !hostMenuSocketActive) {
                        cleanupRoom(oldRoomId, `No quedan jugadores activos ni host de menú en la sala.`);
                    }
                }
            }
        }

        const room = rooms[roomId];

        if (!room) {
            console.log(`[UNIRSE SALA MENU FALLIDO] Sala ${roomId} no encontrada.`);
            socket.emit('roomError', { message: `La sala '${roomId}' no existe.` });
            return;
        }

        const activeGamePlayersInTargetRoom = Object.values(room.players).filter(p => p.gameSocketId && io.sockets.sockets.has(p.gameSocketId)).length;
        if (activeGamePlayersInTargetRoom >= room.maxPlayers) {
            console.log(`[UNIRSE SALA MENU FALLIDO] Sala ${roomId} está llena.`);
            socket.emit('roomError', { message: `La sala '${room.name}' está llena.` });
            return;
        }
        
        // Actualiza el roomId del jugador en el objeto global 'players' y en el socket
        players[joiningUserId].roomId = roomId; 
        socket.roomId = roomId;

        console.log(`[SALA UNIDA MENU] Jugador '${joiningPlayerUsername}' está ahora en la sala '${room.name}' (ID: ${roomId}) a nivel de menú.`);
        
        // Envía la confirmación al jugador que se unió, incluyendo la lista de jugadores de la sala
        // Para el menú, queremos los usernames y si tienen cliente 3D conectado
        const playersInRoomForMenu = Object.values(room.players).map(p => ({ 
            id: p.id, 
            username: p.username, 
            isGameClientActive: p.gameSocketId && io.sockets.sockets.has(p.gameSocketId) 
        }));

        socket.emit('roomJoined', { 
            roomId: roomId, 
            roomName: room.name, 
            playersInRoom: playersInRoomForMenu
        }); 

        // Notifica a los demás clientes del menú sobre la lista actualizada
        io.emit('updateRoomList', getPublicRoomList());
        console.log(`[LOBBY] Lista de salas actualizada después de que ${joiningPlayerUsername} se uniera a '${room.name}'.`);
    });

    // --- Manejo de la eliminación de salas por el anfitrión ---
    socket.on('deleteRoom', (data) => {
        const { roomId } = data;
        const deleterUserId = socket.userId;

        console.log(`[ELIMINAR SALA] Jugador ${deleterUserId} intentando eliminar sala ${roomId}.`);

        const room = rooms[roomId];

        if (!room) {
            console.log(`[ELIMINAR SALA FALLIDO] Sala ${roomId} no encontrada para eliminar.`);
            socket.emit('roomError', { message: 'La sala que intentas eliminar no existe.' });
            return;
        }

        // El host de la sala es el userId del usuario que la creó
        if (room.hostUserId !== deleterUserId) {
            console.log(`[ELIMINAR SALA FALLIDO] Jugador ${deleterUserId} no es el anfitrión de la sala ${roomId}.`);
            socket.emit('roomError', { message: 'Solo el anfitrión puede eliminar esta sala.' });
            return;
        }

        // Llama a la función de limpieza para cerrar la sala
        cleanupRoom(roomId, `La sala '${room.name}' fue eliminada por el anfitrión.`);

        // updateRoomList ya se llama dentro de cleanupRoom
    });

    // --- EVENTO: Cuando el cliente 3D indica que se ha unido a una sala ---
    socket.on('gameJoinRoom', (data) => {
        const { userId, username, roomId } = data; // Ahora recibimos userId

        if (!userId || !players[userId]) {
            console.warn(`[SERVER] Cliente 3D - userId ${userId} no inicializado para gameJoinRoom. Socket: ${socket.id}`);
            socket.emit('roomClosed', { roomId: roomId, message: `Error de inicialización de usuario. Por favor, recarga la página.` });
            return;
        }

        // Asegurarse de que este socket esté marcado como gameSocket y actualizar el userId en el socket
        socket.userId = userId;
        socket.isGameClient = true;
        players[userId].gameSocketId = socket.id; // Actualiza el gameSocketId del usuario
        players[userId].menuSocketId = players[userId].menuSocketId || null; // Asegura que el menuSocketId no se borre
        socketIdMap[socket.id] = userId; // Asegura que el mapeo inverso exista

        console.log(`[SERVER] Cliente 3D - Jugador ${username} (userId: ${userId}, socket.id: ${socket.id}) intentando confirmar unión a sala: ${roomId}`);

        const player = players[userId]; // Obtiene la referencia al objeto del jugador
        
        // 1. Asegúrate de que la sala exista Y que el jugador tiene el roomId correcto
        if (!roomId || !rooms[roomId] || player.roomId !== roomId) {
            console.warn(`[SERVER] Cliente 3D - Sala ${roomId} no encontrada o inválida para ${username} (userId: ${userId}). O jugador en sala incorrecta. Redirigiendo a menú.`);
            socket.emit('roomClosed', { roomId: roomId, message: `La sala '${roomId}' no existe o ha sido cerrada, o te has unido a otra sala.` });
            // Asegúrate de limpiar el roomId del jugador si la sala no existe
            player.roomId = null;
            socket.roomId = null;
            return; 
        }

        const room = rooms[roomId]; // Referencia a la sala

        // 2. Si el jugador ya estaba en otra sala de Socket.IO con este gameSocketId, sácalo.
        // Esto cubre casos donde un jugador cambia de sala directamente en el juego sin pasar por el menú
        if (socket.rooms.has(socket.roomId) && socket.roomId !== roomId) {
             socket.leave(socket.roomId);
             console.log(`[SALA] Cliente de juego ${username} (ID: ${socket.id}) dejó la sala de Socket.IO ${socket.roomId}.`);
        }

        // 3. Une el socket a la sala de Socket.IO (framework).
        socket.join(roomId);
        player.roomId = roomId; 
        socket.roomId = roomId; // Para fácil acceso en otros eventos
        socket.username = username; // Para fácil acceso en el chat

        // 4. Añade el jugador al mapa de `players` de la sala (por referencia al userId)
        if (!room.players[userId]) {
            room.players[userId] = player; // Añade la referencia al objeto completo del jugador
            console.log(`[SERVER] Jugador ${username} (userId: ${userId}) añadido a room.players de sala ${roomId}.`);
        } else {
            console.log(`[SERVER] Jugador ${username} (userId: ${userId}) ya estaba en room.players de sala ${roomId}. Actualizando.`);
        }
        
        room.lastActivity = Date.now(); // Actualiza actividad de la sala

        console.log(`[SERVER] Cliente 3D - Jugador ${username} (userId: ${userId}, socket.id: ${socket.id}) CONFIRMADO en sala ${roomId}. Jugadores en sala (contando 3D activos): ${Object.values(room.players).filter(p => p.gameSocketId && io.sockets.sockets.has(p.gameSocketId)).length}`);
        
        // 5. Enviar todos los jugadores (con sus gameSocketIds como 'id') de esta sala al cliente que se acaba de unir
        const playersInCurrentRoom = {};
        for (const uId in room.players) {
            const p = room.players[uId];
            if (p.gameSocketId && io.sockets.sockets.has(p.gameSocketId)) { // Solo si tienen un gameSocketId activo
                playersInCurrentRoom[p.gameSocketId] = { // Indexamos por el gameSocketId
                    id: p.gameSocketId, // El ID que el cliente 3D usará
                    username: p.username,
                    position: p.position,
                    rotation: p.rotation,
                    pitchRotation: p.pitchRotation,
                    flashlightOn: p.flashlightOn,
                    playerAnimationState: p.playerAnimationState
                };
            }
        }
        socket.emit('currentPlayers', playersInCurrentRoom);
        console.log(`[SERVER] currentPlayers enviados a ${username} en sala ${roomId}: ${Object.keys(playersInCurrentRoom).length} jugadores.`);

        // 6. Notificar a los otros jugadores en la sala sobre el nuevo jugador
        // Enviamos el gameSocketId del nuevo jugador como 'id'
        socket.to(roomId).emit('playerConnected', { id: socket.id, ...player }); 
        console.log(`[SERVER] playerConnected emitido a sala ${roomId} por ${username}.`);
        
        // 7. Actualizar la lista de salas para todos los clientes (menú y otros juegos)
        io.emit('updateRoomList', getPublicRoomList());
        console.log(`[LOBBY] Lista de salas actualizada globalmente.`);
    });

    // Cuando un jugador se mueve, las actualizaciones se emiten SOLO a los de la misma sala
    socket.on('playerMoved', (playerData) => {
        const userId = socket.userId;
        if (!userId || !players[userId]) return;

        // Verificar que el jugador esté asociado a una sala a través de su userId y que esté en el mapa de players de la sala
        if (players[userId].roomId && rooms[players[userId].roomId] && rooms[players[userId].roomId].players[userId]) { 
            const currentRoom = rooms[players[userId].roomId];
            const currentPlayer = players[userId]; // Referencia al objeto global del jugador
            
            // Actualiza los datos del jugador
            currentPlayer.position = playerData.position;
            currentPlayer.rotation = playerData.rotation;
            currentPlayer.pitchRotation = playerData.pitchRotation;
            currentPlayer.flashlightOn = playerData.flashlightOn;
            currentPlayer.playerAnimationState = playerData.playerAnimationState;

            currentRoom.lastActivity = Date.now(); // Actualiza la actividad de la sala

            // Emite la actualización de movimiento SÓLO a los demás jugadores en la misma sala
            // Enviamos el gameSocketId del jugador como 'id'
            socket.broadcast.to(currentRoom.id).emit('playerMoved', { id: socket.id, ...currentPlayer }); 
        } else {
            console.log(`[MOVIMIENTO IGNORADO] Jugador ${userId} intentó moverse sin estar en una sala válida o no encontrado.`);
        }
    });

    // Cuando un jugador envía un mensaje de chat, ahora se envía solo a la sala actual
    socket.on('chatMessage', (message) => {
        const userId = socket.userId;
        if (!userId || !players[userId]) return;

        if (players[userId].roomId && rooms[players[userId].roomId] && players[userId].username) {
            const senderUsername = players[userId].username;
            console.log(`[CHAT EN SALA] Mensaje de ${senderUsername} (userId: ${userId}, socket.id: ${socket.id}) en sala ${players[userId].roomId}: ${message}`);
            // Envía el mensaje a todos los clientes en la misma sala, incluyendo el remitente
            io.to(players[userId].roomId).emit('chatMessage', { senderId: senderUsername, text: message });
            rooms[players[userId].roomId].lastActivity = Date.now(); // Actualiza la actividad de la sala
        } else {
            console.warn(`[CHAT IGNORADO] Mensaje de ${socket.id} sin estar en una sala o sin username.`);
        }
    });

    // Cuando un jugador se desconecta
    socket.on('disconnect', () => {
        console.log(`[DESCONEXIÓN] Un usuario se ha desconectado: ${socket.id}`);
        const disconnectedUserId = socketIdMap[socket.id];

        if (!disconnectedUserId || !players[disconnectedUserId]) {
            console.log(`[DESCONEXIÓN IGNORADA] Socket ${socket.id} no asociado a un userId o usuario ya eliminado.`);
            // Eliminar del mapeo si por alguna razón no se limpió antes
            delete socketIdMap[socket.id];
            return;
        }

        const disconnectedPlayer = players[disconnectedUserId];
        const disconnectedUsername = disconnectedPlayer.username;
        const disconnectedRoomId = disconnectedPlayer.roomId; // Obtener roomId del objeto global del jugador
        const wasGameClient = (disconnectedPlayer.gameSocketId === socket.id);
        const wasMenuClient = (disconnectedPlayer.menuSocketId === socket.id);

        // Limpiar el socket.id específico de la conexión que se fue
        if (wasGameClient) {
            disconnectedPlayer.gameSocketId = null;
            console.log(`[DESCONEXIÓN] Game client socket ${socket.id} de ${disconnectedUsername} (userId: ${disconnectedUserId}) desconectado.`);
        }
        if (wasMenuClient) {
            disconnectedPlayer.menuSocketId = null;
            console.log(`[DESCONEXIÓN] Menu client socket ${socket.id} de ${disconnectedUsername} (userId: ${disconnectedUserId}) desconectado.`);
        }

        // Eliminar del mapeo de socket.id a userId
        delete socketIdMap[socket.id];

        if (disconnectedRoomId && rooms[disconnectedRoomId]) {
            const room = rooms[disconnectedRoomId];

            // 1. Manejo de la desconexión de un CLIENTE DE JUEGO 3D
            if (wasGameClient) {
                // Notificar a otros jugadores en la sala que este game client se desconectó
                socket.to(disconnectedRoomId).emit('playerDisconnected', socket.id);
                console.log(`[SALA] Cliente de juego ${disconnectedUsername} (socket.id: ${socket.id}) notificando desconexión en sala ${room.name} (${disconnectedRoomId}).`);
                room.lastActivity = Date.now(); 

                // Si el gameSocketId que se desconectó era el host (reasignado)
                if (room.hostUserId === disconnectedUserId && disconnectedPlayer.gameSocketId === null) { // Si el host actual era este userId y ya no tiene gameSocket
                    console.log(`[SALA HOST DESCONECTADO - CLIENTE 3D] El host de juego ${disconnectedUsername} de la sala ${room.name} (${disconnectedRoomId}) se desconectó.`);
                    const activeGamePlayersInRoom = Object.values(room.players).filter(p => p.gameSocketId && io.sockets.sockets.has(p.gameSocketId));
                    const menuHostActive = (disconnectedPlayer.menuSocketId && io.sockets.sockets.has(disconnectedPlayer.menuSocketId)) || (room.hostMenuSocketId && io.sockets.sockets.has(room.hostMenuSocketId) && players[room.hostUserId].menuSocketId === room.hostMenuSocketId);
                    
                    if (activeGamePlayersInRoom.length > 0) {
                        const newHostPlayer = activeGamePlayersInRoom[0];
                        room.hostUserId = newHostPlayer.id; // Asigna el userId del nuevo host
                        room.hostUsername = newHostPlayer.username;
                        // room.hostMenuSocketId podría seguir siendo el original si es que existe y está conectado
                        io.to(disconnectedRoomId).emit('hostChanged', { newHostId: newHostPlayer.gameSocketId, newHostUsername: newHostPlayer.username });
                        console.log(`[SALA] Nuevo host de ${room.name} es: ${room.hostUsername} (userId: ${room.hostUserId}).`);
                    } else if (menuHostActive) {
                        console.log(`[SALA] Sala ${room.name} (${disconnectedRoomId}) sin clientes 3D, pero host de menú ${room.hostUsername} sigue activo. Sala persiste.`);
                    } else {
                        cleanupRoom(disconnectedRoomId, 'Todos los jugadores de juego se desconectaron y el anfitrión del menú no está activo.');
                    }
                }
            }

            // 2. Manejo de la desconexión de un CLIENTE DE MENÚ
            if (wasMenuClient) {
                // Si el socket desconectado era el host ORIGINAL de la sala (el del menú que la creó)
                if (room.hostUserId === disconnectedUserId && room.hostMenuSocketId === socket.id) {
                    console.log(`[SALA HOST DESCONECTADO - CLIENTE MENU] El host original ${disconnectedUsername} de la sala ${room.name} (${disconnectedRoomId}) se desconectó.`);
                    // Ahora la lógica es que la sala solo debe cerrarse si NO quedan clientes 3D activos
                    const activeGamePlayersInRoom = Object.values(room.players).filter(p => p.gameSocketId && io.sockets.sockets.has(p.gameSocketId));
                    if (activeGamePlayersInRoom.length === 0) {
                        cleanupRoom(disconnectedRoomId, 'El anfitrión original de la sala se ha desconectado y no quedan jugadores de juego.');
                    } else {
                        console.log(`[SALA] Sala ${room.name} (${disconnectedRoomId}) persiste. El host del menú se desconectó, pero quedan ${activeGamePlayersInRoom.length} clientes de juego.`);
                        // Opcional: Reasignar host del menú si hay otro cliente de menú del mismo userId conectado
                        // O simplemente la sala continua con el host 3D (si se reasignó)
                        room.hostMenuSocketId = null; // Limpiar el socket ID del host del menú
                    }
                } else {
                    console.log(`[LOBBY] Cliente de menú ${disconnectedUsername} desconectado (no era host original).`);
                }
            }

            // Lógica final de limpieza de la sala: solo si no hay ningún cliente (ni menú ni juego) para el host original
            // Y no hay clientes de juego activos en la sala.
            const hostUser = players[room.hostUserId];
            const hostMenuSocketActive = hostUser && hostUser.menuSocketId && io.sockets.sockets.has(hostUser.menuSocketId);
            const activeGamePlayersInRoom = Object.values(room.players).filter(p => p.gameSocketId && io.sockets.sockets.has(p.gameSocketId));

            if (!hostMenuSocketActive && activeGamePlayersInRoom.length === 0) {
                 cleanupRoom(disconnectedRoomId, 'No quedan usuarios (menú o juego) asociados al anfitrión o jugadores de juego en la sala.');
            }
        }

        // Si el usuario ya no tiene ningún socket activo (ni menú ni juego) y no está en ninguna sala, lo podemos eliminar del objeto players
        if (disconnectedPlayer && !disconnectedPlayer.menuSocketId && !disconnectedPlayer.gameSocketId && !disconnectedPlayer.roomId) {
            console.log(`[DESCONEXIÓN] Eliminando usuario ${disconnectedUsername} (userId: ${disconnectedUserId}) del registro global.`);
            delete players[disconnectedUserId];
        }

        // Siempre actualiza la lista de salas después de cualquier desconexión que pueda afectar el conteo
        io.emit('updateRoomList', getPublicRoomList());
        console.log(`[LOBBY] Lista de salas actualizada después de la desconexión de ${disconnectedUsername}.`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
});
