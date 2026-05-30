// botAI.js - AI Bot system for Basic Multiplayer
// Handles bot spawning, pathfinding, platform navigation, vision, and combat

// ============================================================
//     // CONSTANTS
//     // ============================================================
    const BOT_VIEW_DISTANCE = 1000; // pixels (~25 game units)
    const BOT_FOV_DEGREES = 120; // field of view in degrees
    const BOT_ATTACK_RANGE = 70; // px - proximity to trigger attack (increased for earlier attacks)
    const BOT_CHASE_RANGE = 800; // px - distance to start/stop chasing
    const BOT_STUCK_TIMEOUT = 90; // ticks (3 sec at 30 TPS) before path recalc
    const BOT_PLATFORM_FAIL_TIMEOUT = 60; // ticks before giving up on a platform jump
const MAX_SINGLE_JUMP_HEIGHT = 380; // px - max height reachable with jump
const MAX_HORIZONTAL_JUMP_DIST = 800; // px - max horizontal distance for a jump
const WORLD_HEIGHT = 4000;  // must match server.js
const GROUND_EDGE_Y = WORLD_HEIGHT - 350;  // y-coord below which any platform counts as a "ground" base
    const MAX_DROP_DIST = 300; // px - max distance to consider dropping down
    const BOT_PERSONALITIES = ['aggressive', 'cautious', 'fast', 'balanced'];
    const PLAYER_WIDTH = 40;
    const PLAYER_HEIGHT = 60;
    const HITBOX_LEFT_INSET = 14;
    const HITBOX_WIDTH = PLAYER_WIDTH - HITBOX_LEFT_INSET;

// Random readable name generator for bots
const BOT_FIRST_NAMES = ['Ace', 'Bolt', 'Crash', 'Duke', 'Echo', 'Flint', 'Ghost', 'Hawk', 'Ivy', 'Jax', 'Kilo', 'Luna', 'Max', 'Neo', 'Omen', 'Phoenix', 'Quinn', 'Razor', 'Shadow', 'Titan', 'Viper', 'Wolf', 'Xena', 'Yuri', 'Zane'];
const BOT_LAST_NAMES = ['Blade', 'Chaos', 'Drift', 'Edge', 'Fury', 'Grim', 'Haze', 'Iron', 'Jolt', 'Knock', 'Light', 'Mist', 'Nova', 'Pulse', 'Quake', 'Rage', 'Storm', 'Thunder', 'Volt', 'Wave'];

function generateRandomBotName() {
    const first = BOT_FIRST_NAMES[Math.floor(Math.random() * BOT_FIRST_NAMES.length)];
    const last = BOT_LAST_NAMES[Math.floor(Math.random() * BOT_LAST_NAMES.length)];
    return `${first} ${last}`;
}

// ============================================================
// SMART JUMP-NODE A* PATHFINDING (replaces old platform graph / navmesh)
// ============================================================
// No static navmesh. At pathfinding time we treat safe positions on each
// platform (left/center/right "jump nodes") as transient nodes and run A*
// where an edge exists if a realistic single jump/drop can connect them.
// This is "smart A* with Jump Nodes".

const JUMP_NODE_MARGIN = 32;           // safe inset from platform edges for landing
const MAX_JUMP_NODES_PER_SEARCH = 420; // safety cap on A* expansions

function getJumpPointsForPlatform(p) {
    if (!p || typeof p.x !== 'number' || typeof p.w !== 'number') return [];
    const leftX   = p.x + JUMP_NODE_MARGIN;
    const rightX  = p.x + p.w - JUMP_NODE_MARGIN;
    const centerX = p.x + p.w / 2;
    return [
        { x: leftX,   type: 'left' },
        { x: centerX, type: 'center' },
        { x: rightX,  type: 'right' }
    ];
}

// Can the bot jump (or safely drop) from one jump point to another in one move?
function canJumpBetweenPoints(fromX, fromY, toX, toY) {
    const dx = Math.abs(toX - fromX);
    const dy = fromY - toY;                 // positive = target is higher
    const hDiff = Math.abs(dy);

    if (dx > MAX_HORIZONTAL_JUMP_DIST) return false;
    if (dy > 0 && hDiff > MAX_SINGLE_JUMP_HEIGHT) return false;   // upward too high
    if (dy < 0 && hDiff > MAX_DROP_DIST * 1.65) return false;     // drop too far

    return true;
}

function jumpCost(fromX, fromY, toX, toY) {
    const dx = Math.abs(toX - fromX);
    const dy = Math.abs(fromY - toY);
    return 1.0 + (dx / 185) + (dy / 145); // prefer short/flat jumps
}

function heuristicJump(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1) * 0.72;
}

// Rebuild the waypoint list from A* cameFrom data
function reconstructJumpPath(cameFrom, endKey, nodeData, platforms, targetX, targetY, targetPlatIdx) {
    const waypoints = [];
    let key = endKey;
    while (key) {
        const node = nodeData.get(key);
        if (!node) break;
        const plat = platforms[node.platIdx];
        if (plat) {
            waypoints.unshift({
                x: node.x,
                y: plat.y - PLAYER_HEIGHT,
                platformIndex: node.platIdx
            });
        }
        key = cameFrom.get(key);
    }
    // Final on-the-nose target position
    waypoints.push({
        x: targetX,
        y: targetY,
        platformIndex: targetPlatIdx
    });
    return waypoints.length > 1 ? waypoints : null;
}

// The actual smart A* over jump nodes (no prebuilt graph ever stored)
function findSmartJumpPath(botX, botY, targetX, targetY, platforms, botPlatIdx, targetPlatIdx) {
    if (botPlatIdx < 0 || targetPlatIdx < 0) return null;

    // Same platform → trivial
    if (botPlatIdx === targetPlatIdx) {
        return [{ x: targetX, y: targetY, platformIndex: targetPlatIdx }];
    }

    const botPlat = platforms[botPlatIdx];
    const startCands = getJumpPointsForPlatform(botPlat);
    // Pick the jump node closest to the bot's actual X
    let bestStart = startCands[0];
    let bestD = Infinity;
    for (const c of startCands) {
        const d = Math.abs(c.x - botX);
        if (d < bestD) { bestD = d; bestStart = c; }
    }
    const startNode = { platIdx: botPlatIdx, x: bestStart.x };
    const startKey = `${botPlatIdx}:${Math.round(startNode.x)}`;

    const open = new Set([startKey]);
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();
    const nodeData = new Map();

    gScore.set(startKey, 0);
    fScore.set(startKey, heuristicJump(startNode.x, botPlat.y, targetX, targetY));
    nodeData.set(startKey, startNode);

    let explored = 0;

    while (open.size > 0 && explored < MAX_JUMP_NODES_PER_SEARCH) {
        explored++;

        // lowest-f node
        let currentKey = null;
        let lowest = Infinity;
        for (const k of open) {
            const f = fScore.get(k) || Infinity;
            if (f < lowest) { lowest = f; currentKey = k; }
        }
        if (currentKey === null) break;

        const current = nodeData.get(currentKey);
        open.delete(currentKey);

        const currPlat = platforms[current.platIdx];

        // Success: on target platform and close in X
        if (current.platIdx === targetPlatIdx && Math.abs(current.x - targetX) < 95) {
            return reconstructJumpPath(cameFrom, currentKey, nodeData, platforms, targetX, targetY, targetPlatIdx);
        }

        // --- Neighbors: every jump point on every other platform that is reachable in one jump ---
        for (let i = 0; i < platforms.length; i++) {
            if (i === current.platIdx) continue;
            const nPlat = platforms[i];
            for (const np of getJumpPointsForPlatform(nPlat)) {
                if (!canJumpBetweenPoints(current.x, currPlat.y, np.x, nPlat.y)) continue;

                const nKey = `${i}:${Math.round(np.x)}`;
                const cost = jumpCost(current.x, currPlat.y, np.x, nPlat.y);
                const tentG = (gScore.get(currentKey) || Infinity) + cost;

                if (tentG < (gScore.get(nKey) || Infinity)) {
                    cameFrom.set(nKey, currentKey);
                    gScore.set(nKey, tentG);
                    fScore.set(nKey, tentG + heuristicJump(np.x, nPlat.y, targetX, targetY));
                    open.add(nKey);
                    nodeData.set(nKey, { platIdx: i, x: np.x });
                }
            }
        }

        // --- Cheap "walk" edges on the same platform to its other jump nodes ---
        for (const sp of getJumpPointsForPlatform(currPlat)) {
            if (Math.abs(sp.x - current.x) < 18) continue;
            const sKey = `${current.platIdx}:${Math.round(sp.x)}`;
            const tentG = (gScore.get(currentKey) || Infinity) + 0.55;
            if (tentG < (gScore.get(sKey) || Infinity)) {
                cameFrom.set(sKey, currentKey);
                gScore.set(sKey, tentG);
                fScore.set(sKey, tentG + heuristicJump(sp.x, currPlat.y, targetX, targetY));
                open.add(sKey);
                nodeData.set(sKey, { platIdx: current.platIdx, x: sp.x });
            }
        }
    }
    return null; // no route found
}

