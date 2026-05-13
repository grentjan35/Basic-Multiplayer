const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Server configuration
const TICK_RATE = 30; // Server updates per second (reduced for cloud performance)
const TICK_INTERVAL = 1000 / TICK_RATE;

// Physics constants - SERVER ONLY
const GRAVITY = 0.5;
const FRICTION = 1.0;
const AIR_RESISTANCE = 0.98;
const MOVE_SPEED = 0.5;
const JUMP_FORCE = 10;
const MAX_FALL_SPEED = 12;
const PLAYER_WIDTH = 40;
const PLAYER_HEIGHT = 60;
const HITBOX_LEFT_INSET = 14; // Trim empty space on left side of sprite
const HITBOX_RIGHT_INSET = 0; // Right side is already aligned
const HITBOX_WIDTH = PLAYER_WIDTH - HITBOX_LEFT_INSET - HITBOX_RIGHT_INSET;

// World dimensions
const WORLD_WIDTH = 5000;
const WORLD_HEIGHT = 2000;

// Available character spritesheets
const CHARACTERS = ['Bookie', 'Getaway Driver', 'Informant', 'Safecracker', 'smuggler', 'Street Thug'];

// Game state - SERVER ONLY
const players = new Map();
let platforms = [];
let playerIdCounter = 0;

// Preloaded assets (base64 encoded for secure transmission via WebSocket)
let spritesheetData = null;
const characterImages = {}; // character name -> base64 PNG data URL

// Load and base64-encode all assets at startup
function loadAssets() {
    // Load spritesheet JSON
    try {
        const jsonPath = path.join(__dirname, 'assets', 'spritesheet.json');
        spritesheetData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        console.log('Loaded spritesheet metadata');
    } catch (err) {
        console.error('Failed to load spritesheet.json:', err.message);
        spritesheetData = null;
    }

    // Load and base64-encode all character PNGs
    for (const character of CHARACTERS) {
        try {
            const filePath = path.join(__dirname, 'assets', `${character}.png`);
            const fileData = fs.readFileSync(filePath);
            const base64 = fileData.toString('base64');
            characterImages[character] = `data:image/png;base64,${base64}`;
            console.log(`Loaded and encoded: ${character}.png`);
        } catch (err) {
            console.error(`Failed to load ${character}.png:`, err.message);
            // Fallback to base.png
            try {
                const fallbackPath = path.join(__dirname, 'assets', 'base.png');
                const fileData = fs.readFileSync(fallbackPath);
                const base64 = fileData.toString('base64');
                characterImages[character] = `data:image/png;base64,${base64}`;
            } catch (fallbackErr) {
                console.error('Failed to load base.png as fallback:', fallbackErr.message);
            }
        }
    }

    // Also load base.png for fallback
    if (!characterImages['base']) {
        try {
            const filePath = path.join(__dirname, 'assets', 'base.png');
            const fileData = fs.readFileSync(filePath);
            const base64 = fileData.toString('base64');
            characterImages['base'] = `data:image/png;base64,${base64}`;
        } catch (err) {
            console.error('Failed to load base.png:', err.message);
        }
    }

    console.log(`Loaded ${Object.keys(characterImages).length} character images via base64`);
}

// Initialize platforms - huge map
function initPlatforms() {
    platforms = [];
    
    // Ground floor across entire world
    platforms.push({ x: 0, y: WORLD_HEIGHT - 100, w: WORLD_WIDTH, h: 100 });
    
    // Add low platforms above ground with spacing
    for (let x = 200; x < WORLD_WIDTH; x += 500) {
        platforms.push({ x, y: WORLD_HEIGHT - 180, w: 150, h: 20 });
    }
    
    // Generate random platforms with spacing
    for (let i = 0; i < 150; i++) {
        const x = Math.random() * (WORLD_WIDTH - 300);
        const y = 200 + Math.random() * (WORLD_HEIGHT - 500);
        const w = 100 + Math.random() * 150;
        const h = 20;
        
        // Check for overlap with existing platforms
        let overlaps = false;
        for (const plat of platforms) {
            const buffer = 150; // Increased spacing to prevent touching
            if (x < plat.x + plat.w + buffer &&
                x + w > plat.x - buffer &&
                y < plat.y + plat.h + buffer &&
                y + h > plat.y - buffer) {
                overlaps = true;
                break;
            }
        }
        
        if (!overlaps) {
            platforms.push({ x, y, w, h });
        }
    }
    
    // Add structured platforms for navigation with spacing and overlap checking
    for (let x = 100; x < WORLD_WIDTH; x += 500) {
        for (let y = 300; y < WORLD_HEIGHT - 200; y += 350) { // Increased vertical spacing
            const w = 150;
            const h = 20;
            
            // Check for overlap with existing platforms
            let overlaps = false;
            for (const plat of platforms) {
                const buffer = 100; // Buffer zone
                if (x < plat.x + plat.w + buffer &&
                    x + w > plat.x - buffer &&
                    y < plat.y + plat.h + buffer &&
                    y + h > plat.y - buffer) {
                    overlaps = true;
                    break;
                }
            }
            
            if (!overlaps) {
                platforms.push({ x, y, w, h });
            }
        }
    }
}

