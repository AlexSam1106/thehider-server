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

        // players almacenará el estado de los jugadores, incluyendo su nombre de usuario y la sala en la que están
        // Ejemplo: { 'socketId1': { username: 'Player1', bio: '...', position: {...}, roomId: 'room123', ... } }
        const players = {}; 

        // rooms almacenará el estado de las salas
        // Ejemplo: { 'room123': { id: 'room123', name: 'Sala de Prueba', hostId: 'socketId1', hostUsername: 'Player1', players: [{ socketId: 'socketId1', username: 'Player1' }], maxPlayers: 6, status: 'waiting' } }
        const rooms = {};

        // Función para generar un ID único para las salas
        function generateRoomId() {
            return Math.random().toString(36).substring(2, 9); // Genera una cadena alfanumérica corta
        }

        // Función para obtener una lista de salas para enviar a los clientes
        function getPublicRoomList() {
            console.log("[SERVER] Generando lista de salas públicas...");
            const publicRooms = [];
            for (const roomId in rooms) {
                const room = rooms[roomId];
                publicRooms.push({
                    id: room.id,
                    name: room.name,
                    hostId: room.hostId,         // Incluir el ID del host
                    hostUsername: room.hostUsername, // Incluir el nombre de usuario del host
                    currentPlayers: room.players.length,
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

                // Sacar a todos los jugadores de la sala de Socket.IO y actualizar su estado en 'players'
                room.players.forEach(playerInRoom => {
                    const playerSocketId = playerInRoom.socketId;
                    if (players[playerSocketId]) {
                        players[playerSocketId].roomId = null; // Quitar al jugador de la sala
                    }
                    const playerSocket = io.sockets.sockets.get(playerSocketId);
                    if (playerSocket) {
                        playerSocket.leave(roomId); // Sacar de la room de Socket.IO
                    }
                });
                delete rooms[roomId]; // Eliminar la sala del objeto 'rooms'
                console.log(`[SERVER] Sala ${roomId} eliminada.`);
            }
        }


        io.on('connection', (socket) => {
            console.log(`[CONEXIÓN] Un usuario se ha conectado: ${socket.id}`);

            // --- ENVIAR LISTA DE SALAS INICIAL AL CLIENTE QUE SE CONECTA ---
            socket.emit('updateRoomList', getPublicRoomList()); 
            console.log(`[LOBBY] Lista de salas inicial enviada a nuevo cliente ${socket.id}.`);

            // --- Manejo del registro de usuario desde la página del menú ---
            socket.on('registerUser', (userData) => {
                const { username, bio } = userData;
                console.log(`[REGISTRO] Usuario '${username}' (${socket.id}) intentando registrarse.`);

                // Verifica si el nombre de usuario ya está en uso por algún jugador conectado
                const usernameExists = Object.values(players).some(p => p.username === username);

                if (usernameExists) {
                    console.log(`[REGISTRO FALLIDO] Nombre de usuario '${username}' ya existe.`);
                    socket.emit('usernameExists', { username: username });
                } else {
                    // Si el nombre de usuario es único, lo registra
                    players[socket.id] = {
                        username: username, // Almacena el nombre de usuario
                        bio: bio, // Almacena la bio
                        position: { x: 0, y: 0.27, z: 0 }, 
                        rotation: 0, 
                        pitchRotation: 0, 
                        flashlightOn: true, 
                        playerAnimationState: 'idle',
                        roomId: null // El jugador aún no está en ninguna sala
                    };
                    console.log(`[REGISTRO EXITOSO] Usuario '${username}' registrado con éxito para ID: ${socket.id}`);
                    socket.emit('usernameRegistered', { username: username, bio: bio });

                    // Envía la lista de salas actualizada a todos los clientes (especialmente al menú)
                    // Esto es redundante para el cliente que acaba de registrarse si ya recibió la inicial,
                    // pero asegura que todos los demás clientes también se actualicen si el registro
                    // cambia métricas como "jugadores conectados" que puedan estar en getPublicRoomList.
                    io.emit('updateRoomList', getPublicRoomList());
                    console.log(`[LOBBY] Lista de salas actualizada emitida a todos los clientes después de registro.`);
                }
            });

            // --- Manejo de la creación de salas ---
            socket.on('createRoom', (roomData) => {
                const { roomName, maxPlayers } = roomData;
                const creatorId = socket.id;
                const creatorUsername = players[creatorId] ? players[creatorId].username : 'Desconocido';

                if (!players[creatorId]) {
                    console.log(`[CREAR SALA FALLIDO] Creador no registrado: ${creatorId}`);
                    socket.emit('roomError', { message: 'Debes registrar un perfil de usuario primero.' });
                    return;
                }

                // Comprobar si el jugador ya está en una sala
                if (players[creatorId].roomId) {
                    console.log(`[CREAR SALA FALLIDO] Jugador ${creatorUsername} ya está en la sala ${players[creatorId].roomId}.`);
                    socket.emit('roomError', { message: 'Ya estás en una sala. Abandónala para crear una nueva.' });
                    return;
                }

                const roomId = generateRoomId();
                rooms[roomId] = {
                    id: roomId,
                    name: roomName,
                    hostId: creatorId,
                    hostUsername: creatorUsername, // Guardar el nombre de usuario del anfitrión
                    players: [{ socketId: creatorId, username: creatorUsername }],
                    maxPlayers: maxPlayers,
                    status: 'waiting' // Estado inicial de la sala
                };

                // El creador se une a la sala de Socket.IO
                socket.join(roomId);
                players[creatorId].roomId = roomId; // Actualiza el roomId del jugador

                console.log(`[SALA CREADA] Sala '${roomName}' (ID: ${roomId}) creada por ${creatorUsername}.`);
                socket.emit('roomCreated', { roomId: roomId, roomName: roomName });

                // Envía la lista de salas actualizada a todos los clientes
                io.emit('updateRoomList', getPublicRoomList());
                console.log(`[LOBBY] Lista de salas actualizada después de creación de '${roomName}'.`);
            });

            // --- Manejo de unirse a una sala ---
            socket.on('joinRoom', (data) => {
                const { roomId } = data;
                const joiningPlayerId = socket.id;
                const joiningPlayerUsername = players[joiningPlayerId] ? players[joiningPlayerId].username : 'Desconocido';

                console.log(`[UNIRSE SALA] Jugador '${joiningPlayerUsername}' (${joiningPlayerId}) intentando unirse a sala ${roomId}.`);

                if (!players[joiningPlayerId]) {
                    console.log(`[UNIRSE SALA FALLIDO] Jugador no registrado: ${joiningPlayerId}`);
                    socket.emit('roomError', { message: 'Debes registrar un perfil de usuario primero.' });
                    return;
                }
                
                // Si el jugador ya está en una sala, lo saca de ella antes de unirse a una nueva
                if (players[joiningPlayerId].roomId && players[joiningPlayerId].roomId !== roomId) {
                    const oldRoomId = players[joiningPlayerId].roomId;
                    const oldRoom = rooms[oldRoomId];
                    if (oldRoom) {
                        oldRoom.players = oldRoom.players.filter(p => p.socketId !== joiningPlayerId);
                        socket.leave(oldRoomId);
                        console.log(`[SALA] Jugador ${joiningPlayerUsername} dejó la sala ${oldRoom.name} (${oldRoomId}).`);
                        // Notificar a los demás jugadores en la sala antigua que alguien se fue
                        io.to(oldRoomId).emit('playerLeftRoom', { socketId: joiningPlayerId, username: joiningPlayerUsername });
                        // Si la sala antigua se queda sin jugadores, la eliminamos
                        if (oldRoom.players.length === 0) {
                            delete rooms[oldRoomId];
                            console.log(`[SALA] Sala ${oldRoom.name} (${oldRoomId}) vacía y eliminada.`);
                        } else if (oldRoom.hostId === joiningPlayerId) { // Si el que se va era el host
                             // Asignar un nuevo host o cerrar la sala
                             if (oldRoom.players.length > 0) {
                                 oldRoom.hostId = oldRoom.players[0].socketId;
                                 oldRoom.hostUsername = oldRoom.players[0].username;
                                 io.to(oldRoomId).emit('hostChanged', { newHostId: oldRoom.hostId, newHostUsername: oldRoom.hostUsername });
                                 console.log(`[SALA] Host de ${oldRoom.name} cambió a ${oldRoom.hostUsername}.`);
                             } else {
                                 // Si no quedan jugadores, la sala se elimina de todos modos.
                                 cleanupRoom(oldRoomId, 'El anfitrión se desconectó y no quedaron jugadores.');
                             }
                        }
                    }
                }

                const room = rooms[roomId];

                if (!room) {
                    console.log(`[UNIRSE SALA FALLIDO] Sala ${roomId} no encontrada.`);
                    socket.emit('roomError', { message: `La sala '${roomId}' no existe.` });
                    return;
                }

                if (room.players.length >= room.maxPlayers) {
                    console.log(`[UNIRSE SALA FALLIDO] Sala ${roomId} está llena.`);
                    socket.emit('roomError', { message: `La sala '${room.name}' está llena.` });
                    return;
                }
                
                // Añade el jugador a la lista de jugadores de la sala si no está ya
                const playerAlreadyInRoom = room.players.some(p => p.socketId === joiningPlayerId);
                if (!playerAlreadyInRoom) {
                    room.players.push({ socketId: joiningPlayerId, username: joiningPlayerUsername });
                }

                // El jugador se une a la sala de Socket.IO
                socket.join(roomId);
                players[joiningPlayerId].roomId = roomId; // Actualiza el roomId del jugador

                console.log(`[SALA UNIDA] Jugador '${joiningPlayerUsername}' se unió a la sala '${room.name}' (ID: ${roomId}).`);
                
                // Envía la confirmación al jugador que se unió, incluyendo la lista de jugadores de la sala
                socket.emit('roomJoined', { 
                    roomId: roomId, 
                    roomName: room.name, 
                    playersInRoom: room.players.map(p => ({ id: p.socketId, username: p.username })) 
                });

                // Notifica a los demás jugadores en la sala que alguien se unió
                // Incluimos la posición inicial por si se unen a una partida ya en curso y necesitan la info de los demás
                socket.to(roomId).emit('playerJoinedRoom', { 
                    id: joiningPlayerId, 
                    username: joiningPlayerUsername, 
                    position: players[joiningPlayerId].position,
                    rotation: players[joiningPlayerId].rotation,
                    pitchRotation: players[joiningPlayerId].pitchRotation,
                    flashlightOn: players[joiningPlayerId].flashlightOn,
                    playerAnimationState: players[joiningPlayerId].playerAnimationState
                });

                // Envía la lista de salas actualizada a todos los clientes (especialmente al menú)
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

            // --- NUEVO EVENTO: Cuando el cliente 3D indica que se ha unido a una sala ---
            socket.on('gameJoinRoom', (data) => {
                const { username, roomId } = data;
                console.log(`[SERVER] Cliente 3D - Jugador ${username} (ID: ${socket.id}) intentando confirmar unión a sala: ${roomId}`);

                // Verifica si el jugador ya está registrado globalmente (del menú)
                if (!players[socket.id]) {
                    // Si el jugador no está en el objeto global 'players' (p.ej., recargó la página del juego directamente
                    // sin pasar por el menú de nuevo, o hubo un reinicio del servidor y se perdió su sesión previa),
                    // lo registramos ahora. Esto es importante para que el servidor lo reconozca.
                    players[socket.id] = {
                        username: username,
                        bio: "", // Asume bio vacía si no viene del menú
                        position: { x: 0, y: 0.27, z: 0 }, 
                        rotation: 0, 
                        pitchRotation: 0, 
                        flashlightOn: true, 
                        playerAnimationState: 'idle',
                        roomId: null // Se actualizará en breve
                    };
                    console.log(`[SERVER] Jugador ${username} (ID: ${socket.id}) registrado al entrar al juego 3D.`);
                } else {
                    // Si ya está registrado, actualiza el username si es necesario (p.ej. si cambió de navegador)
                    players[socket.id].username = username;
                }

                const player = players[socket.id]; // Obtiene la referencia al objeto del jugador

                // Asegúrate de que la sala exista y el jugador esté asociado a ella
                if (roomId && rooms[roomId]) {
                    // Si el jugador ya estaba en otra sala, lo saca de ella primero
                    if (player.roomId && player.roomId !== roomId) {
                        const oldRoom = rooms[player.roomId];
                        if (oldRoom) {
                            oldRoom.players = oldRoom.players.filter(p => p.socketId !== socket.id);
                            socket.leave(player.roomId);
                            console.log(`[SERVER] Jugador ${player.username} dejó la sala ${oldRoom.name} (${player.roomId}).`);
                            io.to(player.roomId).emit('playerLeftRoom', { socketId: socket.id, username: player.username });
                            if (oldRoom.players.length === 0) {
                                delete rooms[oldRoom.id];
                                console.log(`[SERVER] Sala ${oldRoom.name} (${oldRoom.id}) vacía y eliminada.`);
                            } else if (oldRoom.hostId === socket.id) { // Si el que se va era el host
                                if (oldRoom.players.length > 0) {
                                    oldRoom.hostId = oldRoom.players[0].socketId;
                                    oldRoom.hostUsername = oldRoom.players[0].username;
                                    io.to(oldRoom.id).emit('hostChanged', { newHostId: oldRoom.hostId, newHostUsername: oldHost.hostUsername });
                                    console.log(`[SALA] Host de ${oldRoom.name} cambió a ${oldRoom.hostUsername}.`);
                                } else {
                                    cleanupRoom(oldRoom.id, 'El anfitrión se desconectó y no quedaron jugadores.');
                                }
                            }
                        }
                    }

                    // Asegura que el socket se una a la sala de Socket.IO
                    socket.join(roomId);
                    player.roomId = roomId; // Establece el roomId del jugador
                    socket.roomId = roomId; // También en el objeto socket para fácil acceso
                    
                    // Añade al jugador a la lista de jugadores de la sala si no está ya
                    const playerInRoomAlready = rooms[roomId].players.find(p => p.socketId === socket.id);
                    if (!playerInRoomAlready) {
                        rooms[roomId].players.push({ socketId: socket.id, username: username });
                    }
                    rooms[roomId].lastActivity = Date.now(); // Actualiza actividad de la sala

                    console.log(`[SERVER] Cliente 3D - Jugador ${username} (ID: ${socket.id}) CONFIRMADO en sala ${roomId}.`);
                    
                    // Enviar todos los jugadores de esta sala al cliente que se acaba de unir
                    const playersInCurrentRoom = {};
                    rooms[roomId].players.forEach(p => {
                        if (players[p.socketId]) { // Asegura que el jugador esté en el objeto global 'players'
                            playersInCurrentRoom[p.socketId] = players[p.socketId];
                        }
                    });
                    socket.emit('currentPlayers', playersInCurrentRoom);
                    console.log(`[SERVER] currentPlayers enviados a ${username} en sala ${roomId}:`, Object.keys(playersInCurrentRoom).length, 'jugadores.');

                    // Notificar a los otros jugadores en la sala sobre el nuevo jugador
                    socket.to(roomId).emit('playerConnected', { id: socket.id, ...player });
                    console.log(`[SERVER] playerConnected emitido a sala ${roomId} por ${username}.`);
                    
                    // Actualizar la lista de salas para todos los clientes (menú y otros juegos)
                    io.emit('updateRoomList', getPublicRoomList());
                    console.log(`[LOBBY] Lista de salas actualizada globalmente.`);

                } else {
                    console.warn(`[SERVER] Cliente 3D - Sala ${roomId} no encontrada o inválida para ${username}. Redirigiendo a menú.`);
                    socket.emit('roomClosed', { roomId: roomId, message: `La sala '${roomId}' no existe o ha sido cerrada.` });
                    // No desconectar aquí. El cliente manejará la redirección.
                }
            });

            // Cuando un jugador se mueve, las actualizaciones se emiten SOLO a los de la misma sala
            socket.on('playerMoved', (playerData) => {
                const playerId = socket.id;
                // Verificar que el jugador esté asociado a una sala a través de socket.roomId
                if (socket.roomId && players[playerId] && players[playerId].roomId === socket.roomId && rooms[socket.roomId]) { 
                    const currentRoom = rooms[socket.roomId];
                    
                    // Actualiza los datos del jugador en el objeto global 'players'
                    players[playerId].position = playerData.position;
                    players[playerId].rotation = playerData.rotation;
                    players[playerId].pitchRotation = playerData.pitchRotation;
                    players[playerId].flashlightOn = playerData.flashlightOn;
                    players[playerId].playerAnimationState = playerData.playerAnimationState;

                    // También actualiza los datos del jugador dentro de la lista de jugadores de la sala
                    const playerInRoomList = currentRoom.players.find(p => p.socketId === playerId);
                    if (playerInRoomList) {
                        // Actualiza solo la referencia de la lista de players en la room, para que apunte a los players globales
                        // Esto ya es manejado si la referencia es la misma, pero para claridad.
                        // En un sistema más robusto, rooms.players podría ser solo una lista de IDs.
                        // Por simplicidad, asumimos que rooms.players tiene el objeto completo.
                        Object.assign(playerInRoomList, players[playerId]); 
                    } else {
                        // Si por alguna razón el jugador no está en la lista de la sala, añadirlo
                        currentRoom.players.push(players[playerId]);
                    }

                    currentRoom.lastActivity = Date.now(); // Actualiza la actividad de la sala

                    // Emite la actualización de movimiento SÓLO a los demás jugadores en la misma sala
                    socket.broadcast.to(socket.roomId).emit('playerMoved', { id: playerId, ...players[playerId] });
                } else {
                    console.log(`[MOVIMIENTO IGNORADO] Jugador ${playerId} intentó moverse sin estar en una sala válida o no encontrado.`);
                }
            });

            // Cuando un jugador envía un mensaje de chat, ahora se envía solo a la sala actual
            socket.on('chatMessage', (message) => {
                // Utiliza socket.username (establecido en gameJoinRoom) y socket.roomId
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
                const disconnectedRoomId = socket.roomId; // Obtener roomId de la propiedad del socket

                // Eliminar jugador del objeto global de jugadores
                delete players[socket.id]; 

                // Si el jugador estaba en una sala, lo elimina de ella
                if (disconnectedRoomId && rooms[disconnectedRoomId]) {
                    const room = rooms[disconnectedRoomId];
                    room.players = room.players.filter(p => p.socketId !== socket.id);
                    console.log(`[SALA] Jugador ${disconnectedUsername} dejó la sala ${room.name} (${disconnectedRoomId}).`);
                    
                    // Notifica a los demás jugadores en esa sala que alguien se desconectó
                    socket.to(disconnectedRoomId).emit('playerDisconnected', socket.id);

                    // Si la sala se queda vacía, la elimina (OJO: Aquí es donde queremos que sea más inteligente)
                    if (room.players.length === 0) {
                        delete rooms[disconnectedRoomId];
                        console.log(`[SALA] Sala ${room.name} (${disconnectedRoomId}) vacía y eliminada.`);
                    } else if (room.hostId === socket.id) {
                        // Si el host se desconecta, asigna un nuevo host o cierra la sala
                        console.log(`[SALA HOST DESCONECTADO] El host ${disconnectedUsername} de la sala ${room.name} (${disconnectedRoomId}) se desconectó.`);
                        if (room.players.length > 0) {
                            // Asigna el primer jugador restante como nuevo host
                            const newHost = room.players[0];
                            room.hostId = newHost.socketId;
                            room.hostUsername = newHost.username;
                            console.log(`[SALA] Nuevo host de ${room.name} es: ${newHost.username}.`);
                            io.to(disconnectedRoomId).emit('hostChanged', { newHostId: room.hostId, newHostUsername: room.hostUsername });
                        } else {
                            // Si no quedan jugadores, la sala se elimina
                            cleanupRoom(disconnectedRoomId, 'El anfitrión se desconectó y la sala quedó vacía.');
                        }
                    }
                } else {
                    // Si el jugador no estaba en una sala, simplemente se elimina
                    console.log(`[LOBBY] Jugador ${disconnectedUsername} desconectado del lobby.`);
                }

                // Envía la lista de salas actualizada a todos los clientes (especialmente al menú)
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