// Collect all bot paths for client debug visualization (unchanged)
function getBotPathsForDebug() {
    const botAIs = global.botAIs || new Map();
    const paths = {};
    for (const [id, ai] of botAIs) {
        if (ai.path && ai.path.length > 1) {
            paths[id] = ai.path.map(wp => ({ x: Math.round(wp.x), y: Math.round(wp.y) }));
        }
    }
    return paths;
}

// ============================================================
// PLATFORM / POSITION HELPERS (kept - used by movement & fallback logic)
// ============================================================
// Find which platform a position is standing on
function findPlatformAt(x, y, platforms) {
    const feetY = y + 60;
    let bestPlatform = -1;
    let bestOverlap = 0;

    for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        if (feetY >= p.y - 5 && feetY <= p.y + 25) {
            const overlap = Math.min(x + 40, p.x + p.w) - Math.max(x, p.x);
            if (overlap > 0 && overlap > bestOverlap) {
                bestOverlap = overlap;
                bestPlatform = i;
            }
        }
    }
    return bestPlatform;
}

// Find nearest platform (when in air)
function findNearestPlatform(x, y, platforms) {
    let nearest = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        const pCenterX = p.x + p.w / 2;
        const pCenterY = p.y + p.h / 2;
        const dist = Math.hypot((x + 20) - pCenterX, (y + 30) - pCenterY);
        if (dist < nearestDist) { nearestDist = dist; nearest = i; }
    }
    return nearest;
}

// Robust target platform detection (handles edges/airborne targets)
function findTargetPlatform(x, y, platforms) {
    let plat = findPlatformAt(x, y, platforms);
    if (plat >= 0) return plat;

    const feetY = y + 60;
    for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        if (feetY >= p.y - 60 && feetY <= p.y + 15) {
            const overlap = Math.min(x + 40, p.x + p.w) - Math.max(x, p.x);
            if (overlap > 5) return i;
        }
    }

    let bestPlat = -1, bestDist = Infinity;
    for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        if (y + 60 >= p.y) {
            const dist = Math.abs((y + 60) - p.y);
            const hOverlap = Math.min(x + 40, p.x + p.w) - Math.max(x, p.x);
            if (hOverlap > 0 && dist < bestDist) { bestDist = dist; bestPlat = i; }
        }
    }
    return bestPlat;
}

// Check if a point is above a platform (can drop down to it)
function isAbovePlatform(px, py, platform) {
    const feetY = py + 60;
    return feetY < platform.y + 10 &&
           px + 40 > platform.x &&
           px < platform.x + platform.w &&
           py > platform.y - 200;
}

// Check if two players are physically overlapping (body contact)
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

// ============================================================
// VISION SYSTEM
// ============================================================

// Check if a bot can see a target player
function canSeePlayer(botX, botY, botFacingRight, targetX, targetY, platforms) {
    // Distance check
    const dx = targetX - botX;
    const dy = targetY - botY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > BOT_VIEW_DISTANCE) return false;

    // Field of view check
    const angleToTarget = Math.atan2(dx, dy) * (180 / Math.PI);
    const facingAngle = botFacingRight ? 90 : -90;
    const angleDiff = normalizeAngle(angleToTarget - facingAngle);

    if (Math.abs(angleDiff) > BOT_FOV_DEGREES / 2) return false;

    // Line of sight check - raycast
    if (isLineBlockedByPlatforms(botX, botY + 30, targetX, targetY + 30, platforms)) {
        return false;
    }

    return true;
}

function normalizeAngle(angle) {
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
}

// Check if a line between two points is blocked by any platform
function isLineBlockedByPlatforms(x1, y1, x2, y2, platforms) {
    // Simple line-rectangle intersection check
    for (const p of platforms) {
        if (lineIntersectsRect(x1, y1, x2, y2, p.x, p.y, p.w, p.h)) {
            return true;
        }
    }
    return false;
}

// Check if a line segment intersects a rectangle
function lineIntersectsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
    // Check if either endpoint is inside the rect
    if (x1 >= rx && x1 <= rx + rw && y1 >= ry && y1 <= ry + rh) return true;
    if (x2 >= rx && x2 <= rx + rw && y2 >= ry && y2 <= ry + rh) return true;

    // Check line against each edge of the rectangle
    const edges = [
        { x: rx, y: ry, x2: rx + rw, y2: ry },       // top
        { x: rx, y: ry + rh, x2: rx + rw, y2: ry + rh }, // bottom
        { x: rx, y: ry, x2: rx, y2: ry + rh },        // left
        { x: rx + rw, y: ry, x2: rx + rw, y2: ry + rh } // right
    ];

    for (const e of edges) {
        if (lineSegmentsIntersect(x1, y1, x2, y2, e.x, e.y, e.x2, e.y2)) {
            return true;
        }
    }

    return false;
}

function lineSegmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d1x = x2 - x1, d1y = y2 - y1;
    const d2x = x4 - x3, d2y = y4 - y3;

    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 0.0001) return false; // parallel

    const t = ((x3 - x1) * d2y - (y3 - y1) * d2x) / cross;
    const u = ((x3 - x1) * d1y - (y3 - y1) * d1x) / cross;

    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// ============================================================
// MOMENTUM & JUMP PHYSICS HELPERS
// ============================================================

// Calculate how much run-up space a bot needs to clear a gap
function calculateRequiredRunUp(hGap, vDist) {
    // Physics constants (must match server.js)
    const MOVE_SPEED = 0.5;      // acceleration per tick
    const FRICTION = 0.97;       // horizontal friction per tick
    const GRAVITY = 0.5;         // gravity per tick
    const JUMP_FORCE = 10;       // base jump velocity
    const AIR_RESISTANCE = 0.98; // air resistance per tick
    
    // Simulate sprinting to find max velocity on a given platform width
    // A sprint of ~250px gives near-max velocity
    const MAX_SPEED = 8.5; // approximate terminal horizontal velocity
    
    // Calculate how far a jump at max speed will carry us
    // Time in air: solve vy0*t + 0.5*g*t^2 = vDist (we need to reach height vDist)
    // For simplicity, use approximate jump time formula
    const vy0 = JUMP_FORCE + MAX_SPEED * 0.5; // jump force + momentum bonus
    const jumpTime = Math.ceil(vy0 / GRAVITY + Math.sqrt(2 * Math.max(0, vDist) / GRAVITY));
    
    // Horizontal distance covered during jump (with air resistance)
    let hDist = 0;
    let vx = MAX_SPEED;
    for (let t = 0; t < jumpTime; t++) {
        hDist += vx;
        vx *= AIR_RESISTANCE;
    }
    
    // For a gap of hGap, we need at least this much run-up to reach MAX_SPEED
    // Speed builds up as: vx *= FRICTION each tick with MOVE_SPEED acceleration
    const minRunUp = Math.max(80, Math.min(300, hGap * 0.6));
    
    return {
        runUpNeeded: minRunUp,
        maxHorizontalDist: hDist,
        canClear: hDist >= hGap
    };
}

// ============================================================
// BOT CLASS - AI for each bot player
// ============================================================

class BotAI {
    constructor(playerId, personality = 'balanced') {
        this.playerId = playerId;
        this.personality = personality;
        this.state = 'PATROL'; // IDLE, PATROL, CHASE, ATTACK, STUCK, PATHING
        this.targetPlayerId = null;
        this.path = []; // Array of {x, y} waypoints
        this.pathIndex = 0;
        this.currentPlatformIndex = -1;
        this.targetPlatformIndex = -1;
        this.stuckTimer = 0;
        this.lastPosition = { x: 0, y: 0 };
        this.platformFailTimer = 0;
        this.jumpAttempts = 0;
        this.wanderDirection = Math.random() > 0.5 ? 1 : -1;
        this.wanderTimer = 0;
        this.lastJumpTick = 0;
        this.targetLockTimer = 0;
        this.attackCooldown = 0;
        this.debugInfo = '';
        this.revengeTargetId = null;
        this.revengeTimer = 0;
        this.recentHitByIds = [];
        this.botHitCounter = 0;
        this.botHitTargetId = null;

        // NEW: Bot collision avoidance tracking
        this.botCollisionTimer = 0;
        this.collidingBotIds = [];
        this.lastCollisionCheck = 0;

        // Path recalculation throttle
        this.pathRecalcTimer = 0;
        this.lastPathTargetX = 0;
        this.lastPathTargetY = 0;

        // Momentum tracking
        this.momentumState = 'NONE'; // NONE, BACKING_UP, SPRINTING, JUMPING
        this.momentumTimer = 0;
        this.jumpDirection = 0;
        this.runUpTarget = 0;

        // Personality modifiers
        switch (personality) {
            case 'aggressive':
                this.attackRange = BOT_ATTACK_RANGE * 0.8;
                this.chaseRange = BOT_CHASE_RANGE * 1.2;
                this.aggroMod = 1.5;
                this.jumpMod = 1.3;
                this.reactionSpeed = 0.2; // lower = faster
                break;
            case 'cautious':
                this.attackRange = BOT_ATTACK_RANGE * 1.1;
                this.chaseRange = BOT_CHASE_RANGE * 0.8;
                this.aggroMod = 0.5;
                this.jumpMod = 0.8;
                this.reactionSpeed = 0.4;
                break;
            case 'fast':
                this.attackRange = BOT_ATTACK_RANGE * 0.9;
                this.chaseRange = BOT_CHASE_RANGE;
                this.aggroMod = 1.2;
                this.jumpMod = 1.2;
                this.reactionSpeed = 0.15;
                break;
            default: // balanced
                this.attackRange = BOT_ATTACK_RANGE;
                this.chaseRange = BOT_CHASE_RANGE;
                this.aggroMod = 1.0;
                this.jumpMod = 1.0;
                this.reactionSpeed = 0.3;
                break;
        }

        // Stagger initial behavior so bots don't all move identically
        this.wanderTimer = Math.random() * 60;
        if (Math.random() > 0.5) {
            this.wanderDirection = -this.wanderDirection;
        }
    }