// Create HTTP server for serving static files
const server = http.createServer((req, res) => {
    // Add CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Player class - SERVER ONLY
class Player {
    constructor(id, x, y) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        this.onGround = false;
        this.color = this.generateDarkColor();
        this.sprite = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];
        this.inputs = { left: false, right: false, jump: false };
    }

    // Generate dark, desaturated colors
    generateDarkColor() {
        const hue = Math.floor(Math.random() * 360);
        return `hsl(${hue}, 20%, 35%)`;
    }
}

// Add new player
function addPlayer(ws) {
    const id = ++playerIdCounter;
    // Spawn on top of ground platform
    const player = new Player(id, 100, WORLD_HEIGHT - 100 - PLAYER_HEIGHT);
    players.set(id, { player, ws });
    
    // Send init with all assets embedded as base64 data URLs (no HTTP requests needed)
    const initMessage = {
        type: 'init',
        id: id,
        platforms: platforms,
        worldWidth: WORLD_WIDTH,
        worldHeight: WORLD_HEIGHT,
        characters: CHARACTERS,
        spritesheetData: spritesheetData,
        images: characterImages
    };
    
    ws.send(JSON.stringify(initMessage));
    
    return id;
}

// Remove player
function removePlayer(id) {
    players.delete(id);
}

// Apply physics to player - SERVER ONLY
function applyPhysics(player) {
    // Apply gravity
    player.vy += GRAVITY;
    
    // Apply air resistance
    player.vx *= AIR_RESISTANCE;
    
    // Clamp fall speed
    if (player.vy > MAX_FALL_SPEED) {
        player.vy = MAX_FALL_SPEED;
    }
    
    // Apply input forces
    if (player.inputs.left) {
        player.vx -= MOVE_SPEED;
    }
    if (player.inputs.right) {
        player.vx += MOVE_SPEED;
    }
    if (player.inputs.jump && player.onGround) {
        // Scale jump force based on horizontal velocity
        const speedBonus = Math.abs(player.vx) * 0.5;
        player.vy = -(JUMP_FORCE + speedBonus);
        player.onGround = false;
    }
    
    // Apply friction when on ground
    if (player.onGround) {
        player.vx *= FRICTION;
    }
    
    // Update position
    player.x += player.vx;
    player.y += player.vy;
    
    // World bounds
    if (player.x < 0) {
        player.x = 0;
        player.vx = 0;
    }
    if (player.x > WORLD_WIDTH - PLAYER_WIDTH) {
        player.x = WORLD_WIDTH - PLAYER_WIDTH;
        player.vx = 0;
    }
    
    // Reset if fallen off map
    if (player.y > WORLD_HEIGHT + 100) {
        player.x = 100;
        player.y = WORLD_HEIGHT - 200;
        player.vx = 0;
        player.vy = 0;
    }
}

// Check collision - SERVER ONLY
function checkCollision(player) {
    player.onGround = false;
    
    const hitboxLeft = player.x + HITBOX_LEFT_INSET;
    const hitboxRight = hitboxLeft + HITBOX_WIDTH;
    
    for (const plat of platforms) {
        // Check if player is colliding with platform (using inset hitbox)
        if (hitboxRight > plat.x &&
            hitboxLeft < plat.x + plat.w &&
            player.y + PLAYER_HEIGHT > plat.y &&
            player.y < plat.y + plat.h) {
            
            // Determine collision side
            const overlapLeft = hitboxRight - plat.x;
            const overlapRight = (plat.x + plat.w) - hitboxLeft;
            const overlapTop = (player.y + PLAYER_HEIGHT) - plat.y;
            const overlapBottom = (plat.y + plat.h) - player.y;
            
            const minOverlapX = Math.min(overlapLeft, overlapRight);
            const minOverlapY = Math.min(overlapTop, overlapBottom);
            
            if (minOverlapY < minOverlapX) {
                if (overlapTop < overlapBottom) {
                    // Landing on top
                    player.y = plat.y - PLAYER_HEIGHT;
                    player.vy = 0;
                    player.onGround = true;
                } else {
                    // Hitting from below
                    player.y = plat.y + plat.h;
                    player.vy = 0;
                }
            } else {
                if (overlapLeft < overlapRight) {
                    // Hitting from left
                    player.x = plat.x - PLAYER_WIDTH; // Push to full sprite width so visual aligns
                    player.vx = 0;
                } else {
                    // Hitting from right
                    player.x = plat.x + plat.w - HITBOX_LEFT_INSET; // Right side wall push
                    player.vx = 0;
                }
            }
        }
    }
}

