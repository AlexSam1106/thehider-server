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

    // players almacenará el estado completo de CADA socket conectado (tanto menú como juego), indexado por su socket.id
    // Ejemplo: { 'socketId1': { username: 'Player1', bio: '...', position: {...}, roomId: 'room123', isGameClient: true, isConnectedToMenu: false, ... } }
    const players = {}; 

    // rooms almacenará el estado de las salas, incluyendo los jugadores actualmente en ellas
    // rooms[roomId].players ahora será un OBJETO (mapa) indexado por socket.id, conteniendo REFERENCIAS a los objetos de 'players'
    // SOLO los sockets del JUEGO 3D se añadirán a este mapa.
    // Ejemplo: { 'room123': { id: 'room123', name: 'Sala de Prueba', hostId: 'socketIdMenu1', hostUsername: 'Player1', players: { 'socketIdGame1': playerObjectRef, 'socketIdGame2': playerObjectRef }, maxPlayers: 6, status: 'waiting' } }
    const rooms = {};

    // Función para generar un ID único para las salas
    function generateRoomId() {
        return Math.random().toString(36).substring(2, 9); // Genera una cadena alfanumérica corta
    }

    // Función para obtener una lista de salas para enviar a los clientes (para el menú)
    function getPublicRoomList() {
        console.log("[SERVER] Generando lista de salas públicas...");
        const publicRooms = [];
        for (const roomId in rooms) {
            const room = rooms[roomId];
            publicRooms.push({
                id: room.id,
                name: room.name,
                hostId: room.hostId,         // Incluir el ID del host (el socket del menú que la creó)
                hostUsername: room.hostUsername, // Incluir el nombre de usuario del host
                currentPlayers: Object.keys(room.players).length, // Contar SOLO los jugadores del juego 3D
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
            // Notificar a todos los jugadores en la sala que se cerró
            io.to(roomId).emit('roomClosed', { roomId: roomId, message: message });

            // Sacar a todos los jugadores de la sala de Socket.IO y limpiar su estado
            for (const playerSocketId in room.players) {
                const playerSocket = io.sockets.sockets.get(playerSocketId);
                if (playerSocket) {
                    playerSocket.leave(roomId); // Sacar de la room de Socket.IO
                    // Limpiar roomId y username en el socket si todavía existe la conexión
                    delete playerSocket.roomId;
                    delete playerSocket.username;
                    // Marcar como no cliente de juego si estaba en players
                    if (players[playerSocketId]) {
                        players[playerSocketId].isGameClient = false;
                        players[playerSocketId].roomId = null; // Quitar al jugador de la sala
                    }
                }
            }
            delete rooms[roomId]; // Eliminar la sala del objeto 'rooms'
            console.log(`[SERVER] Sala ${roomId} eliminada.`);
        }
    }


    io.on('connection', (socket) => {
        console.log(`[CONEXIÓN] Un usuario se ha conectado: ${socket.id}`);

        // Inicializa una entrada para el nuevo socket
        players[socket.id] = {
            username: socket.id.substring(0, 6), // Default username (temp)
            bio: "",
            position: { x: 0, y: 0.27, z: 0 }, 
            rotation: 0, 
            pitchRotation: 0, 
            flashlightOn: true, 
            playerAnimationState: 'idle',
            roomId: null, // No está en ninguna sala al principio
            isGameClient: false, // Indica si es un cliente de juego 3D o solo del menú
            isConnectedToMenu: true // Nuevo: Si este socket está conectado al menú principal
        };
        socket.username = players[socket.id].username; // Para fácil acceso
        socket.roomId = null; // Para fácil acceso

        // --- ENVIAR LISTA DE SALAS INICIAL AL CLIENTE QUE SE CONECTA ---
        socket.emit('updateRoomList', getPublicRoomList()); 
        console.log(`[LOBBY] Lista de salas inicial enviada a nuevo cliente ${socket.id}.`);

        // --- Manejo del registro de usuario desde la página del menú ---
        socket.on('registerUser', (userData) => {
            const { username, bio } = userData;
            console.log(`[REGISTRO] Usuario '${username}' (${socket.id}) intentando registrarse.`);

            // Valida si el nombre de usuario ya está en uso por otro *socket activo*
            const usernameExists = Object.values(players).some(p => p.username === username && p.id !== socket.id); // Check against other active sockets

            if (usernameExists) {
                console.log(`[REGISTRO FALLIDO] Nombre de usuario '${username}' ya existe.`);
                socket.emit('usernameExists', { username: username });
            } else {
                // Actualiza los datos del jugador para este socket
                players[socket.id].username = username;
                players[socket.id].bio = bio;
                socket.username = username; // Actualiza también el username en el socket

                console.log(`[REGISTRO EXITOSO] Usuario '${username}' registrado con éxito para ID: ${socket.id}.`);
                socket.emit('usernameRegistered', { username: username, bio: bio });

                // Envía la lista de salas actualizada a todos los clientes (especialmente al menú)
                io.emit('updateRoomList', getPublicRoomList());
                console.log(`[LOBBY] Lista de salas actualizada emitida a todos los clientes después de registro.`);
            }
        });

        // --- Manejo de la creación de salas (desde el menú) ---
        socket.on('createRoom', (roomData) => {
            const { roomName, maxPlayers } = roomData;
            const creatorId = socket.id;
            const creatorUsername = players[creatorId] ? players[creatorId].username : 'Desconocido';

            if (!players[creatorId] || !players[creatorId].username) {
                console.log(`[CREAR SALA FALLIDO] Creador no registrado o sin nombre: ${creatorId}`);
                socket.emit('roomError', { message: 'Debes registrar un perfil de usuario primero.' });
                return;
            }

            // Comprobar si el jugador ya está en una sala (menú o juego)
            if (players[creatorId].roomId) {
                console.log(`[CREAR SALA FALLIDO] Jugador ${creatorUsername} ya está en la sala ${players[creatorId].roomId}.`);
                socket.emit('roomError', { message: 'Ya estás en una sala. Abandónala para crear una nueva.' });
                return;
            }

            const roomId = generateRoomId();
            rooms[roomId] = {
                id: roomId,
                name: roomName,
                hostId: creatorId, // Host es el socket del menú que creó la sala
                hostUsername: creatorUsername, 
                players: {}, // **INICIALMENTE VACÍO:** Solo los clientes 3D se añadirán aquí
                maxPlayers: maxPlayers,
                status: 'waiting' // Estado inicial de la sala
            };

            // El socket del menú NO se une a la sala a nivel de framework ni se añade a room.players aquí
            // Solo se actualiza su roomId en el objeto global 'players'
            players[creatorId].roomId = roomId; 
            socket.roomId = roomId; // Referencia en el socket

            console.log(`[SALA CREADA] Sala '${roomName}' (ID: ${roomId}) creada por ${creatorUsername}.`);
            socket.emit('roomCreated', { roomId: roomId, roomName: roomName });

            // Envía la lista de salas actualizada a todos los clientes (para que el menú la vea)
            io.emit('updateRoomList', getPublicRoomList());
            console.log(`[LOBBY] Lista de salas actualizada después de creación de '${roomName}'.`);
        });

        // --- Manejo de unirse a una sala (desde el menú) ---
        socket.on('joinRoom', (data) => {
            const { roomId } = data;
            const joiningPlayerId = socket.id;
            const joiningPlayerUsername = players[joiningPlayerId] ? players[joiningPlayerId].username : 'Desconocido';

            console.log(`[UNIRSE SALA MENU] Jugador '${joiningPlayerUsername}' (${joiningPlayerId}) intentando unirse a sala ${roomId}.`);

            if (!players[joiningPlayerId] || !players[joiningPlayerId].username) {
                console.log(`[UNIRSE SALA MENU FALLIDO] Jugador no registrado o sin nombre: ${joiningPlayerId}`);
                socket.emit('roomError', { message: 'Debes registrar un perfil de usuario primero.' });
                return;
            }
            
            // Si el jugador ya está en una sala, lo saca de ella antes de unirse a una nueva
            if (players[joiningPlayerId].roomId && players[joiningPlayerId].roomId !== roomId) {
                const oldRoomId = players[joiningPlayerId].roomId;
                const oldRoom = rooms[oldRoomId];
                if (oldRoom) {
                    // Si el jugador saliente era un cliente de juego 3D, quítalo de la sala.players
                    if (players[joiningPlayerId].isGameClient && oldRoom.players[joiningPlayerId]) {
                        delete oldRoom.players[joiningPlayerId]; 
                        socket.leave(oldRoomId); // Saca el socket del framework
                        socket.to(oldRoomId).emit('playerLeftRoom', { socketId: joiningPlayerId, username: joiningPlayerUsername });
                        console.log(`[SALA] Cliente de juego ${joiningPlayerUsername} dejó la sala ${oldRoom.name} (${oldRoomId}).`);
                    } else {
                        // Si solo era un cliente de menú, solo actualiza su roomId
                        console.log(`[SALA] Cliente de menú ${joiningPlayerUsername} dejó la sala ${oldRoom.name} (${oldRoomId}).`);
                    }
                   
                    // Lógica para el host y limpieza de sala si queda vacía DE CLIENTES 3D
                    // PERO NO SE CIERRA SI EL HOST DE MENÚ SIGUE CONECTADO
                    if (Object.keys(oldRoom.players).length === 0) { // Si no quedan clientes 3D en la sala
                        const hostMenuSocket = io.sockets.sockets.get(oldRoom.hostId);
                        if (!hostMenuSocket || !players[oldRoom.hostId] || !players[oldRoom.hostId].isConnectedToMenu) {
                            // Si el host del menú no está conectado, o ya no es un socket de menú, entonces limpiar la sala
                            cleanupRoom(oldRoomId, 'El anfitrión del menú se desconectó o no quedan jugadores.');
                        } else {
                            // Si no hay jugadores 3D pero el host del menú sigue conectado, la sala persiste.
                            console.log(`[SALA] Sala ${oldRoom.name} (${oldRoomId}) sin clientes 3D, pero host de menú ${oldRoom.hostUsername} sigue activo. Sala persiste.`);
                        }
                    } else if (oldRoom.hostId === joiningPlayerId && !players[joiningPlayerId].isGameClient) { // Si el que se va era el host (socket del menú)
                         // Si el host del menú se va (pero NO es un cliente 3D), la sala debe cerrarse.
                        cleanupRoom(oldRoomId, 'El anfitrión ha abandonado la sala desde el menú.');
                    } else if (oldRoom.hostId === joiningPlayerId && players[joiningPlayerId].isGameClient) {
                        // Si el host era un cliente 3D y se va, reasignar host (a otro cliente 3D si existe)
                        const remainingPlayersIds = Object.keys(oldRoom.players); // Estos son socket IDs de clientes 3D
                        if (remainingPlayersIds.length > 0) {
                            const newHostId = remainingPlayersIds[0]; // ID del primer cliente 3D
                            oldRoom.hostId = newHostId; // Asigna el primer cliente 3D restante como nuevo host
                            oldRoom.hostUsername = players[newHostId] ? players[newHostId].username : 'Desconocido';
                            io.to(oldRoomId).emit('hostChanged', { newHostId: oldRoom.hostId, newHostUsername: oldRoom.hostUsername });
                            console.log(`[SALA] Host de ${oldRoom.name} cambió a ${oldRoom.hostUsername}.`);
                        } else {
                            // Si no quedan clientes 3D, verificar el host de menú.
                            const hostMenuSocket = io.sockets.sockets.get(oldRoom.hostId);
                            if (!hostMenuSocket || !players[oldRoom.hostId] || !players[oldRoom.hostId].isConnectedToMenu) {
                                cleanupRoom(oldRoomId, 'El anfitrión del menú se desconectó o no quedan jugadores.');
                            } else {
                                console.log(`[SALA] Sala ${oldRoom.name} (${oldRoomId}) sin clientes 3D, pero host de menú ${oldRoom.hostUsername} sigue activo. Sala persiste.`);
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

                if (Object.keys(room.players).length >= room.maxPlayers) {
                    console.log(`[UNIRSE SALA MENU FALLIDO] Sala ${roomId} está llena.`);
                    socket.emit('roomError', { message: `La sala '${room.name}' está llena.` });
                    return;
                }
                
                // Actualiza el roomId del jugador en el objeto global 'players' y en el socket
                players[joiningPlayerId].roomId = roomId; 
                socket.roomId = roomId;

                // El cliente del menú NO se une a la sala de Socket.IO aquí, ni se añade a room.players.
                // Esto ocurrirá cuando el cliente 3D se conecte con 'gameJoinRoom'.

                console.log(`[SALA UNIDA MENU] Jugador '${joiningPlayerUsername}' está ahora en la sala '${room.name}' (ID: ${roomId}) a nivel de menú.`);
                
                // Envía la confirmación al jugador que se unió, incluyendo la lista de jugadores de la sala
                const playersInRoomArray = Object.values(room.players); // Clientes 3D actuales en la sala
                socket.emit('roomJoined', { 
                    roomId: roomId, 
                    roomName: room.name, 
                    playersInRoom: playersInRoomArray.map(p => ({ id: p.id, username: p.username })) 
                }); 

                // Notifica a los demás clientes del menú sobre la lista actualizada
                io.emit('updateRoomList', getPublicRoomList());
                console.log(`[LOBBY] Lista de salas actualizada después de que ${joiningPlayerUsername} se uniera a '${room.name}'.`);
            });

            // --- Manejo de la eliminación de salas por el anfitrión ---
            socket.on('deleteRoom', (data) => {
                const { roomId } = data;
                const deleterId = socket.id;

                console.log(`[ELIMINAR SALA] Jugador ${deleterId} intentando eliminar sala ${roomId}.`);

                const room = rooms[roomId];

                if (!room) {
                    console.log(`[ELIMINAR SALA FALLIDO] Sala ${roomId} no encontrada para eliminar.`);
                    socket.emit('roomError', { message: 'La sala que intentas eliminar no existe.' });
                    return;
                }

                // El host de la sala es el socket del MENÚ que la creó, no un cliente 3D.
                if (room.hostId !== deleterId) {
                    console.log(`[ELIMINAR SALA FALLIDO] Jugador ${deleterId} no es el anfitrión de la sala ${roomId}.`);
                    socket.emit('roomError', { message: 'Solo el anfitrión puede eliminar esta sala.' });
                    return;
                }

                // Llama a la función de limpieza para cerrar la sala
                cleanupRoom(roomId, `La sala '${room.name}' fue eliminada por el anfitrión.`);

                // Envía la lista de salas actualizada a todos los clientes
                io.emit('updateRoomList', getPublicRoomList());
                console.log(`[LOBBY] Lista de salas actualizada después de eliminar sala ${roomId}.`);
            });

            // --- EVENTO: Cuando el cliente 3D indica que se ha unido a una sala ---
            socket.on('gameJoinRoom', (data) => {
                const { username, roomId } = data;
                console.log(`[SERVER] Cliente 3D - Jugador ${username} (ID: ${socket.id}) intentando confirmar unión a sala: ${roomId}`);

                // 1. Actualiza el objeto `players` global para este socket.
                // Esto es crucial si el jugador recargó la página del juego directamente
                // sin pasar por el menú, o si hubo un reinicio del servidor.
                if (!players[socket.id]) {
                     players[socket.id] = {
                        username: username,
                        bio: "", 
                        position: { x: 0, y: 0.27, z: 0 }, 
                        rotation: 0, 
                        pitchRotation: 0, 
                        flashlightOn: true, 
                        playerAnimationState: 'idle',
                        roomId: null, // Se actualizará en breve
                        isGameClient: true, // ¡Ahora es un cliente de juego!
                        isConnectedToMenu: false // Este socket NO está conectado al menú principal
                    };
                    console.log(`[SERVER] Jugador ${username} (ID: ${socket.id}) creado/registrado al entrar al juego 3D.`);
                } else {
                    // Si ya está registrado (p.ej., del menú), actualiza sus datos y lo marca como cliente de juego
                    players[socket.id].username = username;
                    players[socket.id].isGameClient = true;
                    players[socket.id].isConnectedToMenu = false; // Asegura que no se considere un socket de menú
                    // También reinicia la posición si es la primera vez que se une a esta sala en esta sesión
                    if (players[socket.id].roomId !== roomId) {
                        players[socket.id].position = { x: 0, y: 0.27, z: 0 };
                        players[socket.id].rotation = 0;
                        players[socket.id].pitchRotation = 0;
                    }
                    console.log(`[SERVER] Jugador ${username} (ID: ${socket.id}) actualizado a cliente de juego 3D.`);
                }

                const player = players[socket.id]; // Obtiene la referencia al objeto del jugador
                
                // 2. Asegúrate de que la sala exista.
                if (!roomId || !rooms[roomId]) {
                    console.warn(`[SERVER] Cliente 3D - Sala ${roomId} no encontrada o inválida para ${username}. Redirigiendo a menú.`);
                    socket.emit('roomClosed', { roomId: roomId, message: `La sala '${roomId}' no existe o ha sido cerrada.` });
                    return; 
                }

                const room = rooms[roomId]; // Referencia a la sala

                // 3. Si el jugador ya estaba en otra sala, lo saca de ella primero.
                if (player.roomId && player.roomId !== roomId) {
                    const oldRoom = rooms[player.roomId];
                    if (oldRoom) {
                        if (oldRoom.players[socket.id]) { // Asegura que solo elimine si era un cliente de juego en la anterior
                            delete oldRoom.players[socket.id]; 
                            socket.leave(player.roomId);
                            console.log(`[SALA] Jugador ${player.username} dejó la sala ${oldRoom.name} (${player.roomId}).`);
                            io.to(player.roomId).emit('playerLeftRoom', { socketId: socket.id, username: player.username });

                            // Lógica de limpieza para la sala antigua después de que este cliente 3D la deja
                            if (Object.keys(oldRoom.players).length === 0) { // Si no quedan clientes 3D en la sala
                                const hostMenuSocket = io.sockets.sockets.get(oldRoom.hostId);
                                if (!hostMenuSocket || !players[oldRoom.hostId] || !players[oldRoom.hostId].isConnectedToMenu) {
                                    // Si el host del menú no está conectado, o ya no es un socket de menú, entonces limpiar la sala
                                    cleanupRoom(oldRoom.id, 'El anfitrión del menú se desconectó o no quedan jugadores.');
                                } else {
                                    console.log(`[SALA] Sala ${oldRoom.name} (${oldRoom.id}) sin clientes 3D, pero host de menú ${oldRoom.hostUsername} sigue activo. Sala persiste.`);
                                }
                            } else if (oldRoom.hostId === socket.id) { // Si el que se va era el host (del cliente 3D)
                                const remainingPlayersIds = Object.keys(oldRoom.players);
                                if (remainingPlayersIds.length > 0) {
                                    const newHostId = remainingPlayersIds[0];
                                    oldRoom.hostId = newHostId;
                                    oldRoom.hostUsername = players[remainingPlayersIds[0]] ? players[remainingPlayersIds[0]].username : 'Desconocido';
                                    io.to(oldRoom.id).emit('hostChanged', { newHostId: oldRoom.hostId, newHostUsername: oldRoom.hostUsername });
                                    console.log(`[SALA] Host de ${oldRoom.name} cambió a ${oldRoom.hostUsername}.`);
                                } else {
                                    const hostMenuSocket = io.sockets.sockets.get(oldRoom.hostId);
                                    if (!hostMenuSocket || !players[oldRoom.hostId] || !players[oldRoom.hostId].isConnectedToMenu) {
                                        cleanupRoom(oldRoom.id, 'El anfitrión del menú se desconectó o no quedan jugadores.');
                                    } else {
                                        console.log(`[SALA] Sala ${oldRoom.name} (${oldRoom.id}) sin clientes 3D, pero host de menú ${oldRoom.hostUsername} sigue activo. Sala persiste.`);
                                    }
                                }
                            }
                        }
                    }
                }

                // 4. Une el socket a la sala de Socket.IO (framework) y actualiza el estado del jugador.
                socket.join(roomId);
                player.roomId = roomId; 
                socket.roomId = roomId; // Para fácil acceso en otros eventos
                socket.username = username; // Para fácil acceso en el chat

                // 5. Añade el jugador al mapa de `players` de la sala (por referencia)
                if (!room.players[socket.id]) {
                    room.players[socket.id] = player; // Añade la referencia al objeto completo del jugador
                    console.log(`[SERVER] Jugador ${username} añadido a room.players de sala ${roomId}.`);
                } else {
                    console.log(`[SERVER] Jugador ${username} ya estaba en room.players de sala ${roomId}. Actualizando.`);
                }
                
                room.lastActivity = Date.now(); // Actualiza actividad de la sala

                console.log(`[SERVER] Cliente 3D - Jugador ${username} (ID: ${socket.id}) CONFIRMADO en sala ${roomId}. Jugadores en sala: ${Object.keys(room.players).length}`);
                
                // 6. Enviar todos los jugadores de esta sala al cliente que se acaba de unir
                const playersInCurrentRoom = {};
                for (const pId in room.players) {
                    // Envía una COPIA del objeto, no la referencia directa para evitar modificaciones inesperadas del cliente.
                    playersInCurrentRoom[pId] = { ...room.players[pId] }; 
                }
                socket.emit('currentPlayers', playersInCurrentRoom);
                console.log(`[SERVER] currentPlayers enviados a ${username} en sala ${roomId}: ${Object.keys(playersInCurrentRoom).length} jugadores.`);

                // 7. Notificar a los otros jugadores en la sala sobre el nuevo jugador
                socket.to(roomId).emit('playerConnected', { id: socket.id, ...player }); // Envía el objeto completo del jugador
                console.log(`[SERVER] playerConnected emitido a sala ${roomId} por ${username}.`);
                
                // 8. Actualizar la lista de salas para todos los clientes (menú y otros juegos)
                io.emit('updateRoomList', getPublicRoomList());
                console.log(`[LOBBY] Lista de salas actualizada globalmente.`);
            });

            // Cuando un jugador se mueve, las actualizaciones se emiten SOLO a los de la misma sala
            socket.on('playerMoved', (playerData) => {
                const playerId = socket.id;
                // Verificar que el jugador esté asociado a una sala a través de socket.roomId Y que esté en el mapa de players de la sala
                if (socket.roomId && rooms[socket.roomId] && rooms[socket.roomId].players[playerId]) { 
                    const currentRoom = rooms[socket.roomId];
                    const currentPlayer = players[playerId]; // Referencia al objeto global del jugador
                    
                    // Actualiza los datos del jugador
                    currentPlayer.position = playerData.position;
                    currentPlayer.rotation = playerData.rotation;
                    currentPlayer.pitchRotation = playerData.pitchRotation;
                    currentPlayer.flashlightOn = playerData.flashlightOn;
                    currentPlayer.playerAnimationState = playerData.playerAnimationState;

                    // Como room.players ahora contiene REFERENCIAS, el objeto dentro de la sala ya se actualiza.
                    currentRoom.lastActivity = Date.now(); // Actualiza la actividad de la sala

                    // Emite la actualización de movimiento SÓLO a los demás jugadores en la misma sala
                    socket.broadcast.to(socket.roomId).emit('playerMoved', { id: playerId, ...currentPlayer }); // Enviar el objeto completo
                } else {
                    console.log(`[MOVIMIENTO IGNORADO] Jugador ${playerId} intentó moverse sin estar en una sala válida o no encontrado.`);
                }
            });

            // Cuando un jugador envía un mensaje de chat, ahora se envía solo a la sala actual
            socket.on('chatMessage', (message) => {
                // Utiliza socket.username (establecido en gameJoinRoom o registerUser) y socket.roomId
                if (socket.roomId && rooms[socket.roomId] && socket.username) {
                    const senderUsername = socket.username;
                    console.log(`[CHAT EN SALA] Mensaje de ${senderUsername} (${socket.id}) en sala ${socket.roomId}: ${message}`);
                    // Envía el mensaje a todos los clientes en la misma sala, incluyendo el remitente
                    io.to(socket.roomId).emit('chatMessage', { senderId: senderUsername, text: message });
                    rooms[socket.roomId].lastActivity = Date.now(); // Actualiza la actividad de la sala
                } else {
                    console.warn(`[CHAT IGNORADO] Mensaje de ${socket.id} sin estar en una sala o sin username.`);
                }
            });

            // Cuando un jugador se desconecta
            socket.on('disconnect', () => {
                console.log(`[DESCONEXIÓN] Un usuario se ha desconectado: ${socket.id}`);
                const disconnectedUsername = players[socket.id] ? players[socket.id].username : socket.id.substring(0,4) + '...';
                const disconnectedRoomId = socket.roomId; // Obtener roomId de la propiedad del socket (si se estableció)
                const wasGameClient = players[socket.id] ? players[socket.id].isGameClient : false;
                const wasMenuClient = players[socket.id] ? players[socket.id].isConnectedToMenu : false;

                // Eliminar jugador del objeto global de players
                delete players[socket.id]; 

                if (disconnectedRoomId && rooms[disconnectedRoomId]) {
                    const room = rooms[disconnectedRoomId];

                    // 1. Manejo de la desconexión de un CLIENTE DE JUEGO 3D
                    if (wasGameClient) {
                        if (room.players[socket.id]) {
                            delete room.players[socket.id];
                            console.log(`[SALA] Cliente de juego ${disconnectedUsername} eliminado del mapa de sala ${room.name} (${disconnectedRoomId}).`);
                        }
                        socket.to(disconnectedRoomId).emit('playerDisconnected', socket.id);
                        room.lastActivity = Date.now(); // Corregido: Date.now()

                        // Reasignar host si el desconectado era el host (y era un cliente 3D)
                        if (room.hostId === socket.id) {
                            console.log(`[SALA HOST DESCONECTADO - CLIENTE 3D] El host ${disconnectedUsername} de la sala ${room.name} (${disconnectedRoomId}) se desconectó.`);
                            const remainingGameClientsIds = Object.keys(room.players);
                            if (remainingGameClientsIds.length > 0) {
                                const newHostId = remainingGameClientsIds[0];
                                room.hostId = newHostId;
                                room.hostUsername = players[newHostId] ? players[newHostId].username : 'Desconocido';
                                console.log(`[SALA] Nuevo host de ${room.name} es: ${room.hostUsername} (${newHostId}).`);
                                io.to(disconnectedRoomId).emit('hostChanged', { newHostId: room.hostId, newHostUsername: room.hostUsername });
                            } else {
                                // Si no quedan clientes 3D, y el host original del menú sigue conectado, la sala persiste.
                                const hostMenuSocket = io.sockets.sockets.get(room.hostId);
                                if (hostMenuSocket && players[room.hostId] && players[room.hostId].isConnectedToMenu) {
                                     console.log(`[SALA] Sala ${room.name} (${disconnectedRoomId}) sin clientes 3D, pero host de menú ${room.hostUsername} sigue activo. Sala persiste.`);
                                } else {
                                    cleanupRoom(disconnectedRoomId, 'El anfitrión de juego se desconectó y no quedaron más jugadores o el anfitrión del menú.');
                                }
                            }
                        }

                        // Lógica para cerrar la sala si no quedan clientes 3D Y el anfitrión del menú tampoco está conectado
                        if (Object.keys(room.players).length === 0) { // Si no quedan clientes 3D en la sala
                            const hostMenuSocket = io.sockets.sockets.get(room.hostId); // Intenta obtener el socket del host del menú
                            if (!hostMenuSocket || !players[room.hostId] || !players[room.hostId].isConnectedToMenu) {
                                // Si el host del menú no está conectado, o ya no es un socket de menú, entonces limpiar la sala
                                cleanupRoom(disconnectedRoomId, 'Todos los jugadores de juego se desconectaron y el anfitrión del menú no está activo.');
                            } else {
                                // Si no hay jugadores 3D pero el host del menú sigue conectado, la sala persiste.
                                console.log(`[SALA] Sala ${room.name} (${disconnectedRoomId}) sin clientes 3D, pero host de menú ${room.hostUsername} sigue activo. Sala persiste.`);
                            }
                        }
                    }

                    // 2. Manejo de la desconexión de un CLIENTE DE MENÚ (que podría ser el host original)
                    if (wasMenuClient && room.hostId === socket.id) {
                        // Si el socket desconectado era el host ORIGINAL de la sala (el del menú)
                        console.log(`[SALA HOST DESCONECTADO - CLIENTE MENU] El host original ${disconnectedUsername} de la sala ${room.name} (${disconnectedRoomId}) se desconectó.`);
                        cleanupRoom(disconnectedRoomId, 'El anfitrión original de la sala se ha desconectado.');
                    } else if (wasMenuClient && room.hostId !== socket.id) {
                        // Un cliente de menú que no es el host original se desconecta.
                        // Simplemente marcamos su estado en players como desconectado del menú
                        // y no hacemos nada con la sala ya que solo el host del menú la controla.
                         console.log(`[LOBBY] Cliente de menú ${disconnectedUsername} desconectado (no era host).`);
                    }
                }
                else {
                    // Si el jugador no estaba en una sala o no tenía el objeto players correctamente inicializado
                    console.log(`[LOBBY] Jugador ${disconnectedUsername} desconectado (no estaba en sala o no era cliente de juego/menú).`);
                }

                io.emit('updateRoomList', getPublicRoomList());
                console.log(`[LOBBY] Lista de salas actualizada después de la desconexión de ${disconnectedUsername}.`);
            });

            // Al desconectarse, un socket abandona automáticamente todas las salas, excepto la default (su propio ID de socket)
            // No necesitamos `socket.leave(roomId)` explícitamente en `disconnect` para la sala de Socket.IO,
            // pero sí necesitamos limpiar nuestros objetos `players` y `rooms`.
        });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
    });