    // Main update - called each tick
    update(botPlayer, playerMap, platforms, worldWidth, worldHeight, currentTick) {
        if (!botPlayer || botPlayer.isDead) return;

        // Store global references for collision avoidance
        global.currentPlayerMap = playerMap;
        global.currentPlatforms = platforms;

        // Store debug info
        this.debugInfo = `${this.state} | `;

        // Update revenge timer
        if (this.revengeTimer > 0) {
            this.revengeTimer--;
            if (this.revengeTimer <= 0) {
                this.revengeTargetId = null;
                this.recentHitByIds = [];
            }
        }

        // Update current platform
        this.currentPlatformIndex = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        this.debugInfo += `plat:${this.currentPlatformIndex} | `;

        // --- Register who this bot just landed a hit on (for revenge trigger) ---
        if (botPlayer.gotHit) {
            if (this.targetPlayerId && playerMap.has(this.targetPlayerId)) {
                var attacker = playerMap.get(this.targetPlayerId).player;
                if (!attacker.isDead) {
                    this.registerHitBy(this.targetPlayerId);
                }
            } else {
                var bestAggressor = null;
                var bestAggressorScore = Infinity;
                for (var pair of playerMap) {
                    var id = pair[0];
                    var p = pair[1].player;
                    if (id === this.playerId || p.isDead) continue;
                    var dx = p.x - botPlayer.x;
                    var dy_1 = p.y - botPlayer.y;
                    var dist = Math.sqrt(dx * dx + dy_1 * dy_1);
                    if (dist > BOT_ATTACK_RANGE * 3) continue;
                    var facingAway = (p.facingRight && p.x < botPlayer.x)
                                 || (!p.facingRight && p.x > botPlayer.x);
                    var score = dist + (facingAway ? 0 : 200);
                    if (score < bestAggressorScore) {
                        bestAggressorScore = score;
                        bestAggressor = p;
                    }
                }
                if (bestAggressor) {
                    this.registerHitBy(bestAggressor.id);
                }
            }
        }

        // --- Bot-vs-bot multi-hit escalation: track cumulative hits from other bots ---
        if (botPlayer.gotHit) {
            for (const [id, { player }] of playerMap) {
                if (id === this.playerId || player.isDead || !player.isBot) continue;
                // Within a 3× attack-radius to confirm it was a recent bot hit
                var bx = player.x - botPlayer.x, by = player.y - botPlayer.y;
                if (Math.sqrt(bx * bx + by * by) <= BOT_ATTACK_RANGE * 3) {
                    if (this.botHitTargetId !== id) {
                        this.botHitTargetId = id;
                        this.botHitCounter = 1;
                    } else {
                        this.botHitCounter++;
                    }
                    // After 2-3 confirmed bot hits, register as genuine revenge target
                    if (this.botHitCounter >= 3) {
                        this.registerHitBy(id);
                    }
                    break;
                }
            }
        }

        // --- Revenge override: if someone hit us recently, hunt them first ---
        if (this.recentHitByIds.length > 0) {
            var revengeTargetId = this.recentHitByIds[0];
            var revengeTarget = playerMap.get(revengeTargetId);
            if (revengeTarget && !revengeTarget.player.isDead) {
                this.targetPlayerId = revengeTargetId;
                this.targetLockTimer = 30;
                this.state = 'CHASE';
            }
        }

        // --- Body contact: if we are touching a human player, attack them immediately ---
        this.checkContactTargets(botPlayer, playerMap);

        // --- State Machine ---
        const visibleTarget = this.assessThreats(botPlayer, playerMap, platforms);
        let targetPlayer = null;
        let target = null;

        if (visibleTarget) {
            targetPlayer = visibleTarget;
            target = { x: targetPlayer.x, y: targetPlayer.y };
            this.targetPlayerId = targetPlayer.id;
            this.targetLockTimer = 180; // keep lock for 6 seconds
        } else if (this.targetLockTimer > 0) {
            // Keep last known target position
            this.targetLockTimer--;
            const lastKnown = this.findPlayerById(playerMap, this.targetPlayerId);
            if (lastKnown) {
                target = { x: lastKnown.x, y: lastKnown.y };
            }
        }

        if (target && this.state !== 'ATTACK') {
            // Check distance to determine state
            const dx = target.x - botPlayer.x;
            const dy = target.y - botPlayer.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist <= this.attackRange && this.canAttackTarget(botPlayer, targetPlayer, platforms)) {
                this.state = 'ATTACK';
            } else if (dist <= this.chaseRange || this.targetLockTimer > 0) {
                this.state = 'CHASE';
            } else {
                this.state = 'PATROL';
            }
        } else if (this.state === 'ATTACK' && !this.canAttackTarget(botPlayer, targetPlayer, platforms)) {
            this.state = 'CHASE';
        }

        // If no target visible and not locked, patrol
        if (!target) {
            this.state = 'PATROL';
            this.targetPlayerId = null;
        }

        // --- Climbing check - only climb if it's beneficial, not when attacking ---
        // Check if bot is near a platform side and should jump to climb
        if (!botPlayer.isClimbing && !botPlayer.isDead) {
            // Don't climb if there's an attackable target nearby
            const canAttackNow = target && this.canAttackTarget(botPlayer, target, platforms);
            if (!canAttackNow) {
                const climbResult = this.checkNearPlatformSide(botPlayer, platforms);
                if (climbResult) {
                    // Only climb if target is above or if no target (patrol mode)
                    const shouldClimb = !target || (target.y < botPlayer.y - 50);
                    if (shouldClimb) {
                        // Set jump input when near platform side - server physics will handle climbing
                        botPlayer.inputs.jump = true;
                        this.debugInfo += 'CLIMB ';
                        return;
                    }
                }
            }
        }

        // Use A* pathfinding to navigate through multiple platforms
        if (target) {
            const targetPlatIdx = findPlatformAt(target.x, target.y, platforms);
            if (targetPlatIdx >= 0) {
                const targetPlat = platforms[targetPlatIdx];
                // Only climb if target platform is above bot
                if (targetPlat.y < botPlayer.y - 10) {
                    const moveDir = target.x > botPlayer.x ? 1 : -1;
                    
                    // Use A* pathfinding to find optimal path through platforms
                    const path = this.findPathToPlatform(botPlayer, targetPlat, platforms);
                    
                    if (path && path.length > 1) {
                        // Get next platform in path (skip current)
                        const nextPlatform = path[1];
                        // Aim for the SIDE of the platform to trigger climbing
                        const climbTargetX = moveDir > 0 ? nextPlatform.x - PLAYER_WIDTH : nextPlatform.x + nextPlatform.w;
                        
                        botPlayer.inputs.right = moveDir > 0;
                        botPlayer.inputs.left = moveDir < 0;
                        botPlayer.inputs.jump = true;
                        this.debugInfo += 'ASTAR_PATH_' + path.length + ' ';
                        return;
                    } else if (path && path.length === 1) {
                        // Already on target platform
                        // Aim for the SIDE of the platform to trigger climbing
                        const climbTargetX = moveDir > 0 ? targetPlat.x - PLAYER_WIDTH : targetPlat.x + targetPlat.w;
                        botPlayer.inputs.right = moveDir > 0;
                        botPlayer.inputs.left = moveDir < 0;
                        botPlayer.inputs.jump = true;
                        this.debugInfo += 'CLIMB_TARGET ';
                        return;
                    } else {
                        // No path found, but target is above - aim for platform side directly
                        const climbTargetX = moveDir > 0 ? targetPlat.x - PLAYER_WIDTH : targetPlat.x + targetPlat.w;
                        // Move toward the side of the platform
                        this.moveToward(botPlayer, climbTargetX, platforms);
                        // Jump when close to the platform side
                        const distToSide = Math.abs(botPlayer.x - climbTargetX);
                        if (distToSide < 50) {
                            botPlayer.inputs.jump = true;
                            this.debugInfo += 'AIM_SIDE ';
                        }
                        return;
                    }
                }
            }
        }

        // --- Execute behavior based on state ---
        switch (this.state) {
            case 'PATROL':
                this.patrolBehavior(botPlayer, platforms, worldWidth, currentTick);
                break;
            case 'CHASE':
                this.chaseBehavior(botPlayer, target, platforms, currentTick);
                break;
            case 'ATTACK':
                this.attackBehavior(botPlayer, targetPlayer, platforms, currentTick);
                break;
        }