// Check player-to-player collision - SERVER ONLY
function checkPlayerCollisions(currentPlayer) {
    const currHitboxLeft = currentPlayer.x + HITBOX_LEFT_INSET;
    const currHitboxRight = currHitboxLeft + HITBOX_WIDTH;
    
    for (const [id, { player }] of players) {
        if (id === currentPlayer.id) continue;
        
        const otherHitboxLeft = player.x + HITBOX_LEFT_INSET;
        const otherHitboxRight = otherHitboxLeft + HITBOX_WIDTH;
        
        // Check if players are colliding (using inset hitbox)
        if (currHitboxRight > otherHitboxLeft &&
            currHitboxLeft < otherHitboxRight &&
            currentPlayer.y + PLAYER_HEIGHT > player.y &&
            currentPlayer.y < player.y + PLAYER_HEIGHT) {
            
            // Determine collision side
            const overlapLeft = currHitboxRight - otherHitboxLeft;
            const overlapRight = otherHitboxRight - currHitboxLeft;
            const overlapTop = (currentPlayer.y + PLAYER_HEIGHT) - player.y;
            const overlapBottom = (player.y + PLAYER_HEIGHT) - currentPlayer.y;
            
            const minOverlapX = Math.min(overlapLeft, overlapRight);
            const minOverlapY = Math.min(overlapTop, overlapBottom);
            
            // Calculate relative velocity for momentum transfer
            const relVx = currentPlayer.vx - player.vx;
            const relVy = currentPlayer.vy - player.vy;
            
            if (minOverlapY < minOverlapX) {
                if (overlapTop < overlapBottom) {
                    // Current player on top
                    currentPlayer.y = player.y - PLAYER_HEIGHT;
                    const pushForce = Math.abs(relVy) * 0.5;
                    currentPlayer.vy = Math.min(currentPlayer.vy, -pushForce);
                    player.vy = Math.max(player.vy, pushForce);
                } else {
                    // Current player below
                    currentPlayer.y = player.y + PLAYER_HEIGHT;
                    const pushForce = Math.abs(relVy) * 0.5;
                    currentPlayer.vy = Math.max(currentPlayer.vy, pushForce);
                    player.vy = Math.min(player.vy, -pushForce);
                }
            } else {
                if (overlapLeft < overlapRight) {
                    // Current player on left
                    currentPlayer.x = player.x - PLAYER_WIDTH;
                    const pushForce = Math.abs(relVx) * 0.5;
                    currentPlayer.vx = Math.min(currentPlayer.vx, -pushForce);
                    player.vx = Math.max(player.vx, pushForce);
                } else {
                    // Current player on right
                    currentPlayer.x = player.x + PLAYER_WIDTH;
                    const pushForce = Math.abs(relVx) * 0.5;
                    currentPlayer.vx = Math.max(currentPlayer.vx, pushForce);
                    player.vx = Math.min(player.vx, -pushForce);
                }
            }
        }
    }
}

// Performance monitoring
let lastStatsUpdate = Date.now();
let totalUpdates = 0;

// Main game loop - SERVER ONLY
function gameLoop() {
    const startTime = process.hrtime.bigint();
    
    // Update all players
    for (const [id, { player }] of players) {
        applyPhysics(player);
        checkCollision(player);
        checkPlayerCollisions(player);
    }
    
    // Send state to all clients (only if there are players)
    if (players.size > 0) {
        const playerStates = [];
        for (const [id, { player }] of players) {
            playerStates.push({
                id: id,
                x: Math.round(player.x * 100) / 100, // Round to reduce precision
                y: Math.round(player.y * 100) / 100, // Round to reduce precision
                vx: Math.round(player.vx * 100) / 100, // Include velocity for animation
                vy: Math.round(player.vy * 100) / 100,
                onGround: player.onGround,
                color: player.color,
                sprite: player.sprite
            });
        }
        
        const message = JSON.stringify({
            type: 'state',
            players: playerStates
        });
        
        for (const [id, { ws }] of players) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }
    
    // Performance monitoring
    totalUpdates++;
    const now = Date.now();
    if (now - lastStatsUpdate > 5000) { // Log every 5 seconds
        const endTime = process.hrtime.bigint();
        const avgTime = Number(endTime - startTime) / 1000000; // Convert to milliseconds
        console.log(`Game loop: ${totalUpdates} updates, avg time: ${avgTime.toFixed(2)}ms, players: ${players.size}`);
        totalUpdates = 0;
        lastStatsUpdate = now;
    }
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('Client connected');
    
    const playerId = addPlayer(ws);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'input') {
                const playerData = players.get(playerId);
                if (playerData) {
                    playerData.player.inputs = data.inputs;
                }
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
        removePlayer(playerId);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        removePlayer(playerId);
    });
});

// Initialize and start server
loadAssets();
initPlatforms();
server.listen(7860, () => {
    console.log(`Server running on http://localhost:7860`);
    
    // Start game loop
    setInterval(gameLoop, TICK_INTERVAL);
});