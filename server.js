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

// Attack constants
const ATTACK_TIMEOUT = 500; // ms before combo resets to jab
const ATTACK_ACTIVE_TIME = 200; // ms the hitbox is active
const ATTACK_HITBOX_EXTEND = 30; // px the hitbox extends in front of player
const ATTACK_HITBOX_WIDTH = 30;
const ATTACK_HITBOX_HEIGHT = 40; // height of attack hitbox (waist-to-head area)

// Hit stun duration (frames)
const HIT_STUN_FRAMES = 10; // ~333ms at 30 TPS

// Combo stages: [damage, knockbackForce, name]
// Sequence: jab → cross → jab → cross → kick (5 presses total)
const COMBO_DATA = [
    { damage: 10, knockback: 15, name: 'jab' },
    { damage: 20, knockback: 25, name: 'cross' },
    { damage: 10, knockback: 15, name: 'jab' },
    { damage: 20, knockback: 25, name: 'cross' },
    { damage: 45, knockback: 65, name: 'kick' }
];

// Health
const MAX_HEALTH = 100;

// World dimensions
const WORLD_WIDTH = 5000;
const WORLD_HEIGHT = 4000;

// Available character spritesheets
const CHARACTERS = ['Bookie', 'Getaway Driver', 'Informant', 'Safecracker', 'smuggler', 'Street Thug', 'Boss', 'Distractor Duck', 'Dark Cowboy', 'Racketeer', 'Purple', 'Guard', 'Dock Overseer', 'Hostage', 'Doorman'];

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