        // --- Anti-stuck logic ---
        this.antiStuckCheck(botPlayer, platforms, currentTick);

        // --- Attack cooldown ---
        if (this.attackCooldown > 0) this.attackCooldown--;
    }

    assessThreats(botPlayer, playerMap, platforms) {
        var botAIs = global.botAIs || new Map();

        var closestTarget = null;
        var closestDist = Infinity;
        var closestHuman = null;
        var closestHumanDist = Infinity;

         // ---- PASS 1: collect raw candidates ----
        for (var pair of playerMap) {
            var id = pair[0];
            var data = pair[1];
            var player = data.player;
            if (id === this.playerId || player.isDead || player.isSpectator) continue;

            var dx = player.x - botPlayer.x;
            var dy = player.y - botPlayer.y;
            var dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > BOT_VIEW_DISTANCE) continue;

            var isHuman = !player.isBot;

            // Revenge priority: return immediately if someone just hit us
            if (this.recentHitByIds.indexOf(id) !== -1) {
                return player;
            }

            if (isHuman) {
                // Penalise airborne human targets — bots should prefer grounded players
                var groundedPenalty = player.onGround ? 0 : 500;
                if (dist + groundedPenalty < closestHumanDist) {
                    closestHumanDist = dist + groundedPenalty;
                    closestHuman = player;
                }
                continue;
            }

            // Fellow bots: FOV + LOS required
            var angleToTarget = Math.atan2(dx, dy) * (180 / Math.PI);
            var facingAngle = botPlayer.facingRight ? 90 : -90;
            var angleDiff = normalizeAngle(angleToTarget - facingAngle);

            if (Math.abs(angleDiff) > BOT_FOV_DEGREES / 2) continue;

            if (isLineBlockedByPlatforms(botPlayer.x + 20, botPlayer.y + 30,
                player.x + 20, player.y + 30, platforms)) {
                continue;
            }

             if (dist < closestDist) {
                 closestDist = dist;
                 closestTarget = player;
             }
         }

         // ---- PASS 2: count how many bots are already targeting each candidate ----
         var targetCounts = new Map();

        for (var pair2 of playerMap) {
            var id2 = pair2[0];
            var data2 = pair2[1];
            if (!data2.player.isBot || id2 === this.playerId) continue;
            var ai = botAIs.get(id2);
            if (!ai || !ai.targetPlayerId) continue;
            var tgt = ai.targetPlayerId;
            var tgtData = playerMap.get(tgt);
            if (tgtData) {
                targetCounts.set(tgt, (targetCounts.get(tgt) || 0) + 1);
            }
        }

        // ---- PASS 3: score candidates with focus-fire penalty ----
        function scoreTarget(p, baseScore) {
            var botsOnTarget = targetCounts.get(p.id) || 0;
            return baseScore + botsOnTarget * 100;
        }

        var selectedHuman = null;
        var bestHumanScore = Infinity;
        if (closestHuman) {
            var humanScore = scoreTarget(closestHuman, 0);
            bestHumanScore = humanScore;
            selectedHuman = closestHuman;
        }

        var selectedBot = null;
        var bestBotScore = Infinity;
        if (closestTarget) {
            var botScore = scoreTarget(closestTarget, 200);
            bestBotScore = botScore;
            selectedBot = closestTarget;
        }

        // ---- PASS 4: decide final target ----
        if (selectedHuman && (!selectedBot || bestHumanScore <= bestBotScore)) {
            return selectedHuman;
        }
        if (selectedBot) {
            return selectedBot;
        }
        return null;
    }

    findPlayerById(playerMap, id) {
        for (const [pid, { player }] of playerMap) {
            if (pid === id) return player;
        }
        return null;
    }

    // Call when *someone else* attacked this bot — sets up a revenge cycle
    registerHitBy(attackerId) {
        if (this.recentHitByIds.indexOf(attackerId) === -1) {
            this.recentHitByIds.push(attackerId);
        }
        // Revenge priority: last 3 seconds @ 30 TPS
        this.revengeTimer = 90;
        this.lastAttackTime = Date.now();
        this.attackActive = false;
    }

     // Check for physical body contact with any player (human or bot)
     // If this bot bumps into or is bumped by a bot, it will attack
     checkContactTargets(botPlayer, playerMap) {
         for (const [id, { player }] of playerMap) {
             if (id === this.playerId || player.isDead || player.isSpectator) continue;
             
             // Check for direct collision
             if (playersAreColliding(botPlayer, player)) {
                 this.targetPlayerId = id;
                 this.targetLockTimer = 120; // hold target for 4 seconds on contact
                 this.state = 'ATTACK';
                 return;
             }
             
             // NEW: Check for prolonged proximity with other bots (stuck together)
             if (player.isBot) {
                 const dx = Math.abs(player.x - botPlayer.x);
                 const dy = Math.abs(player.y - botPlayer.y);
                 
                 // If bots are very close and have been colliding
                 if (dx < 50 && dy < 30 && this.collidingBotIds.includes(id)) {
                     // If we've been stuck with this bot for a while, attack them
                     if (this.botCollisionTimer > 45) { // 1.5 seconds
                         this.targetPlayerId = id;
                         this.targetLockTimer = 90;
                         this.state = 'ATTACK';
                         this.debugInfo += 'STUCK_FIGHT ';
                         return;
                     }
                 }
             }
         }
     }

    canAttackTarget(botPlayer, targetPlayer, platforms) {
        if (!targetPlayer) return false;
        const dx = targetPlayer.x - botPlayer.x;
        const dy = targetPlayer.y - botPlayer.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Require roughly same vertical level to avoid attacking from different heights
        const verticalThreshold = 30; // pixels
        if (Math.abs(dy) > verticalThreshold) return false;
        return dist <= BOT_ATTACK_RANGE * 1.3;
    }

    // ============================================================
    // BEHAVIORS
    // ============================================================

    patrolBehavior(botPlayer, platforms, worldWidth, currentTick) {
        this.wanderTimer--;

        if (this.wanderTimer <= 0) {
            // Change direction or idle
            if (Math.random() > 0.3) {
                this.wanderDirection *= -1;
            }
            this.wanderTimer = 60 + Math.random() * 120;
        }

        // Walk in wander direction
        const moveLeft = this.wanderDirection < 0;
        const moveRight = this.wanderDirection > 0;

        botPlayer.inputs.right = moveRight;
        botPlayer.inputs.left = moveLeft;

        // Check if at platform edge
        if (this.isAtPlatformEdge(botPlayer, platforms, this.wanderDirection)) {
            // Build momentum before jumping off edge during patrol
            const atEdge = this.isAtPlatformEdge(botPlayer, platforms, this.wanderDirection);
            if (atEdge && Math.random() > 0.3) {
                // Back up to build run-up, then sprint and jump
                this.buildMomentumAndJump(botPlayer, platforms, currentTick, this.wanderDirection, true);
            } else {
                this.wanderDirection *= -1;
                botPlayer.inputs.right = !moveRight;
                botPlayer.inputs.left = !moveLeft;
            }
        }

        // Random jumps - only if not at edge
        if (Math.random() < 0.02 * this.jumpMod && botPlayer.onGround) {
            botPlayer.inputs.jump = true;
        }

        this.debugInfo += 'PATROL';
    }

    chaseBehavior(botPlayer, target, platforms, currentTick) {
        if (!target) {
            this.state = 'PATROL';
            return;
        }

        // If the chased target is a real player object, check if they're airborne.
        // When the player is in mid-air, predict where they'll land and move there
        if (target.isBot === false && !target.onGround) {
            const predictedLanding = this.predictPlayerLanding(target, platforms);
            if (predictedLanding) {
                target = predictedLanding;
                this.debugInfo += 'PREDICT_LAND ';
            } else {
                // Can't predict landing, move to their current X but stay on our platform
                const botPlat = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
                if (botPlat >= 0) {
                    const plat = platforms[botPlat];
                    const clampedX = Math.max(plat.x + 20, Math.min(plat.x + plat.w - 20, target.x));
                    this.moveToward(botPlayer, clampedX, platforms);
                    this.debugInfo += 'WAIT_LAND';
                    return;
                }
            }
        }

        // Get robust platform detection for both bot and target
        const botPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        const targetPlatIdx = findTargetPlatform(target.x, target.y, platforms);

        // Clamp chase target so the bot stops at combat distance
        target = this.getCombatTarget(botPlayer, target);

        // --- PATH RECALC THROTTLE: Only recalc path every 10 ticks or when target moves significantly ---
        const targetMovedSignificantly = Math.abs(target.x - this.lastPathTargetX) > 100 || Math.abs(target.y - this.lastPathTargetY) > 100;
        const shouldRecalcPath = this.pathRecalcTimer <= 0 || targetMovedSignificantly || this.path.length <= 1;

        if (shouldRecalcPath) {
            this.pathRecalcTimer = 10;
            this.lastPathTargetX = target.x;
            this.lastPathTargetY = target.y;

            // Use the new smart Jump-Node A* (no navmesh)
            if (botPlatIdx >= 0 && targetPlatIdx >= 0) {
                const jnPath = findSmartJumpPath(
                    botPlayer.x, botPlayer.y,
                    target.x, target.y,
                    platforms, botPlatIdx, targetPlatIdx
                );
                if (jnPath && jnPath.length > 1) {
                    this.path = jnPath;
                    this.pathIndex = 0;
                    this.debugInfo += 'JUMP_NODE_A* ';
                } else {
                    this.path = [];
                }
            } else {
                this.path = [];
            }
        } else {
            this.pathRecalcTimer--;
        }

        // Execute movement - use existing path if valid, otherwise fallback
        if (this.path.length > 1 && this.pathIndex < this.path.length) {
            this.followPath(botPlayer, platforms, currentTick);
        } else {
            // Fallback: intelligent direct movement
            this.smartDirectMove(botPlayer, target.x, target.y, platforms, currentTick);
        }

        this.debugInfo += `CHASE->(${Math.round(target.x)},${Math.round(target.y)})`;
    }

    // ================================================================
    // NEW: Predict where an airborne player will land
    // ================================================================
    predictPlayerLanding(player, platforms) {
        if (player.onGround) return { x: player.x, y: player.y };

        // Simple physics prediction - assume they'll fall straight down
        let predictX = player.x + (player.vx || 0) * 10;
        let predictY = player.y;

        // Find the platform they'll likely land on
        for (const p of platforms) {
            if (predictX + 20 > p.x && predictX + 20 < p.x + p.w && p.y > predictY) {
                return { x: predictX, y: p.y };
            }
        }

        // Fallback to current position
        return { x: player.x, y: player.y };
    }

    // ================================================================
    // NEW: Find platforms reachable with a jump from current position
    // ================================================================
    findReachablePlatforms(botPlayer, platforms, direction) {
        const botPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        if (botPlatIdx < 0) return [];

        const botPlat = platforms[botPlatIdx];
        const jumpStartX = direction > 0 ? botPlat.x + botPlat.w : botPlat.x;
        const reachable = [];

        for (const p of platforms) {
            if (p === botPlat) continue;

            const heightDiff = botPlat.y - p.y;
            const horizontalDist = direction > 0 
                ? Math.max(0, p.x - jumpStartX)
                : Math.max(0, jumpStartX - (p.x + p.w));

            // Check if reachable with jump
            const canReachHeight = heightDiff <= MAX_SINGLE_JUMP_HEIGHT && heightDiff >= -MAX_DROP_DIST;
            const canReachDistance = horizontalDist <= MAX_HORIZONTAL_JUMP_DIST;

            if (canReachHeight && canReachDistance) {
                reachable.push(p);
            }
        }

        return reachable;
    }

    // ================================================================
    // NEW: Find where we would land if we drop/jump in a direction
    // ================================================================
    findLandingPlatform(botPlayer, platforms, direction) {
        const botPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        if (botPlatIdx < 0) return null;

        const botPlat = platforms[botPlatIdx];
        const searchX = direction > 0 ? botPlat.x + botPlat.w + 50 : botPlat.x - 50;

        // Find the highest platform below our current position in the search direction
        let bestPlatform = null;
        let bestY = Infinity;

        for (const p of platforms) {
            if (p === botPlat) continue;
            if (p.y <= botPlat.y) continue; // Must be below us

            // Check if the platform is in our landing zone
            if (searchX >= p.x - 50 && searchX <= p.x + p.w + 50) {
                if (p.y < bestY) {
                    bestY = p.y;
                    bestPlatform = p;
                }
            }
        }

        return bestPlatform;
    }

    // ================================================================
    // Calculate an intelligent landing position on a platform
    // (used by smartDirectMove and path helpers)
    // ================================================================
    calculateLandingPosition(platform, targetX) {
        if (!platform || typeof platform.x !== 'number' || typeof platform.w !== 'number') {
            return targetX;
        }

        const margin = 30;
        const minX = platform.x + margin;
        const maxX = platform.x + platform.w - margin;

        let landX = targetX;
        if (landX < minX) landX = minX;
        if (landX > maxX) landX = maxX;

        // Avoid standing exactly on the very edge
        if (landX - platform.x < 60) landX = platform.x + 40;
        if ((platform.x + platform.w) - landX < 60) landX = platform.x + platform.w - 40;

        return landX;
    }

    attackBehavior(botPlayer, targetPlayer, platforms, currentTick) {
        if (!targetPlayer) {
            this.state = 'CHASE';
            return;
        }

        // If the target is a human player who is airborne, hold position
        if (!targetPlayer.isBot && !targetPlayer.onGround) {
            botPlayer.inputs.right = false;
            botPlayer.inputs.left = false;
            botPlayer.inputs.jump = false;
            botPlayer.inputs.down = false;
            this.debugInfo += 'ATTACK(WAIT)';
            return;
        }

        // Calculate distance and direction to target
        const dx = targetPlayer.x - botPlayer.x;
        const dy = targetPlayer.y - botPlayer.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Optimal attack distance - close enough to attack but not overlapping
        const optimalDistance = BOT_ATTACK_RANGE * 0.8;
        const tooCloseDistance = 25;

        // Face the target
        if (targetPlayer.x < botPlayer.x) {
            botPlayer.inputs.right = false;
            botPlayer.inputs.left = true;
        } else {
            botPlayer.inputs.right = true;
            botPlayer.inputs.left = false;
        }

        // Movement logic based on distance
        if (dist < tooCloseDistance) {
            // Too close - back up to get to optimal attack distance
            if (targetPlayer.x < botPlayer.x) {
                botPlayer.inputs.right = true;
                botPlayer.inputs.left = false;
            } else {
                botPlayer.inputs.right = false;
                botPlayer.inputs.left = true;
            }
        } else if (dist > BOT_ATTACK_RANGE * 1.2) {
            // Too far - move toward target
            if (targetPlayer.x < botPlayer.x) {
                botPlayer.inputs.right = false;
                botPlayer.inputs.left = true;
            } else {
                botPlayer.inputs.right = true;
                botPlayer.inputs.left = false;
            }
        } else {
            // In good attack range - strafe occasionally
            if (Math.random() < 0.03) {
                if (Math.random() > 0.5) {
                    botPlayer.inputs.right = true;
                    botPlayer.inputs.left = false;
                } else {
                    botPlayer.inputs.right = false;
                    botPlayer.inputs.left = true;
                }
            } else {
                botPlayer.inputs.right = false;
                botPlayer.inputs.left = false;
            }
        }

        // Attack when in range
        if (dist <= BOT_ATTACK_RANGE && this.attackCooldown <= 0) {
            botPlayer.inputs.attack = true;
            this.attackCooldown = 15 + Math.random() * 10;

            if (this.personality === 'aggressive') {
                this.attackCooldown *= 0.7;
            }
        } else if (dist > BOT_ATTACK_RANGE * 1.5) {
            this.state = 'CHASE';
        }

        // Don't walk off edges while attacking
        if (this.isAtPlatformEdge(botPlayer, platforms, botPlayer.facingRight ? 1 : -1)) {
            if (botPlayer.facingRight) {
                botPlayer.inputs.right = false;
                botPlayer.inputs.left = true;
            } else {
                botPlayer.inputs.right = true;
                botPlayer.inputs.left = false;
            }
        }

        // Small strafing jumps
        if (Math.random() < 0.03 && botPlayer.onGround) {
            botPlayer.inputs.jump = true;
        }

        this.debugInfo += 'ATTACK';
    }

    // ============================================================
    // PATHFINDING & MOVEMENT
    // ============================================================

    // Thin wrapper kept for compatibility — real work is now in global findSmartJumpPath (Jump-Node A*)
    pathfindToTarget(botPlayer, targetX, targetY, platforms, currentTick) {
        const botPlat = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        const tgtPlat = findTargetPlatform(targetX, targetY, platforms);

        if (botPlat < 0 || tgtPlat < 0) {
            this.path = [{ x: targetX, y: targetY, platformIndex: tgtPlat }];
            this.pathIndex = 0;
            return;
        }

        const jn = findSmartJumpPath(botPlayer.x, botPlayer.y, targetX, targetY, platforms, botPlat, tgtPlat);
        if (jn && jn.length > 1) {
            this.path = jn;
            this.pathIndex = 0;
        } else {
            this.path = [{ x: targetX, y: targetY, platformIndex: tgtPlat }];
            this.pathIndex = 0;
        }
    }

    followPath(botPlayer, platforms, currentTick) {
        if (this.pathIndex >= this.path.length) {
            this.path = [];
            this.pathIndex = 0;
            return;
        }

        const waypoint = this.path[this.pathIndex];

        // Check if reached current waypoint
        const dx = waypoint.x - botPlayer.x;
        const dy = waypoint.y - botPlayer.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 30) {
            this.pathIndex++;
            if (this.pathIndex >= this.path.length) return;
            this.followPath(botPlayer, platforms, currentTick);
            return;
        }

        // Determine if we need to change platforms
        const currentPlat = this.currentPlatformIndex;
        const targetPlat = waypoint.platformIndex;

        if (currentPlat !== targetPlat && currentPlat >= 0 && targetPlat >= 0) {
            // Need to transition platforms
            const a = platforms[currentPlat];
            const b = platforms[targetPlat];

            if (b.y < a.y) {
                // Target platform is above - aim for the SIDE to trigger climbing
                const moveDir = waypoint.x > botPlayer.x ? 1 : -1;
                const climbTargetX = moveDir > 0 ? b.x - PLAYER_WIDTH : b.x + b.w;
                this.moveTowardWithJump(botPlayer, climbTargetX, waypoint.y, platforms, currentTick, true);
            } else if (b.y > a.y) {
                // Target platform is below - need to drop or walk off edge
                if (this.isAbovePlatform(botPlayer.x, botPlayer.y, b)) {
                    this.moveTowardWithJump(botPlayer, waypoint.x, waypoint.y, platforms, currentTick, false);
                } else {
                    this.moveToward(botPlayer, waypoint.x, platforms);
                    if (this.isAtPlatformEdge(botPlayer, platforms, dx > 0 ? 1 : -1)) {
                        botPlayer.inputs.down = true;
                    }
                }
            } else {
                // Same level - just walk
                this.moveToward(botPlayer, waypoint.x, platforms);
            }
        } else {
            // Same platform - walk toward waypoint with momentum management
            // If we're approaching an edge with a planned jump, use momentum
            const moveDir = dx > 0 ? 1 : -1;
            const isEdge = this.isAtPlatformEdge(botPlayer, platforms, moveDir);
            
            if (isEdge && this.pathIndex + 1 < this.path.length) {
                // About to transition - use momentum-based jump
                this.buildMomentumAndJump(botPlayer, platforms, currentTick, moveDir, true);
            } else {
                this.moveToward(botPlayer, waypoint.x, platforms);
            }
        }
    }

    isGroundPlatform(botPlayer, platforms) {
        if (!botPlayer.onGround) return false;
        const feetY = botPlayer.y + 60;

        for (const p of platforms) {
            if (feetY >= p.y - 5 && feetY <= p.y + 15) {
                // Ground level (bottom of world) or any platform wider than a typical floor landing
                if (p.y >= GROUND_EDGE_Y || p.w > 800) return true;
                break;
            }
        }
        return false;
    }

    // ================================================================
    // NEW: Check if a platform index is a ground platform
    // ================================================================
    isGroundPlatformByIndex(platIdx, platforms) {
        if (platIdx < 0 || platIdx >= platforms.length) return false;
        const p = platforms[platIdx];
        return p.y >= GROUND_EDGE_Y || p.w > 800;
    }

    findNearestAbovePlatform(botPlayer, platforms) {
        const botPlat = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        if (botPlat < 0) return null;
        
        const currentPlat = platforms[botPlat];
        let best = null;
        let bestDist = Infinity;
        
        for (let i = 0; i < platforms.length; i++) {
            if (i === botPlat) continue;
            const p = platforms[i];
            if (p.y >= currentPlat.y) continue;
            const heightDiff = currentPlat.y - p.y;
            if (heightDiff > MAX_SINGLE_JUMP_HEIGHT) continue;
            const hOverlap = Math.min(botPlayer.x + 40, p.x + p.w) - Math.max(botPlayer.x, p.x);
            if (hOverlap > 0) {
                const underX = Math.max(p.x, Math.min(botPlayer.x, p.x + p.w));
                const dist = Math.abs(botPlayer.x - underX);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { platform: p, underX: underX, edgeReached: hOverlap > 5 };
                }
            }
        }
        return best;
    }

    findClosestClimbablePlatform(botPlayer, platforms) {
        let bestPlat = null;
        let bestDist = Infinity;
        const feetY = botPlayer.y + 60;
        
        let currentPlat = null;
        for (const p of platforms) {
            if (feetY >= p.y - 5 && feetY <= p.y + 15) {
                currentPlat = p;
                break;
            }
        }
        if (!currentPlat) return null;
        
        for (const p of platforms) {
            if (p === currentPlat) continue;
            if (p.y >= currentPlat.y) continue;
            const heightDiff = currentPlat.y - p.y;
            if (heightDiff > MAX_SINGLE_JUMP_HEIGHT) continue;
            
            const nearestX = Math.max(p.x, Math.min(botPlayer.x + 20, p.x + p.w));
            const dx = botPlayer.x - nearestX;
            const dist = Math.abs(dx);
            
            if (dist < bestDist) {
                bestDist = dist;
                bestPlat = {
                    platform: p,
                    targetX: nearestX,
                    dist: dist,
                    toRight: dx < 0
                };
            }
        }
        return bestPlat;
    }

    getCombatTarget(botPlayer, target) {
        if (!target) return null;

        const bx = botPlayer.x;
        const tx = target.x;
        const ty = target.y;

        const desiredChaseDist = this.attackRange + 60;

        const dx = tx - bx;
        const absDx = Math.abs(dx);

        if (absDx <= desiredChaseDist) {
            return { x: tx, y: ty };
        }

        const sideOffset = 60;
        const targetX = dx > 0 ? tx + sideOffset : tx - sideOffset;

        return { x: targetX, y: ty };
    }

    // Check if bot is near a platform side and should jump to climb
    checkNearPlatformSide(botPlayer, platforms) {
        const hitboxLeft = botPlayer.x + HITBOX_LEFT_INSET;
        const hitboxRight = hitboxLeft + HITBOX_WIDTH;
        const hitboxBottom = botPlayer.y + PLAYER_HEIGHT;

        for (const plat of platforms) {
            const platLeft = plat.x;
            const platRight = plat.x + plat.w;
            const platTop = plat.y;

            // Check if platform is above bot and reachable
            if (platTop >= botPlayer.y) continue; // Platform not above
            const heightDiff = botPlayer.y - platTop;
            if (heightDiff > MAX_SINGLE_JUMP_HEIGHT) continue; // Too high

            // Check if bot is horizontally aligned with platform
            const horizontalOverlap = Math.max(0, Math.min(hitboxRight, platRight) - Math.max(hitboxLeft, platLeft));
            
            // Check if bot is close to the LEFT side of platform
            const distToLeft = Math.abs(hitboxRight - platLeft);
            if (distToLeft < 30 && horizontalOverlap < 20) {
                // Bot is near left side, facing right would hit it
                if (botPlayer.facingRight) {
                    return true;
                }
            }

            // Check if bot is close to the RIGHT side of platform
            const distToRight = Math.abs(hitboxLeft - platRight);
            if (distToRight < 30 && horizontalOverlap < 20) {
                // Bot is near right side, facing left would hit it
                if (!botPlayer.facingRight) {
                    return true;
                }
            }
        }
        return false;
    }

    // Stub for the old A* platform climber (methods were removed).
    // Returning null makes the climbing block safely skip to normal chase logic.
    findPathToPlatform(botPlayer, targetPlatform, platforms) {
        return null;
    }

    smartDirectMove(botPlayer, targetX, targetY, platforms, currentTick) {
        // Basic fallback implementation.
        // The full platform-aware "smart" version was accidentally deleted.
        // Using moveToward keeps bots functional without crashing.
        this.moveToward(botPlayer, targetX, platforms);
    }

    directMove(botPlayer, targetX, targetY, platforms, currentTick) {
        // Redirect to smartDirectMove for compatibility
        this.smartDirectMove(botPlayer, targetX, targetY, platforms, currentTick);
    }

    moveToward(botPlayer, targetX, platforms) {
        const dx = targetX - botPlayer.x;
        if (Math.abs(dx) < 10) {
            botPlayer.inputs.left = false;
            botPlayer.inputs.right = false;
            return;
        }

        // NEW: Check for bot collision avoidance
        const avoidanceDirection = this.checkBotCollisionAvoidance(botPlayer, dx > 0 ? 1 : -1);
        
        if (avoidanceDirection !== 0) {
            // Move in avoidance direction instead of toward target
            if (avoidanceDirection > 0) {
                botPlayer.inputs.right = true;
                botPlayer.inputs.left = false;
                botPlayer.facingRight = true;
            } else {
                botPlayer.inputs.right = false;
                botPlayer.inputs.left = true;
                botPlayer.facingRight = false;
            }
            this.debugInfo += 'AVOID ';
            return;
        }

        if (dx > 0) {
            botPlayer.inputs.right = true;
            botPlayer.inputs.left = false;
            botPlayer.facingRight = true;
        } else {
            botPlayer.inputs.right = false;
            botPlayer.inputs.left = true;
            botPlayer.facingRight = false;
        }
    }

    // NEW: Check for bot collision avoidance
    checkBotCollisionAvoidance(botPlayer, intendedDirection) {
        // Get reference to global playerMap from the update context
        const playerMap = global.currentPlayerMap;
        if (!playerMap) return 0;

        const COLLISION_CHECK_DISTANCE = 80; // pixels ahead to check
        const COLLISION_WIDTH = 60; // width of collision zone
        const AVOIDANCE_DISTANCE = 120; // how far to look for alternate paths

        // Check for bots directly in our path
        const checkX = botPlayer.x + (intendedDirection * COLLISION_CHECK_DISTANCE);
        const botsInPath = [];
        
        for (const [id, { player }] of playerMap) {
            if (id === this.playerId || !player.isBot || player.isDead) continue;
            
            // Check if bot is in our intended path
            const dx = Math.abs(player.x - checkX);
            const dy = Math.abs(player.y - botPlayer.y);
            
            if (dx < COLLISION_WIDTH && dy < 40) {
                botsInPath.push({ id, player, distance: dx });
            }
        }

        if (botsInPath.length === 0) {
            this.botCollisionTimer = 0;
            this.collidingBotIds = [];
            return 0; // No collision, move normally
        }

        // Track collision duration
        this.botCollisionTimer++;
        
        // Update colliding bot IDs
        const currentCollidingIds = botsInPath.map(b => b.id);
        this.collidingBotIds = currentCollidingIds;

        // If we've been colliding for too long, make bots attack each other
        if (this.botCollisionTimer > 60) { // 2 seconds at 30 TPS
            const closestBot = botsInPath.reduce((closest, bot) => 
                bot.distance < closest.distance ? bot : closest
            );
            
            // Register the blocking bot as a target for revenge
            this.registerHitBy(closestBot.id);
            this.debugInfo += 'BOT_RAGE ';
            this.botCollisionTimer = 0; // Reset timer after triggering rage
            return 0; // Let normal movement continue so we can attack
        }

        // Try to find an alternate path around the collision
        // Check if we can go around (up/down on platform or slight detour)
        const currentPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, global.currentPlatforms || []);
        if (currentPlatIdx >= 0) {
            const platform = global.currentPlatforms[currentPlatIdx];
            
            // Try to move to edge of platform to go around
            if (intendedDirection > 0) {
                // Going right, try to go to right edge first
                const rightEdge = platform.x + platform.w - 30;
                if (botPlayer.x < rightEdge - 20) {
                    return 1; // Move right to edge
                }
            } else {
                // Going left, try to go to left edge first  
                const leftEdge = platform.x + 30;
                if (botPlayer.x > leftEdge + 20) {
                    return -1; // Move left to edge
                }
            }
        }

        // If we can't find a good avoidance path, try opposite direction briefly
        if (this.botCollisionTimer > 30) { // After 1 second, try backing up
            return -intendedDirection;
        }

        return 0; // Default: no avoidance
    }

    // === IMPROVED MOMENTUM-BASED JUMPING SYSTEM ===
    // The bot intelligently backs up to build run-up space, then sprints toward
    // the edge and jumps at the optimal moment for maximum horizontal distance.

    // Core momentum management: back up, sprint, jump at the right moment
    buildMomentumAndJump(botPlayer, platforms, currentTick, jumpDirection, shouldJump) {
        const currentPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        if (currentPlatIdx < 0 || !botPlayer.onGround) {
            // Fallback: just face direction and jump
            botPlayer.inputs.right = jumpDirection > 0;
            botPlayer.inputs.left = jumpDirection < 0;
            botPlayer.facingRight = jumpDirection > 0;
            if (shouldJump) botPlayer.inputs.jump = true;
            return;
        }
        
        const currentPlat = platforms[currentPlatIdx];
        const edgeX = jumpDirection > 0 ? currentPlat.x + currentPlat.w : currentPlat.x;
        const distToEdge = Math.abs(edgeX - botPlayer.x);
        
        // SMART run-up calculation based on what we're trying to reach
        const availableRunUp = jumpDirection > 0 
            ? (botPlayer.x - currentPlat.x) 
            : (currentPlat.x + currentPlat.w - botPlayer.x);
        
        // Calculate optimal run-up based on the jump we need to make
        const targetRunUp = this.calculateOptimalRunUp(botPlayer, platforms, jumpDirection);
        
        // Phase 1: BACK UP - we need more run-up space
        if (availableRunUp < targetRunUp && distToEdge < targetRunUp) {
            const backDir = -jumpDirection;
            botPlayer.inputs.right = backDir > 0;
            botPlayer.inputs.left = backDir < 0;
            botPlayer.facingRight = backDir > 0;
            botPlayer.inputs.jump = false;
            this.momentumState = 'BACKING_UP';
            this.debugInfo += `BACKUP(need:${Math.round(targetRunUp)},have:${Math.round(availableRunUp)})`;
            return;
        }
        
        // Phase 2: SPRINT - run toward the edge at full speed
        if (distToEdge > 20 && shouldJump) {
            botPlayer.inputs.right = jumpDirection > 0;
            botPlayer.inputs.left = jumpDirection < 0;
            botPlayer.facingRight = jumpDirection > 0;
            botPlayer.inputs.jump = false; // Don't jump yet, keep sprinting
            this.momentumState = 'SPRINTING';
            this.debugInfo += `SPRINT(${Math.round(distToEdge)}px)`;
            return;
        }
        
        // Phase 3: JUMP - at the optimal distance from edge, jump with full momentum!
        if (distToEdge <= 20 && shouldJump) {
            botPlayer.inputs.right = jumpDirection > 0;
            botPlayer.inputs.left = jumpDirection < 0;
            botPlayer.facingRight = jumpDirection > 0;
            botPlayer.inputs.jump = true;
            this.lastJumpTick = currentTick;
            this.jumpAttempts++;
            this.momentumState = 'JUMPING';
            this.debugInfo += `MOMENTUM_JUMP!`;
        }
    }

    // ================================================================
    // NEW: Calculate optimal run-up distance based on what we're trying to reach
    // ================================================================
    calculateOptimalRunUp(botPlayer, platforms, jumpDirection) {
        // Determine run‑up needed based on actual physics helper
        const currentPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        if (currentPlatIdx < 0) return 100;
        const currentPlat = platforms[currentPlatIdx];
        const maxPlatformRunUp = Math.min(250, currentPlat.w * 0.4);

        const reachablePlatforms = this.findReachablePlatforms(botPlayer, platforms, jumpDirection);
        if (reachablePlatforms.length === 0) {
            return Math.min(100, maxPlatformRunUp);
        }

        // Use the physics helper to compute required run‑up for each reachable platform
        let bestRunUp = 0;
        for (const p of reachablePlatforms) {
            const jumpStartX = jumpDirection > 0 ? currentPlat.x + currentPlat.w : currentPlat.x;
            const hGap = jumpDirection > 0
                ? Math.max(0, p.x - jumpStartX)
                : Math.max(0, jumpStartX - (p.x + p.w));
            const vDist = currentPlat.y - p.y;
            const { runUpNeeded } = calculateRequiredRunUp(hGap, vDist);
            if (runUpNeeded > bestRunUp) bestRunUp = runUpNeeded;
        }
        return Math.min(bestRunUp, maxPlatformRunUp);
    }

    moveTowardWithJump(botPlayer, targetX, targetY, platforms, currentTick, shouldJump) {
        const dx = targetX - botPlayer.x;
        const moveDir = dx > 0 ? 1 : -1;
        
        // Not jumping or not on ground - just walk
        if (!shouldJump || !botPlayer.onGround) {
            this.moveToward(botPlayer, targetX, platforms);
            return;
        }

        // Use momentum-based jumping
        this.buildMomentumAndJump(botPlayer, platforms, currentTick, moveDir, true);
    }

    isAtPlatformEdge(botPlayer, platforms, direction) {
        if (!botPlayer.onGround) return false;

        const checkX = direction > 0 ? botPlayer.x + 42 : botPlayer.x - 2;
        const feetY = botPlayer.y + 60;

        for (const p of platforms) {
            if (feetY >= p.y - 5 && feetY <= p.y + 15) {
                if (checkX >= p.x && checkX <= p.x + p.w) {
                    return false;
                }
            }
        }

        return true;
    }

    isAbovePlatform(px, py, platform) {
        return py + 60 < platform.y + 10 &&
               px + 40 > platform.x &&
               px < platform.x + platform.w;
    }

    // ============================================================
    // ANTI-STUCK LOGIC
    // ============================================================

    antiStuckCheck(botPlayer, platforms, currentTick) {
        const moved = Math.abs(botPlayer.x - this.lastPosition.x) > 2 ||
                      Math.abs(botPlayer.y - this.lastPosition.y) > 2;

        if (moved) {
            this.stuckTimer = 0;
            this.lastPosition = { x: botPlayer.x, y: botPlayer.y };
        } else {
            this.stuckTimer++;
        }

        if (this.stuckTimer > BOT_STUCK_TIMEOUT) {
            // NEW: Check if we're stuck because of other bots
            if (this.collidingBotIds.length > 0) {
                // We're stuck because of bot collision - try to fight our way out
                const playerMap = global.currentPlayerMap;
                if (playerMap && this.collidingBotIds.length > 0) {
                    const blockingBotId = this.collidingBotIds[0];
                    const blockingBot = playerMap.get(blockingBotId);
                    if (blockingBot && !blockingBot.player.isDead) {
                        this.targetPlayerId = blockingBotId;
                        this.targetLockTimer = 120;
                        this.state = 'ATTACK';
                        this.debugInfo += 'FIGHT_STUCK ';
                        this.stuckTimer = 0;
                        return;
                    }
                }
            }

            this.path = [];
            this.pathIndex = 0;
            this.stuckTimer = 0;
            this.jumpAttempts = 0;
            this.momentumState = 'NONE';

            botPlayer.inputs.jump = true;

            if (Math.random() > 0.5) {
                this.wanderDirection *= -1;
            }

            if (this.stuckTimer > BOT_STUCK_TIMEOUT * 2) {
                this.state = 'PATROL';
            }

            this.debugInfo += ' STUCK!';
        }

        // Platform fail check - with new jump-node A* we simply drop the bad path
        // and let the next chase tick recompute a fresh route (or fall back to smartDirectMove)
        if (this.jumpAttempts > 5 && this.state === 'CHASE') {
            this.path = [];
            this.pathIndex = 0;
            this.jumpAttempts = 0;
            this.wanderDirection *= -1;
            this.debugInfo += ' PLATFORM_FAIL!';
        }
    }

    // ============================================================
    // RESET
    // ============================================================

    reset() {
        this.state = 'PATROL';
        this.path = [];
        this.pathIndex = 0;
        this.stuckTimer = 0;
        this.jumpAttempts = 0;
        this.attackCooldown = 0;
        this.currentPlatformIndex = -1;
        this.targetLockTimer = 0;
        this.targetPlayerId = null;
        this.revengeTargetId = null;
        this.revengeTimer = 0;
        this.recentHitByIds = [];
        this.botHitCounter = 0;
        this.botHitTargetId = null;
        this.momentumState = 'NONE';
        this.momentumTimer = 0;
        this.jumpDirection = 0;
        this.runUpTarget = 0;
    }
}

