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

// ============================================================
// PLATFORM GRAPH - Navigation graph for pathfinding
// ============================================================
let platformGraph = null;
let graphBuildVersion = 0;

function buildPlatformGraph(platforms) {
    const n = platforms.length;
    const graph = new Array(n);
    for (let i = 0; i < n; i++) {
        graph[i] = [];
    }

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const a = platforms[i];
            const b = platforms[j];

            // Calculate horizontal overlap and distances
            const aLeft = a.x, aRight = a.x + a.w;
            const bLeft = b.x, bRight = b.x + b.w;
            const hOverlap = Math.max(0, Math.min(aRight, bRight) - Math.max(aLeft, bLeft));
            const hGap = Math.max(aLeft, bLeft) - Math.min(aRight, bRight);
            const vDist = Math.abs(a.y - b.y);
            const centerDist = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2));

            // --- Same level / Walkable connection ---
            // Platforms at similar height with horizontal overlap or small gap
            if (vDist < 40 && (hOverlap > 0 || (hGap > 0 && hGap < 80))) {
                const cost = 1 + (hGap > 0 ? hGap / 200 : 0);
                graph[i].push({ to: j, action: 'walk', cost });
                graph[j].push({ to: i, action: 'walk', cost });
            }

            // --- Jump up connections ---
            if (centerDist < MAX_HORIZONTAL_JUMP_DIST && vDist > 0) {
                if (b.y < a.y) {
                    // b is above a
                    const heightDiff = a.y - b.y;
                    if (heightDiff <= MAX_SINGLE_JUMP_HEIGHT && !isBlockedVertical(platforms, a, b)) {
                        const cost = 3 + heightDiff / 50 + centerDist / 300;
                        graph[i].push({ to: j, action: 'jump', cost });
                    } else if (heightDiff <= MAX_SINGLE_JUMP_HEIGHT && !isBlockedVertical(platforms, a, b)) {
                        const cost = 5 + heightDiff / 50 + centerDist / 200;
                        graph[i].push({ to: j, action: 'jump', cost });
                    }
                } else if (a.y < b.y) {
                    // a is above b: drop down connection
                    const heightDiff = b.y - a.y;
                    if (heightDiff <= MAX_DROP_DIST) {
                        // Check if we can drop through or need to walk off edge
                        const canDrop = hOverlap > 0 || hGap < MAX_HORIZONTAL_JUMP_DIST;
                        if (canDrop) {
                            graph[i].push({ to: j, action: 'drop', cost: 2 + heightDiff / 200 });
                        }
                    }
                }
            }

            // --- Edge-to-edge jump connections ---
            // Uses more lenient corner-to-edge distance rather than a strict
            // to-center check so bots can "corner-land" and upward jumps are
            // the primary direction being unlocked.
            if (vDist > 0) {
                if (b.y < a.y) {
                    // CORNER → EDGE (upward): right edge of lower platform → nearest vertical edge of upper platform
                    const nearestEdgeX = b.x > aRight ? b.x : b.x + b.w; // edge that is "outward" relative to the lower platform
                    const throwDist = Math.sqrt(Math.pow(nearestEdgeX - aRight, 2) + Math.pow(b.y - a.y, 2));
                    if (throwDist < MAX_HORIZONTAL_JUMP_DIST && !isBlockedVertical(platforms, a, b)) {
                        const action = 'jump';
                        const cost = 5 + throwDist / 200;
                        graph[i].push({ to: j, action, cost });
                    }
                }
            }
        }
    }

    return graph;
}

// Check if there's a platform blocking a vertical jump from a to b
function isBlockedVertical(platforms, a, b) {
    const aBottomY = a.y + a.h;           // bottom of the lower platform's body
    const bTopY    = b.y;                  // top of the upper platform
    const left  = Math.min(a.x, b.x) - 60;
    const right = Math.max(a.x + a.w, b.x + b.w) + 60;

    for (const p of platforms) {
        if (p === a || p === b) continue;
        // p is in the vertical space between platform bottoms / ground and the upper platform top
        if (p.y + p.h <= bTopY || p.y >= aBottomY) continue;
        // p intersects the horizontal corridor between the two platforms
        if (p.x + p.w <= left || p.x >= right) continue;
        // Ignore thin decoration platforms that pose no real obstacle
        if (p.h < 12 && p.w < 30) continue;
        return true;
    }
    return false;
}