// Initialize platforms - huge map with multiple height tiers
function initPlatforms() {
    platforms = [];
    
    // =========================================================
    // GROUND FLOOR - Full width across entire world
    // =========================================================
    platforms.push({ x: 0, y: WORLD_HEIGHT - 100, w: WORLD_WIDTH, h: 100 });
    
    // =========================================================
    // TIER 1: Low platforms (just above ground) - wide, easy
    // =========================================================
    for (let x = 200; x < WORLD_WIDTH; x += 500) {
        const plat = { x, y: WORLD_HEIGHT - 180, w: 150, h: 20 };
        platforms.push(plat);
        // Add a small stepping platform next to each for easier climbing
        if (x + 300 < WORLD_WIDTH) {
            platforms.push({ x: x + 250, y: WORLD_HEIGHT - 260, w: 80, h: 20 });
        }
    }

    // =========================================================
    // TIER 2: Mid-low platforms (y: 3000-3600) - generous spacing
    // =========================================================
    for (let x = 50; x < WORLD_WIDTH; x += 400) {
        const y = 3000 + Math.floor(x / 400) % 2 * 150;
        const plat = { x, y, w: 180, h: 20 };
        // Simple overlap check
        let overlaps = false;
        for (const p of platforms) {
            if (x < p.x + p.w + 120 && x + plat.w > p.x - 120 &&
                y < p.y + p.h + 120 && y + plat.h > p.y - 120) {
                overlaps = true;
                break;
            }
        }
        if (!overlaps) platforms.push(plat);
    }

    // =========================================================
    // TIER 3: Mid platforms (y: 2300-2900) - balanced
    // =========================================================
    for (let x = 100; x < WORLD_WIDTH; x += 350) {
        const y = 2300 + Math.floor(x / 350) % 3 * 100;
        const plat = { x, y, w: 140, h: 20 };
        let overlaps = false;
        for (const p of platforms) {
            if (x < p.x + p.w + 100 && x + plat.w > p.x - 100 &&
                y < p.y + p.h + 100 && y + plat.h > p.y - 100) {
                overlaps = true;
                break;
            }
        }
        if (!overlaps) platforms.push(plat);
    }

    // =========================================================
    // TIER 4: Mid-high platforms (y: 1600-2200) - tighter
    // =========================================================
    for (let x = 150; x < WORLD_WIDTH; x += 400) {
        const y = 1600 + Math.floor(x / 400) % 4 * 80;
        const plat = { x, y, w: 120, h: 20 };
        let overlaps = false;
        for (const p of platforms) {
            if (x < p.x + p.w + 90 && x + plat.w > p.x - 90 &&
                y < p.y + p.h + 90 && y + plat.h > p.y - 90) {
                overlaps = true;
                break;
            }
        }
        if (!overlaps) platforms.push(plat);
    }

    // =========================================================
    // TIER 5: High platforms (y: 1000-1500) - sparse
    // =========================================================
    for (let x = 200; x < WORLD_WIDTH; x += 500) {
        const y = 1000 + Math.floor(x / 500) % 3 * 120;
        const plat = { x, y, w: 100, h: 20 };
        let overlaps = false;
        for (const p of platforms) {
            if (x < p.x + p.w + 80 && x + plat.w > p.x - 80 &&
                y < p.y + p.h + 80 && y + plat.h > p.y - 80) {
                overlaps = true;
                break;
            }
        }
        if (!overlaps) platforms.push(plat);
    }

    // =========================================================
    // TIER 6: Very high platforms (y: 500-900) - very sparse
    // =========================================================
    for (let x = 300; x < WORLD_WIDTH; x += 600) {
        const y = 500 + Math.floor(x / 600) % 3 * 100;
        const plat = { x, y, w: 80, h: 20 };
        let overlaps = false;
        for (const p of platforms) {
            if (x < p.x + p.w + 80 && x + plat.w > p.x - 80 &&
                y < p.y + p.h + 80 && y + plat.h > p.y - 80) {
                overlaps = true;
                break;
            }
        }
        if (!overlaps) platforms.push(plat);
    }

    // =========================================================
    // TIER 7: Sky platforms near the top (y: 100-400) - tiny
    // =========================================================
    for (let x = 400; x < WORLD_WIDTH; x += 700) {
        const y = 100 + Math.floor(x / 700) % 2 * 100;
        const plat = { x, y, w: 60, h: 20 };
        let overlaps = false;
        for (const p of platforms) {
            if (x < p.x + p.w + 70 && x + plat.w > p.x - 70 &&
                y < p.y + p.h + 70 && y + plat.h > p.y - 70) {
                overlaps = true;
                break;
            }
        }
        if (!overlaps) platforms.push(plat);
    }

    // =========================================================
    // STAIRCASE TOWERS: Vertical climbing structures
    // Four towers at x = 800, 2000, 3200, 4400
    // =========================================================
    const towerPositions = [800, 2000, 3200, 4400];
    for (const towerX of towerPositions) {
        for (let y = WORLD_HEIGHT - 350; y > 200; y -= 280) {
            // Stagger left-right for climbing
            const offsetX = ((WORLD_HEIGHT - 350 - y) / 280) % 2 === 0 ? 0 : 100;
            const plat = { x: towerX + offsetX, y, w: 120, h: 20 };
            let overlaps = false;
            for (const p of platforms) {
                if (plat.x < p.x + p.w + 50 && plat.x + plat.w > p.x - 50 &&
                    y < p.y + p.h + 50 && y + plat.h > p.y - 50) {
                    overlaps = true;
                    break;
                }
            }
            if (!overlaps) platforms.push(plat);
        }
    }

    // =========================================================
    // BRIDGE PLATFORMS: Long horizontal strips at key heights
    // =========================================================
    const bridgeHeights = [3700, 3100, 2500, 1900, 1300, 700];
    for (const y of bridgeHeights) {
        for (let x = 200; x < WORLD_WIDTH - 300; x += 800) {
            const plat = { x, y, w: 300, h: 20 };
            let overlaps = false;
            for (const p of platforms) {
                if (x < p.x + p.w + 100 && x + plat.w > p.x - 100 &&
                    y < p.y + p.h + 100 && y + plat.h > p.y - 100) {
                    overlaps = true;
                    break;
                }
            }
            if (!overlaps) platforms.push(plat);
        }
    }

    // =========================================================
    // ADDITIONAL RANDOM PLATFORMS - fill gaps
    // =========================================================
    for (let i = 0; i < 200; i++) {
        const x = Math.random() * (WORLD_WIDTH - 300);
        const y = 100 + Math.random() * (WORLD_HEIGHT - 400);
        const w = 60 + Math.random() * 120;
        const h = 20;
        
        let overlaps = false;
        for (const plat of platforms) {
            const buffer = 100;
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

    console.log(`Initialized ${platforms.length} platforms across the world`);
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
        this.inputs = { left: false, right: false, jump: false, attack: false };
        this.attackProcessed = false; // Prevents attack spam while holding space
        this.gotHit = false; // Tracks if player was hit this frame
        
        // Attack combo system
        this.comboStage = 0; // 0=no attack, 1=jab, 2=cross, 3=kick
        this.lastAttackTime = 0; // tick count when last attack was triggered
        this.attackActive = false; // is attack hitbox currently active
        this.attackEndTime = 0; // tick count when attack expires
        this.facingRight = true; // which direction the player is facing
        
        // Health system
        this.health = MAX_HEALTH;
        this.invincibleTimer = 0; // ticks until invincibility wears off (brief post-hit)
        
        // Hit stun - lasts multiple frames so client doesn't miss the animation
        this.hitStunTimer = 0; // ticks remaining for hit stun animation
        
        // Fast-fall acceleration tracking
        this.fastFallTicks = 0; // number of consecutive ticks holding down while airborne
        
        // Death state
        this.isDead = false; // true when player is in death state
        this.deathTimer = 0; // ticks until respawn (60 ticks = ~2 seconds)
        
        // Fade state
        this.isFading = false; // true when player is fading out
        this.fadeTimer = 0; // ticks until fade complete (30 ticks = ~1 second)
        this.opacity = 1.0; // 1.0 = fully visible, 0.0 = invisible
        this.isFadingIn = false; // true when fading in after respawn
    }

    // Generate dark, desaturated colors
    generateDarkColor() {
        const hue = Math.floor(Math.random() * 360);
        return `hsl(${hue}, 20%, 35%)`;
    }
    
    // Respawn the player
    respawn() {
        this.health = MAX_HEALTH;
        this.x = 100 + Math.random() * 500;
        this.y = WORLD_HEIGHT - 100 - PLAYER_HEIGHT - 50;
        this.vx = 0;
        this.vy = 0;
        this.onGround = false;
        this.comboStage = 0;
        this.attackActive = false;
        this.invincibleTimer = 60; // ~2 seconds of invincibility
        this.gotHit = false;
        this.hitStunTimer = 0;
        this.isDead = false;
        this.deathTimer = 0;
        this.isFading = false;
        this.fadeTimer = 0;
        this.opacity = 1.0;
        this.isFadingIn = false;
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
    
    // Apply input forces (only if not in attack animation lock and not dead)
    if (!player.isDead) {
        if (player.inputs.left) {
            player.vx -= MOVE_SPEED;
            player.facingRight = false;
        }
        if (player.inputs.right) {
            player.vx += MOVE_SPEED;
            player.facingRight = true;
        }
        if (player.inputs.jump && player.onGround) {
            // Scale jump force based on horizontal velocity
            const speedBonus = Math.abs(player.vx) * 0.5;
            player.vy = -(JUMP_FORCE + speedBonus);
            player.onGround = false;
        }
    }
    // Fast-fall: hold down (S/ArrowDown) to fall faster
    // Accelerates the longer down is held while airborne
    if (player.inputs.down && !player.onGround) {
        player.fastFallTicks++;
        // Progressive acceleration: starts at 1.5, increases by 0.25 per tick held (max 15)
        const extraFall = Math.min(1.5 + player.fastFallTicks * 0.25, 15);
        player.vy += extraFall;
    } else {
        // Reset fast-fall tracking when down is released or player lands
        player.fastFallTicks = 0;
    }
    
    // Process attack input (only once per press, not every tick while held)
    if (player.inputs.attack && !player.attackProcessed) {
        player.attackProcessed = true;
        // Check combo timing
        const now = Date.now();
        if (now - player.lastAttackTime > ATTACK_TIMEOUT) {
            // Too long since last attack, restart combo
            player.comboStage = 1;
        } else if (player.comboStage < 5) {
            // Advance combo
            player.comboStage++;
        } else {
            // Max combo (kick), restart at jab
            player.comboStage = 1;
        }
        
        // Activate the attack hitbox
        player.attackActive = true;
        player.attackEndTime = now + ATTACK_ACTIVE_TIME;
        player.lastAttackTime = now;
    }
    
    // Deactivate attack if expired
    if (player.attackActive && Date.now() > player.attackEndTime) {
        player.attackActive = false;
    }
    
    // Reset attackProcessed when space is released
    if (!player.inputs.attack) {
        player.attackProcessed = false;
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
        player.respawn();
    }
    
    // Handle death timer (count down regardless of ground state)
    if (player.isDead) {
        if (!player.isFading) {
            // First 2 seconds: show dead sprite
            player.deathTimer--;
            if (player.deathTimer <= 0) {
                // Start fading out
                player.isFading = true;
                player.fadeTimer = 30; // ~1 second fade out
            }
        } else {
            // Fading out
            player.fadeTimer--;
            player.opacity = player.fadeTimer / 30; // 1.0 -> 0.0
            if (player.fadeTimer <= 0) {
                // Fade complete, respawn and fade in
                player.respawn();
                player.isFadingIn = true;
                player.fadeTimer = 30; // ~1 second fade in
                player.opacity = 0.0;
            }
        }
    }
    
    // Handle fade in after respawn
    if (player.isFadingIn) {
        player.fadeTimer--;
        player.opacity = 1.0 - (player.fadeTimer / 30); // 0.0 -> 1.0
        if (player.fadeTimer <= 0) {
            player.isFadingIn = false;
            player.opacity = 1.0;
        }
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

// Determine if two players are near each other (for body collision check)
function playersAreColliding(a, b) {
    const aLeft = a.x + HITBOX_LEFT_INSET;
    const aRight = aLeft + HITBOX_WIDTH;
    const bLeft = b.x + HITBOX_LEFT_INSET;
    const bRight = bLeft + HITBOX_WIDTH;
    
    return aRight > bLeft &&
           aLeft < bRight &&
           a.y + PLAYER_HEIGHT > b.y &&
           a.y < b.y + PLAYER_HEIGHT;
}

// Separate players that are overlapping (push apart)
function resolvePlayerBodyCollision(a, b) {
    const aLeft = a.x + HITBOX_LEFT_INSET;
    const aRight = aLeft + HITBOX_WIDTH;
    const bLeft = b.x + HITBOX_LEFT_INSET;
    const bRight = bLeft + HITBOX_WIDTH;
    
    // Determine collision side
    const overlapLeft = aRight - bLeft;
    const overlapRight = bRight - aLeft;
    const overlapTop = (a.y + PLAYER_HEIGHT) - b.y;
    const overlapBottom = (b.y + PLAYER_HEIGHT) - a.y;
    
    const minOverlapX = Math.min(overlapLeft, overlapRight);
    const minOverlapY = Math.min(overlapTop, overlapBottom);
    
    // Calculate relative velocity for momentum transfer
    const relVx = a.vx - b.vx;
    const relVy = a.vy - b.vy;
    
    if (minOverlapY < minOverlapX) {
        if (overlapTop < overlapBottom) {
            // a on top
            a.y = b.y - PLAYER_HEIGHT;
            const pushForce = Math.abs(relVy) * 0.5;
            a.vy = Math.min(a.vy, -pushForce);
            b.vy = Math.max(b.vy, pushForce);
        } else {
            // a below
            a.y = b.y + PLAYER_HEIGHT;
            const pushForce = Math.abs(relVy) * 0.5;
            a.vy = Math.max(a.vy, pushForce);
            b.vy = Math.min(b.vy, -pushForce);
        }
    } else {
        if (overlapLeft < overlapRight) {
            // a on left
            a.x = b.x - PLAYER_WIDTH;
            const pushForce = Math.abs(relVx) * 0.5;
            a.vx = Math.min(a.vx, -pushForce);
            b.vx = Math.max(b.vx, pushForce);
        } else {
            // a on right
            a.x = b.x + PLAYER_WIDTH;
            const pushForce = Math.abs(relVx) * 0.5;
            a.vx = Math.max(a.vx, pushForce);
            b.vx = Math.min(b.vx, -pushForce);
        }
    }
}

// Get the attack hitbox for a player (in front of them)
function getAttackHitbox(player) {
    if (!player.attackActive) return null;
    
    const stage = player.comboStage - 1; // 0-indexed
    if (stage < 0 || stage >= COMBO_DATA.length) return null;
    
    const combo = COMBO_DATA[stage];
    
    // Attack hitbox extends in front of the player based on facing direction
    let hitboxX, hitboxY;
    
    // Slight upward offset for the attack hitbox (waist-to-head area)
    const yOffset = 10;
    
    if (player.facingRight) {
        hitboxX = player.x + PLAYER_WIDTH; // right side of player
    } else {
        hitboxX = player.x - ATTACK_HITBOX_EXTEND; // left side of player
    }
    
    hitboxY = player.y + yOffset;
    
    // Different attacks have different ranges
    // Jab and cross require being close; kick has long range and hits overhead
    let extend = ATTACK_HITBOX_EXTEND;
    let hitboxHeight = ATTACK_HITBOX_HEIGHT;
    let hitboxYOffset = yOffset;
    
    if (combo.name === 'jab') {
        extend = ATTACK_HITBOX_EXTEND * 0.5; // short range - must be close
    } else if (combo.name === 'cross') {
        extend = ATTACK_HITBOX_EXTEND * 0.7; // medium-short range
    } else if (combo.name === 'kick') {
        extend = ATTACK_HITBOX_EXTEND * 1.5; // long range
        hitboxHeight = ATTACK_HITBOX_HEIGHT * 2; // Extend upward to hit players standing on top
        hitboxYOffset = -10; // Position higher to cover overhead area
    }
    
    return {
        x: player.facingRight ? hitboxX : hitboxX - ATTACK_HITBOX_WIDTH,
        y: player.y + hitboxYOffset,
        w: player.facingRight ? extend : ATTACK_HITBOX_WIDTH + extend,
        h: hitboxHeight,
        damage: combo.damage,
        knockback: combo.knockback,
        direction: player.facingRight ? 1 : -1,
        stage: stage
    };
}

// Check if an attack hitbox overlaps a player's body
function attackHitsPlayer(attackHitbox, player) {
    const opponentLeft = player.x;
    const opponentRight = player.x + PLAYER_WIDTH;
    const opponentTop = player.y;
    const opponentBottom = player.y + PLAYER_HEIGHT;
    
    return attackHitbox.x < opponentRight &&
           attackHitbox.x + attackHitbox.w > opponentLeft &&
           attackHitbox.y < opponentBottom &&
           attackHitbox.y + attackHitbox.h > opponentTop;
}

// Apply damage and knockback from an attack
function applyAttackHit(defender, attackHitbox) {
    // Deal damage
    defender.health -= attackHitbox.damage;
    
    // Apply knockback - kick sends opponents flying high
    const knockbackForce = attackHitbox.knockback;
    const verticalMultiplier = attackHitbox.stage === 4 ? 1.5 : 0.6; // Kick launches high (stage 4 = 5th combo press)
    defender.vx = attackHitbox.direction * knockbackForce;
    defender.vy = -knockbackForce * verticalMultiplier; // Launch upward
    defender.onGround = false;
    
    // Mark as hit (multi-frame for client animation)
    defender.gotHit = true;
    defender.hitStunTimer = HIT_STUN_FRAMES;
    
    // Brief invincibility
    defender.invincibleTimer = 15; // ~0.5 seconds
}

// Kick magnet: pull kick attackers toward the nearest opponent (lunge effect)
function applyKickMagnet() {
    for (const [id, { player }] of players) {
        // Only pull when kick attack (stage 5) is active
        if (player.comboStage === 5 && player.attackActive) {
            let nearestDist = Infinity;
            let nearestPlayer = null;
            
            for (const [oid, { player: other }] of players) {
                if (oid === id) continue;
                const dx = other.x - player.x;
                const dy = (other.y + PLAYER_HEIGHT / 2) - (player.y + PLAYER_HEIGHT / 2);
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestPlayer = other;
                }
            }
            
            if (nearestPlayer) {
                const dx = nearestPlayer.x - player.x;
                const dir = dx > 0 ? 1 : -1;
                // Strong pull toward opponent (lunge) — does NOT override facing direction
                player.vx += dir * 2.5;
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
    
    // Reset per-frame flags at the start
    for (const [id, { player }] of players) {
        player.gotHit = false;
        
        // Decrease invincibility timer
        if (player.invincibleTimer > 0) {
            player.invincibleTimer--;
        }
        
        // Decrease hit stun timer
        if (player.hitStunTimer > 0) {
            player.hitStunTimer--;
        }
    }
    
    // --- PHASE 1: Collect all active attacks ---
    // Gather attack data before any collision processing
    const activeAttacks = [];
    for (const [id, { player }] of players) {
        const attackHitbox = getAttackHitbox(player);
        if (attackHitbox) {
            activeAttacks.push({
                attackerId: id,
                attacker: player,
                hitbox: attackHitbox
            });
        }
    }
    
    // --- PHASE 2: Check all attack-hit connections ---
    // Use a set to track which players have been hit this frame
    const hitThisFrame = new Set();
    const usedAttacks = new Set(); // Track which attacks have connected
    
    for (const [attackIndex, { attackerId, attacker, hitbox }] of activeAttacks.entries()) {
        for (const [defenderId, { player: defender }] of players) {
            if (defenderId === attackerId) continue;
            
            // Skip if defender already hit this frame (prevents double-hit)
            if (hitThisFrame.has(defenderId)) continue;
            
            // Skip if defender is invincible
            if (defender.invincibleTimer > 0) continue;
            
            // Skip if defender is dead (dead players are invulnerable)
            if (defender.isDead) continue;
            
            // Check if attack actually hits
            if (attackHitsPlayer(hitbox, defender)) {
                // Apply the hit
                applyAttackHit(defender, hitbox);
                
                // Mark both as used
                hitThisFrame.add(defenderId);
                usedAttacks.add(attackIndex);
                
                // Deactivate the attacker's hitbox (one hit per attack)
                attacker.attackActive = false;
                
                // Check if opponent should die
                if (defender.health <= 0) {
                    defender.isDead = true;
                    defender.deathTimer = 60; // ~2 seconds at 30 TPS
                }
                
                // This attack can only hit one player, stop checking
                break;
            }
        }
    }
    
    // --- PHASE 3: Physics update ---
    for (const [id, { player }] of players) {
        applyPhysics(player);
        checkCollision(player);
    }
    
    // --- PHASE 4: Body collision resolution (player-to-player push apart) ---
    // Resolve all body collisions simultaneously to prevent order-dependent behavior
    const playerArray = Array.from(players.values()).map(p => p.player);
    for (let i = 0; i < playerArray.length; i++) {
        for (let j = i + 1; j < playerArray.length; j++) {
            const a = playerArray[i];
            const b = playerArray[j];
            
            if (playersAreColliding(a, b)) {
                resolvePlayerBodyCollision(a, b);
            }
        }
    }
    
    // Apply kick magnet (lunge effect toward opponents)
    applyKickMagnet();
    
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
                sprite: player.sprite,
                gotHit: player.hitStunTimer > 0, // Multi-frame hit indication
                health: player.health,
                maxHealth: MAX_HEALTH,
                comboStage: player.comboStage,
                attackActive: player.attackActive,
                facingRight: player.facingRight,
                isDead: player.isDead,
                opacity: player.opacity,
                isFadingIn: player.isFadingIn
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
        // console.log(`Game loop: ${totalUpdates} updates, avg time: ${avgTime.toFixed(2)}ms, players: ${players.size}`);
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