// ============================================================
// BOT SPAWNING & MANAGEMENT
// ============================================================

let botAIs = new Map(); // playerId -> BotAI
const BOT_NAMES = ['Bot Alpha', 'Bot Beta', 'Bot Gamma', 'Bot Delta', 'Bot Epsilon', 'Bot Zeta'];
const BOT_CHARACTERS = ['Bookie', 'Getaway Driver', 'Informant', 'Safecracker', 'smuggler', 'Street Thug', 'Boss', 'Distractor Duck', 'Dark Cowboy', 'Racketeer', 'Purple', 'Guard', 'Dock Overseer', 'Hostage', 'Doorman'];

function getBotName(index) {
    return BOT_NAMES[index % BOT_NAMES.length];
}

function getBotPersonality(index) {
    return BOT_PERSONALITIES[index % BOT_PERSONALITIES.length];
}

// Find a spawn position that doesn't overlap with players
function findBotSpawnPosition(players, platforms, worldWidth, worldHeight) {
    const PLAYER_WIDTH = 40;
    const PLAYER_HEIGHT = 60;
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
        let highTierPlatforms = [];
        let lowTierPlatforms = [];

        for (const p of platforms) {
            if (p.y <= 400) {
                highTierPlatforms.push(p);
            } else {
                lowTierPlatforms.push(p);
            }
        }

        const existingBotCount = global.botAIs ? global.botAIs.size : 0;
        const useHighTier = existingBotCount < 8;

        let platform;
        if (useHighTier && highTierPlatforms.length > 0) {
            platform = highTierPlatforms[Math.floor(Math.random() * highTierPlatforms.length)];
        } else if (Math.random() < 0.4) {
            platform = platforms[0];
        } else if (lowTierPlatforms.length > 0) {
            platform = lowTierPlatforms[Math.floor(Math.random() * lowTierPlatforms.length)];
        } else {
            platform = platforms[0];
        }

        const x = platform.x + 20 + Math.random() * Math.max(1, platform.w - 60);
        const y = platform.y - PLAYER_HEIGHT;

        let tooClose = false;
        for (const [id, { player }] of players) {
            const dx = player.x - x;
            const dy = player.y - y;
            if (Math.sqrt(dx * dx + dy * dy) < 300) {
                tooClose = true;
                break;
            }
        }

        if (!tooClose && x > 20 && x < worldWidth - 60 && y > 100) {
            return { x, y };
        }

        attempts++;
    }

    return { x: 100 + Math.random() * 200, y: worldHeight - 100 - PLAYER_HEIGHT };
}