// A* pathfinding on platform graph
function findPathInGraph(graph, startNode, endNode) {
    if (startNode === endNode) return [startNode];
    if (!graph[startNode] || !graph[endNode]) return [startNode];

    const openSet = new Set([startNode]);
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();

    gScore.set(startNode, 0);
    fScore.set(startNode, heuristic(startNode, endNode));

    while (openSet.size > 0) {
        let current = null;
        let lowestF = Infinity;
        for (const node of openSet) {
            const f = fScore.get(node) || Infinity;
            if (f < lowestF) {
                lowestF = f;
                current = node;
            }
        }

        if (current === endNode) {
            // Reconstruct path
            const path = [current];
            while (cameFrom.has(current)) {
                current = cameFrom.get(current);
                path.unshift(current);
            }
            return path;
        }

        openSet.delete(current);

        const neighbors = graph[current] || [];
        for (const edge of neighbors) {
            const neighbor = edge.to;
            const tentativeG = (gScore.get(current) || Infinity) + edge.cost;

            if (tentativeG < (gScore.get(neighbor) || Infinity)) {
                cameFrom.set(neighbor, current);
                gScore.set(neighbor, tentativeG);
                fScore.set(neighbor, tentativeG + heuristic(neighbor, endNode));
                openSet.add(neighbor);
            }
        }
    }

    // No path found, return just the start
    return [startNode];
}

// Heuristic for A* (Euclidean-like distance between platform centers)
function heuristic(nodeA, nodeB) {
    // Use weighted Manhattan distance as heuristic
    return Math.abs(nodeA - nodeB) + 1;
}

// Find which platform a position is standing on
function findPlatformAt(x, y, platforms) {
    const feetY = y + 60; // bottom of player
    let bestPlatform = -1;
    let bestOverlap = 0;

    for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        // Player is standing on or near this platform
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

// Find nearest platform (for when player is in air between platforms)
function findNearestPlatform(x, y, platforms) {
    let nearest = -1;
    let nearestDist = Infinity;

    for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        const pCenterX = p.x + p.w / 2;
        const pCenterY = p.y + p.h / 2;
        const dx = (x + 20) - pCenterX;
        const dy = (y + 30) - pCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < nearestDist) {
            nearestDist = dist;
            nearest = i;
        }
    }

    return nearest;
}

// ============================================================
// NEW: Find the best platform for a target that may be airborne or on an edge
// This is more robust than findPlatformAt for targets that may be standing at
// the very edge of elevated platforms or in mid-air
// ============================================================
function findTargetPlatform(x, y, platforms) {
    // First try the standard platform-at-feet detection
    let plat = findPlatformAt(x, y, platforms);
    if (plat >= 0) return plat;

    // If not found, check if target is near the top edge of any platform
    // This handles cases where the player is precisely at the platform edge
    const feetY = y + 60;
    for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        // Check if the player's bottom is within jump-landing range above the platform
        // and their horizontal position overlaps the platform
        if (feetY >= p.y - 60 && feetY <= p.y + 15) {
            const overlap = Math.min(x + 40, p.x + p.w) - Math.max(x, p.x);
            if (overlap > 5) {
                return i;
            }
        }
    }

    // Last resort: find the platform with the closest top surface below the player
    let bestPlat = -1;
    let bestDist = Infinity;
    for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        if (y + 60 >= p.y) {
            const dist = Math.abs((y + 60) - p.y);
            const hOverlap = Math.min(x + 40, p.x + p.w) - Math.max(x, p.x);
            if (hOverlap > 0 && dist < bestDist) {
                bestDist = dist;
                bestPlat = i;
            }
        }
    }

    return bestPlat;
}