function isValidSpawn(x, y, players, minDist = 300) {
    for (const [id, { player }] of players) {
        const dx = player.x - x;
        const dy = player.y - y;
        if (Math.sqrt(dx * dx + dy * dy) < minDist) {
            return false;
        }
    }
    return true;
}

function spawnBot(players, platforms, worldWidth, worldHeight, botIndex) {
    const position = findBotSpawnPosition(players, platforms, worldWidth, worldHeight);
    const character = BOT_CHARACTERS[botIndex % BOT_CHARACTERS.length];

    const botId = -(botIndex + 999);

    const hue = Math.floor(Math.random() * 360);
    const color = `hsl(${hue}, 20%, 35%)`;

    const botPlayer = {
        id: botId,
        x: position.x,
        y: position.y,
        vx: 0,
        vy: 0,
        onGround: false,
        facingRight: true,
        color: color,
        sprite: character,
        name: generateRandomBotName(),
        inputs: { left: false, right: false, jump: false, attack: false, down: false },
        attackProcessed: false,
        gotHit: false,
        comboStage: 0,
        lastAttackTime: 0,
        attackActive: false,
        attackEndTime: 0,
        health: 100,
        invincibleTimer: 60,
        hitStunTimer: 0,
        fastFallTicks: 0,
        isDead: false,
        deathTimer: 0,
        isFading: false,
        fadeTimer: 0,
        opacity: 1.0,
        isFadingIn: false,
        isBot: true,
        botIndex: botIndex,
        jumpsRemaining: 1,
        prevJumpInput: false,
        jumpPressed: false,
        isClimbing: false,
        climbTimer: 0,
        climbTargetY: 0
    };

    const personality = getBotPersonality(botIndex);
    const ai = new BotAI(botId, personality);
    botAIs.set(botId, ai);

    console.log(`Spawned bot ${botIndex} (${personality}) at (${Math.round(position.x)}, ${Math.round(position.y)})`);

    return botPlayer;
}

function checkBotRespawn(botPlayer, players, platforms, worldWidth, worldHeight, botAIsMap) {
    if (botPlayer.isDead && botPlayer.deathTimer <= 0 && !botPlayer.isFading) {
        const position = findBotSpawnPosition(players, platforms, worldWidth, worldHeight);
        botPlayer.x = position.x;
        botPlayer.y = position.y;
        botPlayer.vx = 0;
        botPlayer.vy = 0;
        botPlayer.onGround = false;
        botPlayer.health = 100;
        botPlayer.comboStage = 0;
        botPlayer.attackActive = false;
        botPlayer.invincibleTimer = 60;
        botPlayer.gotHit = false;
        botPlayer.hitStunTimer = 0;
        botPlayer.isDead = false;
        botPlayer.deathTimer = 0;
        botPlayer.isFading = false;
        botPlayer.fadeTimer = 0;
        botPlayer.isFadingIn = true;
        botPlayer.fadeTimer = 30;
        botPlayer.opacity = 0.0;

        const ai = botAIsMap.get(botPlayer.id);
        if (ai) ai.reset();
    }
}

function getHumanPlayerCount(players) {
    let count = 0;
    for (const [id, { player }] of players) {
        if (!player.isBot) count++;
    }
    return count;
}

function getBotCount(players) {
    let count = 0;
    for (const [id, { player }] of players) {
        if (player.isBot) count++;
    }
    return count;
}