// ============================================================
// NEW: Find intermediate platforms to climb from a lower platform
// to an upper one, creating a multi-hop vertical path
// ============================================================
function findVerticalRoute(platforms, fromIdx, toIdx, maxSteps) {
    if (fromIdx === toIdx) return [fromIdx];
    if (maxSteps <= 0) maxSteps = 8;

    const fromPlat = platforms[fromIdx];
    const toPlat = platforms[toIdx];

    // If target is below or same level, no climbing needed
    if (toPlat.y >= fromPlat.y - 10) return null;

    // Build a quick adjacency list from the graph
    if (!platformGraph || graphBuildVersion !== platforms.length) {
        platformGraph = buildPlatformGraph(platforms);
        graphBuildVersion = platforms.length;
    }

    // A* that finds a path prioritizing upward movement
    const openSet = new Set([fromIdx]);
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();

    gScore.set(fromIdx, 0);
    fScore.set(fromIdx, heuristic(fromIdx, toIdx));

    while (openSet.size > 0) {
        let current = null;
        let lowestF = Infinity;
        for (const node of openSet) {
            const f = fScore.get(node) || Infinity;
            if (f < lowestF) {
                lowestF = f;
                current = node;
            }
        }

        if (current === toIdx) {
            const path = [current];
            while (cameFrom.has(current)) {
                current = cameFrom.get(current);
                path.unshift(current);
            }
            return path;
        }

        openSet.delete(current);

        const neighbors = platformGraph[current] || [];
        for (const edge of neighbors) {
            const neighbor = edge.to;
            const neighborPlat = platforms[neighbor];

            // Only consider upward or same-level connections for climbing
            // (don't go downward when trying to reach an elevated target)
            if (neighborPlat.y > platforms[current].y + 10) continue;

            const tentativeG = (gScore.get(current) || Infinity) + edge.cost;

            if (tentativeG < (gScore.get(neighbor) || Infinity)) {
                cameFrom.set(neighbor, current);
                gScore.set(neighbor, tentativeG);
                // Heuristic: prefer platforms closer to the target's height and X position
                const yDist = Math.abs(neighborPlat.y - toPlat.y);
                const xDist = Math.abs((neighborPlat.x + neighborPlat.w / 2) - (toPlat.x + toPlat.w / 2));
                fScore.set(neighbor, tentativeG + yDist * 2 + xDist * 0.5);
                openSet.add(neighbor);
            }
        }
    }

    return null;
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

        // SMART PATHFINDING: Try multiple strategies in order of intelligence
        let pathFound = false;

        // Strategy 1: Direct pathfinding if both on valid platforms
        if (botPlatIdx >= 0 && targetPlatIdx >= 0) {
            this.pathfindToTarget(botPlayer, target.x, target.y, platforms);
            if (this.path.length > 1) {
                pathFound = true;
                this.debugInfo += 'DIRECT_PATH ';
            }
        }

        // Strategy 2: Multi-hop climbing for elevated targets
        if (!pathFound && botPlatIdx >= 0 && targetPlatIdx >= 0) {
            const botPlatY = platforms[botPlatIdx].y;
            const targetPlatY = platforms[targetPlatIdx].y;

            if (targetPlatY < botPlatY - 50) { // Target is significantly above
                const climbPath = this.findVerticalClimbPath(botPlayer, platforms, botPlatIdx, targetPlatIdx, target.x, target.y);
                if (climbPath && climbPath.length > 1) {
                    this.path = climbPath;
                    this.pathIndex = 0;
                    pathFound = true;
                    this.debugInfo += 'CLIMB_PATH ';
                }
            }
        }

        // Strategy 3: Smart intermediate platform routing
        if (!pathFound && botPlatIdx >= 0) {
            const intermediatePath = this.findSmartRoute(botPlayer, target, platforms);
            if (intermediatePath && intermediatePath.length > 0) {
                this.path = intermediatePath;
                this.pathIndex = 0;
                pathFound = true;
                this.debugInfo += 'SMART_ROUTE ';
            }
        }

        // Execute movement
        if (pathFound && this.path.length > 0) {
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
        let predictX = player.x + (player.vx || 0) * 10; // Rough prediction
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
    // NEW: Find a smart route using intermediate platforms and strategic positioning
    // ================================================================
    findSmartRoute(botPlayer, target, platforms) {
        const botPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        if (botPlatIdx < 0) return null;

        const targetPlatIdx = findTargetPlatform(target.x, target.y, platforms);
        if (targetPlatIdx < 0) return null;

        const botPlat = platforms[botPlatIdx];
        const targetPlat = platforms[targetPlatIdx];

        // If target is much higher, find stepping stone platforms
        if (targetPlat.y < botPlat.y - 100) {
            return this.findSteppingStones(botPlayer, botPlat, targetPlat, target, platforms);
        }

        // If target is on same level but across a gap, find bridge platforms
        if (Math.abs(targetPlat.y - botPlat.y) < 50) {
            return this.findBridgePlatforms(botPlayer, botPlat, targetPlat, target, platforms);
        }

        return null;
    }

    // ================================================================
    // NEW: Find stepping stone platforms to reach higher targets
    // ================================================================
    findSteppingStones(botPlayer, botPlat, targetPlat, target, platforms) {
        const waypoints = [];
        let currentHeight = botPlat.y;
        const targetHeight = targetPlat.y;
        const targetX = target.x;

        // Find platforms that create a staircase upward
        const candidates = platforms.filter(p => 
            p.y < currentHeight && 
            p.y > targetHeight - 50 &&
            Math.abs((p.x + p.w/2) - targetX) < 600
        ).sort((a, b) => b.y - a.y); // Sort by height, highest first

        let currentX = botPlayer.x;
        for (const step of candidates) {
            const heightGain = currentHeight - step.y;
            const horizontalDist = Math.abs((step.x + step.w/2) - currentX);

            // Check if this step is reachable and useful
            if (heightGain <= MAX_SINGLE_JUMP_HEIGHT && horizontalDist <= MAX_HORIZONTAL_JUMP_DIST) {
                const landingX = this.calculateLandingPosition(step, targetX);
                waypoints.push({
                    x: landingX,
                    y: step.y,
                    platformIndex: platforms.indexOf(step)
                });
                currentHeight = step.y;
                currentX = landingX;

                // If we're close enough to the target height, try to reach it
                if (Math.abs(currentHeight - targetPlat.y) <= MAX_SINGLE_JUMP_HEIGHT) {
                    break;
                }
            }
        }

        // Add final target
        if (waypoints.length > 0) {
            waypoints.push({
                x: target.x,
                y: target.y,
                platformIndex: platforms.indexOf(targetPlat)
            });
        }

        return waypoints.length > 1 ? waypoints : null;
    }

    // ================================================================
    // NEW: Find bridge platforms to cross gaps at same level
    // ================================================================
    findBridgePlatforms(botPlayer, botPlat, targetPlat, target, platforms) {
        const waypoints = [];
        const botCenterX = botPlat.x + botPlat.w / 2;
        const targetCenterX = targetPlat.x + targetPlat.w / 2;
        const avgY = (botPlat.y + targetPlat.y) / 2;

        // Find platforms that can serve as bridges
        const bridges = platforms.filter(p => 
            Math.abs(p.y - avgY) < 100 &&
            ((p.x + p.w/2) > Math.min(botCenterX, targetCenterX)) &&
            ((p.x + p.w/2) < Math.max(botCenterX, targetCenterX))
        ).sort((a, b) => {
            const aDist = Math.abs((a.x + a.w/2) - botCenterX);
            const bDist = Math.abs((b.x + b.w/2) - botCenterX);
            return aDist - bDist;
        });

        for (const bridge of bridges) {
            const landingX = this.calculateLandingPosition(bridge, target.x);
            waypoints.push({
                x: landingX,
                y: bridge.y,
                platformIndex: platforms.indexOf(bridge)
            });
        }

        // Add final target
        if (waypoints.length > 0) {
            waypoints.push({
                x: target.x,
                y: target.y,
                platformIndex: platforms.indexOf(targetPlat)
            });
        }

        return waypoints.length > 1 ? waypoints : null;
    }

    // ================================================================
    // NEW: Intelligent direct movement that doesn't just run into walls
    // ================================================================
    smartDirectMove(botPlayer, targetX, targetY, platforms, currentTick) {
        const dx = targetX - botPlayer.x;
        const dy = targetY - botPlayer.y;
        const botPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, platforms);

        // If we're not on a platform, just move toward target
        if (botPlatIdx < 0) {
            this.moveToward(botPlayer, targetX, platforms);
            return;
        }

        const botPlat = platforms[botPlatIdx];
        const moveDir = dx > 0 ? 1 : -1;
        const atEdge = this.isAtPlatformEdge(botPlayer, platforms, moveDir);

        // Target is significantly above us
        if (dy < -100) {
            if (atEdge) {
                // At edge - look for platforms we can reach with a jump
                const reachablePlatforms = this.findReachablePlatforms(botPlayer, platforms, moveDir);
                if (reachablePlatforms.length > 0) {
                    // Choose the platform that gets us closest to the target
                    const bestPlatform = reachablePlatforms.reduce((best, p) => {
                        const pDist = Math.abs(p.y - targetY) + Math.abs((p.x + p.w/2) - targetX) * 0.5;
                        const bestDist = Math.abs(best.y - targetY) + Math.abs((best.x + best.w/2) - targetX) * 0.5;
                        return pDist < bestDist ? p : best;
                    });

                    // Build momentum and jump toward the best platform
                    const targetLandingX = this.calculateLandingPosition(bestPlatform, targetX);
                    this.buildMomentumAndJump(botPlayer, platforms, currentTick, moveDir, true);
                    this.debugInfo += `SMART_JUMP->${Math.round(targetLandingX)} `;
                    return;
                } else {
                    // No reachable platforms - don't jump off into void
                    this.moveToward(botPlayer, botPlat.x + botPlat.w/2, platforms);
                    this.debugInfo += 'NO_JUMP_TARGET ';
                    return;
                }
            } else {
                // Move toward edge to prepare for jump
                this.moveToward(botPlayer, targetX, platforms);
            }
        }
        // Target is below us
        else if (dy > 100) {
            if (atEdge) {
                // Check if we can drop down safely
                const landingPlatform = this.findLandingPlatform(botPlayer, platforms, moveDir);
                if (landingPlatform) {
                    botPlayer.inputs.down = true; // Drop through platform
                    this.moveToward(botPlayer, targetX, platforms);
                    this.debugInfo += 'SMART_DROP ';
                } else {
                    // Don't drop into void
                    this.moveToward(botPlayer, botPlat.x + botPlat.w/2, platforms);
                    this.debugInfo += 'NO_DROP_TARGET ';
                }
            } else {
                this.moveToward(botPlayer, targetX, platforms);
            }
        }
        // Target is roughly same level
        else {
            if (atEdge && Math.abs(dx) > 50) {
                // Check if we can jump across a gap
                const landingPlatform = this.findLandingPlatform(botPlayer, platforms, moveDir);
                if (landingPlatform && Math.abs(landingPlatform.y - botPlat.y) < 100) {
                    this.buildMomentumAndJump(botPlayer, platforms, currentTick, moveDir, true);
                    this.debugInfo += 'GAP_JUMP ';
                } else {
                    // Can't cross gap safely
                    this.moveToward(botPlayer, botPlat.x + botPlat.w/2, platforms);
                    this.debugInfo += 'CANT_CROSS ';
                }
            } else {
                this.moveToward(botPlayer, targetX, platforms);
            }
        }
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
    findVerticalClimbPath(botPlayer, platforms, botPlatIdx, targetPlatIdx, targetX, targetY) {
        // Build graph if needed
        if (!platformGraph || graphBuildVersion !== platforms.length) {
            platformGraph = buildPlatformGraph(platforms);
            graphBuildVersion = platforms.length;
        }

        // Try to find a vertical route through intermediate platforms
        const nodePath = findVerticalRoute(platforms, botPlatIdx, targetPlatIdx, 8);

        if (nodePath && nodePath.length > 1) {
            const waypoints = [];
            for (const nodeIdx of nodePath) {
                const p = platforms[nodeIdx];
                // Choose landing position: prefer the side of the platform closest to the target
                const targetSide = targetX < p.x + p.w / 2;
                const wayX = targetSide ? p.x + 20 : p.x + p.w - 20;
                waypoints.push({
                    x: wayX,
                    y: p.y,
                    platformIndex: nodeIdx
                });
            }
            // Add final target waypoint on the target's actual platform
            waypoints.push({
                x: targetX,
                y: targetY,
                platformIndex: targetPlatIdx
            });
            return waypoints;
        }

        // If no full vertical route found, try a greedy approach:
        // Find the highest reachable platform that gets us closer to the target
        if (!platformGraph) return [];

        const visited = new Set();
        let bestClimbPlat = -1;
        let bestClimbScore = Infinity;
        const targetPlat = platforms[targetPlatIdx];

        // BFS from bot platform following upward edges only
        const queue = [botPlatIdx];
        visited.add(botPlatIdx);

        while (queue.length > 0) {
            const current = queue.shift();
            const neighbors = platformGraph[current] || [];

            for (const edge of neighbors) {
                if (visited.has(edge.to)) continue;
                visited.add(edge.to);

                const neighborPlat = platforms[edge.to];
                const currentPlat = platforms[current];

                // Only follow upward or same-level edges when climbing
                if (neighborPlat.y > currentPlat.y + 10) continue;

                queue.push(edge.to);

                // Score this platform: how close it gets us to the target
                const yDist = Math.abs(neighborPlat.y - targetPlat.y);
                const xDist = Math.abs((neighborPlat.x + neighborPlat.w / 2) - targetX);
                const score = yDist * 3 + xDist * 0.5;

                if (yDist < 100 && score < bestClimbScore) {
                    // Can we reach the target platform from here?
                    const canReachTarget = platformGraph[edge.to].some(e => {
                        const reachPlat = platforms[e.to];
                        const targetReachPlat = platforms[targetPlatIdx];
                        // Check if this edge action can get us to the target's platform
                        const vDist = Math.abs(reachPlat.y - targetReachPlat.y);
                        const hDist = Math.abs((reachPlat.x + reachPlat.w / 2) - (targetReachPlat.x + targetReachPlat.w / 2));
                        return e.to === targetPlatIdx || (vDist < MAX_SINGLE_JUMP_HEIGHT && hDist < MAX_HORIZONTAL_JUMP_DIST);
                    });

                    if (canReachTarget) {
                        bestClimbPlat = edge.to;
                        bestClimbScore = score;
                    }
                }
            }
        }

        // If we found a good intermediate, build path through it
        if (bestClimbPlat >= 0) {
            const graphPath = findPathInGraph(platformGraph, botPlatIdx, bestClimbPlat);
            if (graphPath.length > 1) {
                const waypoints = [];
                for (const nodeIdx of graphPath) {
                    const p = platforms[nodeIdx];
                    const targetSide = targetX < p.x + p.w / 2;
                    const wayX = targetSide ? p.x + 20 : p.x + p.w - 20;
                    waypoints.push({
                        x: wayX,
                        y: p.y,
                        platformIndex: nodeIdx
                    });
                }
                // Add final target waypoint
                waypoints.push({
                    x: targetX,
                    y: targetY,
                    platformIndex: targetPlatIdx
                });
                return waypoints;
            }
        }

        return [];
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

    pathfindToTarget(botPlayer, targetX, targetY, platforms) {
        const botPlatform = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        const targetPlatform = findTargetPlatform(targetX, targetY, platforms);

        if (botPlatform < 0 || targetPlatform < 0) {
            // One or both not on platforms - create simple direct path
            this.path = [{
                x: targetX,
                y: targetY,
                platformIndex: targetPlatform
            }];
            this.pathIndex = 0;
            return;
        }

        // If both on the same large platform, just walk directly
        if (botPlatform === targetPlatform) {
            const p = platforms[botPlatform];
            if (p.w > 400) { // Large platform - can walk directly
                this.path = [{
                    x: targetX,
                    y: targetY,
                    platformIndex: botPlatform
                }];
                this.pathIndex = 0;
                return;
            }
        }

        // Build graph if needed
        if (!platformGraph || graphBuildVersion !== platforms.length) {
            platformGraph = buildPlatformGraph(platforms);
            graphBuildVersion = platforms.length;
        }

        // Find path in graph
        let nodePath = findPathInGraph(platformGraph, botPlatform, targetPlatform);

        // If no direct path found, try alternative strategies
        if (nodePath.length <= 1) {
            // Strategy 1: Find intermediate platforms that can bridge the gap
            const bridgePlatform = this.findBestBridgePlatform(botPlatform, targetPlatform, platforms);
            if (bridgePlatform !== null) {
                const pathToBridge = findPathInGraph(platformGraph, botPlatform, bridgePlatform);
                const pathFromBridge = findPathInGraph(platformGraph, bridgePlatform, targetPlatform);
                
                if (pathToBridge.length > 1 && pathFromBridge.length > 1) {
                    // Combine paths, removing duplicate bridge platform
                    nodePath = pathToBridge.concat(pathFromBridge.slice(1));
                }
            }
        }

        // Convert node path to waypoints with intelligent positioning
        this.path = [];
        
        if (nodePath.length > 1) {
            for (let i = 0; i < nodePath.length; i++) {
                const nodeIdx = nodePath[i];
                const p = platforms[nodeIdx];
                
                // Calculate smart landing position based on path direction
                let wayX;
                if (i === nodePath.length - 1) {
                    // Final platform - go to target position
                    wayX = targetX;
                } else {
                    // Intermediate platform - position for next jump
                    const nextNodeIdx = nodePath[i + 1];
                    const nextP = platforms[nextNodeIdx];
                    wayX = this.calculateOptimalWaypointPosition(p, nextP, targetX);
                }
                
                this.path.push({
                    x: wayX,
                    y: p.y,
                    platformIndex: nodeIdx
                });
            }
        } else {
            // Fallback: direct path to target
            this.path.push({
                x: targetX,
                y: targetY,
                platformIndex: targetPlatform
            });
        }

        this.pathIndex = 0;
    }

    // ================================================================
    // NEW: Find the best intermediate platform to bridge two disconnected platforms
    // ================================================================
    findBestBridgePlatform(fromIdx, toIdx, platforms) {
        if (fromIdx < 0 || toIdx < 0) return null;

        const fromPlat = platforms[fromIdx];
        const toPlat = platforms[toIdx];
        
        let bestBridge = null;
        let bestScore = Infinity;

        for (let i = 0; i < platforms.length; i++) {
            if (i === fromIdx || i === toIdx) continue;
            
            const bridge = platforms[i];
            
            // Calculate if this platform can serve as a bridge
            const fromToBridge = this.canReachPlatform(fromPlat, bridge);
            const bridgeToTarget = this.canReachPlatform(bridge, toPlat);
            
            if (fromToBridge && bridgeToTarget) {
                // Score based on total distance and height efficiency
                const totalDist = this.platformDistance(fromPlat, bridge) + this.platformDistance(bridge, toPlat);
                const heightPenalty = Math.abs(bridge.y - (fromPlat.y + toPlat.y) / 2);
                const score = totalDist + heightPenalty * 2;
                
                if (score < bestScore) {
                    bestScore = score;
                    bestBridge = i;
                }
            }
        }

        return bestBridge;
    }

    // ================================================================
    // NEW: Check if one platform can reach another with a jump
    // ================================================================
    canReachPlatform(fromPlat, toPlat) {
        const heightDiff = fromPlat.y - toPlat.y;
        const horizontalGap = Math.max(0, 
            Math.min(Math.abs(toPlat.x - (fromPlat.x + fromPlat.w)), 
                     Math.abs(fromPlat.x - (toPlat.x + toPlat.w))));
        
        // Check jump constraints
        const canReachHeight = heightDiff <= MAX_SINGLE_JUMP_HEIGHT && heightDiff >= -MAX_DROP_DIST;
        const canReachDistance = horizontalGap <= MAX_HORIZONTAL_JUMP_DIST;
        
        return canReachHeight && canReachDistance;
    }

    // ================================================================
    // NEW: Calculate distance between two platforms
    // ================================================================
    platformDistance(platA, platB) {
        const dx = (platA.x + platA.w/2) - (platB.x + platB.w/2);
        const dy = platA.y - platB.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ================================================================
    // NEW: Calculate optimal waypoint position for path traversal
    // ================================================================
    calculateOptimalWaypointPosition(currentPlat, nextPlat, finalTargetX) {
        const margin = 30;
        const minX = currentPlat.x + margin;
        const maxX = currentPlat.x + currentPlat.w - margin;

        // If there's a next platform, position ourselves for the best jump to it
        if (nextPlat) {
            const nextCenterX = nextPlat.x + nextPlat.w / 2;
            
            // If next platform is higher, position for upward jump
            if (nextPlat.y < currentPlat.y - 20) {
                // Position closer to the edge we'll jump from
                const jumpFromRight = nextCenterX > currentPlat.x + currentPlat.w / 2;
                const optimalX = jumpFromRight ? maxX - 20 : minX + 20;
                return Math.max(minX, Math.min(maxX, optimalX));
            }
            // If next platform is at same level, position toward it
            else {
                const optimalX = nextCenterX;
                return Math.max(minX, Math.min(maxX, optimalX));
            }
        }

        // No next platform or fallback - use target position
        const targetX = finalTargetX;
        return Math.max(minX, Math.min(maxX, targetX));
    }

    // ================================================================
    // NEW: Calculate an intelligent landing position on a platform
    // for waypoint generation, preferring natural traversal paths
    // ================================================================
    calculateLandingPosition(platform, targetX) {
        // Validate platform exists
        if (!platform || typeof platform.x !== 'number' || typeof platform.w !== 'number') {
            return targetX;
        }
        
        const margin = 30;
        const minX = platform.x + margin;
        const maxX = platform.x + platform.w - margin;

        // Clamp the target X to within the platform bounds
        let landX = targetX;
        if (landX < minX) landX = minX;
        if (landX > maxX) landX = maxX;

        // Add slight offset to avoid standing exactly on edges
        if (landX - platform.x < 60) landX = platform.x + 40;
        if ((platform.x + platform.w) - landX < 60) landX = platform.x + platform.w - 40;

        return landX;
    }

    findAlternativePlatform(botPlatform, targetPlatform, targetX, platforms) {
        if (targetPlatform < 0) return null;

        const targetPlat = platforms[targetPlatform];
        let bestAlternative = null;
        let bestScore = Infinity;

        for (let i = 0; i < platforms.length; i++) {
            if (i === botPlatform || i === targetPlatform) continue;

            const p = platforms[i];
            
            const dx = (p.x + p.w / 2) - (targetPlat.x + targetPlat.w / 2);
            const dy = p.y - targetPlat.y;
            const distToTarget = Math.sqrt(dx * dx + dy * dy);
            const heightDiff = Math.abs(p.y - targetPlat.y);
            const score = distToTarget + heightDiff * 2;

            if (distToTarget < 400 && score < bestScore) {
                bestScore = score;
                bestAlternative = i;
            }
        }

        return bestAlternative;
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
                // Target platform is above - need to jump with momentum
                this.moveTowardWithJump(botPlayer, waypoint.x, waypoint.y, platforms, currentTick, true);
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

    directMove(botPlayer, targetX, targetY, platforms, currentTick) {
        // Redirect to the new smart direct move function
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
        const currentPlatIdx = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        if (currentPlatIdx < 0) return 100; // Default run-up

        const currentPlat = platforms[currentPlatIdx];
        const maxPlatformRunUp = Math.min(250, currentPlat.w * 0.4);

        // Look for what we're trying to jump to
        const reachablePlatforms = this.findReachablePlatforms(botPlayer, platforms, jumpDirection);
        
        if (reachablePlatforms.length === 0) {
            return Math.min(100, maxPlatformRunUp); // Conservative jump
        }

        // Find the furthest/highest platform we might want to reach
        let maxDistance = 0;
        let maxHeight = 0;

        for (const p of reachablePlatforms) {
            const jumpStartX = jumpDirection > 0 ? currentPlat.x + currentPlat.w : currentPlat.x;
            const horizontalDist = jumpDirection > 0 
                ? Math.max(0, p.x - jumpStartX)
                : Math.max(0, jumpStartX - (p.x + p.w));
            const heightDiff = Math.max(0, currentPlat.y - p.y);

            maxDistance = Math.max(maxDistance, horizontalDist);
            maxHeight = Math.max(maxHeight, heightDiff);
        }

        // Calculate run-up needed: more distance/height = more run-up
        const distanceRunUp = maxDistance * 0.4;
        const heightRunUp = maxHeight * 0.3;
        const totalRunUp = Math.max(80, distanceRunUp + heightRunUp);

        return Math.min(totalRunUp, maxPlatformRunUp);
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

        // Platform fail check
        if (this.jumpAttempts > 5 && this.state === 'CHASE') {
            const botPlatform = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
            
            if (this.path.length > 0 && this.path[0].platformIndex >= 0) {
                const targetPlatform = this.path[0].platformIndex;
                const alternativePlatform = this.findAlternativePlatform(botPlatform, targetPlatform, this.path[0].x, platforms);
                
                if (alternativePlatform !== null && alternativePlatform !== targetPlatform) {
                    if (!platformGraph || graphBuildVersion !== platforms.length) {
                        platformGraph = buildPlatformGraph(platforms);
                        graphBuildVersion = platforms.length;
                    }
                    
                    const nodePath = findPathInGraph(platformGraph, botPlatform, alternativePlatform);
                    this.path = [];
                    for (const nodeIdx of nodePath) {
                        // Validate platform exists before using it
                        if (nodeIdx < 0 || nodeIdx >= platforms.length) continue;
                        const p = platforms[nodeIdx];
                        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
                        const prevRef = this.path.length > 0 ? this.path[this.path.length - 1].x : botPlayer.x;
                        const wayX = this.calculateLandingPosition(p, prevRef);
                        this.path.push({
                            x: wayX,
                            y: p.y,
                            platformIndex: nodeIdx
                        });
                    }
                    this.pathIndex = 0;
                    this.jumpAttempts = 0;
                    this.debugInfo += ' ALT_PLAT!';
                } else {
                    this.path = [];
                    this.pathIndex = 0;
                    this.jumpAttempts = 0;
                    this.wanderDirection *= -1;
                    this.debugInfo += ' PLATFORM_FAIL!';
                }
            } else {
                this.path = [];
                this.pathIndex = 0;
                this.jumpAttempts = 0;
                this.wanderDirection *= -1;
                this.debugInfo += ' PLATFORM_FAIL!';
            }
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
        jumpPressed: false
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

    if (humanCount === 0 && currentBotCount < 4) {
        for (let i = currentBotCount; i < 4; i++) {
            const botPlayer = spawnBot(players, platforms, worldWidth, worldHeight, i + currentBotCount);
            const ws = null;
            players.set(botPlayer.id, { player: botPlayer, ws });
        }
        console.log(`Spawned ${4 - currentBotCount} bots (no human players)`);
    } else if (humanCount > 0 && currentBotCount < 4) {
        for (let i = currentBotCount; i < 4; i++) {
            const botPlayer = spawnBot(players, platforms, worldWidth, worldHeight, i + currentBotCount);
            const ws = null;
            players.set(botPlayer.id, { player: botPlayer, ws });
        }
        console.log(`Spawned ${4 - currentBotCount} bots alongside human players`);
    }

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
    buildPlatformGraph,
    getBotCount,
    getHumanPlayerCount,
    BOT_PERSONALITIES
};