function updateBotAI(players, platforms, worldWidth, worldHeight, currentTick) {
    if (!global.botAIs) {
        global.botAIs = new Map();
    }
    const botAIs = global.botAIs;

    const humanCount = getHumanPlayerCount(players);
    const currentBotCount = getBotCount(players);

    // Disabled automatic bot spawning - bots can now be manually added/removed via spectator panel
    // if (humanCount === 0 && currentBotCount < 4) {
    //     for (let i = currentBotCount; i < 4; i++) {
    //         const botPlayer = spawnBot(players, platforms, worldWidth, worldHeight, i + currentBotCount);
    //         const ws = null;
    //         players.set(botPlayer.id, { player: botPlayer, ws });
    //     }
    //     console.log(`Spawned ${4 - currentBotCount} bots (no human players)`);
    // } else if (humanCount > 0 && currentBotCount < 4) {
    //     for (let i = currentBotCount; i < 4; i++) {
    //         const botPlayer = spawnBot(players, platforms, worldWidth, worldHeight, i + currentBotCount);
    //         const ws = null;
    //         players.set(botPlayer.id, { player: botPlayer, ws });
    //     }
    //     console.log(`Spawned ${4 - currentBotCount} bots alongside human players`);
    // }

    for (const [id, { player }] of players) {
        if (!player.isBot) continue;

        if (player.isDead) {
            checkBotRespawn(player, players, platforms, worldWidth, worldHeight, botAIs);
        }

        let ai = botAIs.get(id);
        if (!ai) {
            ai = new BotAI(id, getBotPersonality(player.botIndex || 0));
            botAIs.set(id, ai);
        }

        player.inputs = { left: false, right: false, jump: false, attack: false, down: false };

        ai.update(player, players, platforms, worldWidth, worldHeight, currentTick);
    }
}

module.exports = {
    updateBotAI,
    BotAI,
    getBotCount,
    getHumanPlayerCount,
    BOT_PERSONALITIES,
    getBotPathsForDebug,
    spawnBot
};