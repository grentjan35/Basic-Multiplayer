// botAI.js - AI Bot system for Basic Multiplayer
// Handles bot spawning, pathfinding, platform navigation, vision, and combat

// ============================================================
    // CONSTANTS
    // ============================================================
    const BOT_VIEW_DISTANCE = 1000; // pixels (~25 game units)
    const BOT_FOV_DEGREES = 120; // field of view in degrees
    const BOT_ATTACK_RANGE = 70; // px - proximity to trigger attack (increased for earlier attacks)
    const BOT_CHASE_RANGE = 800; // px - distance to start/stop chasing
    const BOT_STUCK_TIMEOUT = 90; // ticks (3 sec at 30 TPS) before path recalc
    const BOT_PLATFORM_FAIL_TIMEOUT = 60; // ticks before giving up on a platform jump
    const MAX_SINGLE_JUMP_HEIGHT = 100; // px - max height reachable with single jump
    const MAX_DOUBLE_JUMP_HEIGHT = 200; // px - max height reachable with double jump
    const MAX_HORIZONTAL_JUMP_DIST = 500; // px - max horizontal distance for a jump
    const MAX_DROP_DIST = 300; // px - max distance to consider dropping down
    const BOT_PERSONALITIES = ['aggressive', 'cautious', 'fast', 'balanced'];

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
                    } else if (heightDiff <= MAX_DOUBLE_JUMP_HEIGHT && !isBlockedVertical(platforms, a, b)) {
                        const cost = 5 + heightDiff / 50 + centerDist / 200;
                        graph[i].push({ to: j, action: 'double_jump', cost });
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
            // Check if a jump from the left/right edge of platform a can reach platform b
            if (vDist > 0 && vDist <= MAX_DOUBLE_JUMP_HEIGHT) {
                // From right edge of a to left edge of b
                const edgeDist = Math.sqrt(
                    Math.pow(aRight - bLeft, 2) + Math.pow(a.y - b.y, 2)
                );
                // From left edge of a to right edge of b
                const edgeDist2 = Math.sqrt(
                    Math.pow(aLeft - bRight, 2) + Math.pow(a.y - b.y, 2)
                );

                const minEdgeDist = Math.min(edgeDist, edgeDist2);
                if (minEdgeDist < MAX_HORIZONTAL_JUMP_DIST) {
                    const isDouble = vDist > MAX_SINGLE_JUMP_HEIGHT;
                    const action = isDouble ? 'double_jump' : 'jump';
                    const cost = (isDouble ? 5 : 3) + minEdgeDist / 200;
                    if (b.y < a.y && !isBlockedVertical(platforms, a, b)) {
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
    const yLower = b.y; // upper platform
    const yUpper = a.y; // lower platform (where bot stands)
    const left = Math.min(a.x, b.x) - 20;
    const right = Math.max(a.x + a.w, b.x + b.w) + 20;

    for (const p of platforms) {
        if (p === a || p === b) continue;
        // Check if platform p is between a and b and blocks the jump
        if (p.y < yUpper && p.y + p.h > yLower + 20) {
            // Platform is in the vertical range
            if (p.x < right && p.x + p.w > left) {
                // Platform is in the horizontal range and blocks
                return true;
            }
        }
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

// Check if a point is above a platform (can drop down to it)
function isAbovePlatform(px, py, platform) {
    const feetY = py + 60;
    return feetY < platform.y + 10 &&
           px + 40 > platform.x &&
           px < platform.x + platform.w &&
           py > platform.y - 200;
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
            if (id === this.playerId || player.isDead) continue;

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
            var botsOnHuman = targetCounts.get(closestHuman.id) || 0;
            if (botsOnHuman < 3) {
                bestHumanScore = humanScore;
                selectedHuman = closestHuman;
            }
        }

        var selectedBot = null;
        var bestBotScore = Infinity;
        if (closestTarget) {
            var botScore = scoreTarget(closestTarget, 200);
            var botsOnBot = targetCounts.get(closestTarget.id) || 0;
            if (botsOnBot < 3) {
                bestBotScore = botScore;
                selectedBot = closestTarget;
            }
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
            // Random chance to jump or turn around
            if (Math.random() > 0.5) {
                botPlayer.inputs.jump = true;
            } else {
                this.wanderDirection *= -1;
                botPlayer.inputs.right = !moveRight;
                botPlayer.inputs.left = !moveLeft;
            }
        }

        // Random jumps
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
        // When the player is in mid-air, stop aggressive horizontal pursuit and hold
        // position on the current platform instead of blindly chasing.
        if (target.isBot === false && !target.onGround) {
            // Target is airborne — hold position and wait for them to land
            botPlayer.inputs.right = false;
            botPlayer.inputs.left = false;
            this.state = 'PATROL';
            this.debugInfo += 'WAIT_FOR_LAND';
            return;
        }

        // Detect if both on full-width ground
        const botOnGround = this.isGroundPlatform(botPlayer, platforms);
        let targetOnGround = false;
        if (typeof target.y === 'number') {
            const targetFeetY = target.y + 60;
            for (var p of platforms) {
                if (targetFeetY >= p.y - 5 && targetFeetY <= p.y + 15 && p.w > 4500) {
                    targetOnGround = true;
                    break;
                }
            }
        }

        // Clamp chase target so the bot stops at combat distance instead of
        // moving onto the player's exact coordinates.
        target = this.getCombatTarget(botPlayer, target);

        // Use DirectMove when both are on ground and target is elevated so
        // the bot can climb toward the player.
        if (botOnGround && !targetOnGround) {
            this.path = [];
            this.directMove(botPlayer, target.x, target.y, platforms, currentTick);
            this.debugInfo += `CHASE(GROUND)->(${Math.round(target.x)},${Math.round(target.y)})`;
            return;
        }

        // Build path to target
        this.pathfindToTarget(botPlayer, target.x, target.y, platforms);

        // Follow path
        if (this.path.length > 0) {
            this.followPath(botPlayer, platforms, currentTick);
        } else {
            // Direct chase
            this.directMove(botPlayer, target.x, target.y, platforms, currentTick);
        }

        this.debugInfo += `CHASE->(${Math.round(target.x)},${Math.round(target.y)})`;
    }

    attackBehavior(botPlayer, targetPlayer, platforms, currentTick) {
        if (!targetPlayer) {
            this.state = 'CHASE';
            return;
        }

        // If the target is a human player who is airborne, stop chasing them.
        // Hold current position — don't walk off edges chasing a falling/jumping player.
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
        const tooCloseDistance = 25; // Too close = standing on top of player

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
                // Target is left, move right to back up
                botPlayer.inputs.right = true;
                botPlayer.inputs.left = false;
            } else {
                // Target is right, move left to back up
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
            // In good attack range - strafe occasionally to avoid being predictable
            if (Math.random() < 0.03) {
                // Random strafe direction
                if (Math.random() > 0.5) {
                    botPlayer.inputs.right = true;
                    botPlayer.inputs.left = false;
                } else {
                    botPlayer.inputs.right = false;
                    botPlayer.inputs.left = true;
                }
            } else {
                // Stop moving when in optimal range
                botPlayer.inputs.right = false;
                botPlayer.inputs.left = false;
            }
        }

        // Attack when in range
        if (dist <= BOT_ATTACK_RANGE && this.attackCooldown <= 0) {
            botPlayer.inputs.attack = true;
            this.attackCooldown = 15 + Math.random() * 10; // 0.5-0.8 sec cooldown

            // Aggressive bots attack more
            if (this.personality === 'aggressive') {
                this.attackCooldown *= 0.7;
            }
        } else if (dist > BOT_ATTACK_RANGE * 1.5) {
            // Target moved out of range, chase
            this.state = 'CHASE';
        }

        // Don't walk off edges while attacking
        if (this.isAtPlatformEdge(botPlayer, platforms, botPlayer.facingRight ? 1 : -1)) {
            // Step back from edge
            if (botPlayer.facingRight) {
                botPlayer.inputs.right = false;
                botPlayer.inputs.left = true;
            } else {
                botPlayer.inputs.right = true;
                botPlayer.inputs.left = false;
            }
        }

        // Small strafing jumps to avoid being predictable
        if (Math.random() < 0.03 && botPlayer.onGround) {
            botPlayer.inputs.jump = true;
        }

        this.debugInfo += 'ATTACK';
    }

    // ============================================================
    // PATHFINDING & MOVEMENT
    // ============================================================

    pathfindToTarget(botPlayer, targetX, targetY, platforms) {
        // Find platforms for bot and target
        const botPlatform = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        const targetPlatform = findPlatformAt(targetX, targetY, platforms);

        if (botPlatform < 0 || targetPlatform < 0) {
            // If on same platform or can't determine, use direct movement
            this.path = [{
                x: targetX,
                y: targetY,
                platformIndex: targetPlatform
            }];
            this.pathIndex = 0;
            return;
        }

        // If both on the full-width ground platform, skip graph pathfinding
        // since ground has no edges - just go directly toward the player
        if (botPlatform === targetPlatform) {
            const p = platforms[botPlatform];
            if (p.w > 4500) {
                // Full-width ground - set direct target toward player, not platform edge
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

        // If no path found or path is just the start node (no actual path),
        // try to find an alternative platform near the target
        if (nodePath.length <= 1 || (nodePath.length === 1 && nodePath[0] === botPlatform)) {
            const alternativePlatform = this.findAlternativePlatform(botPlatform, targetPlatform, targetX, platforms);
            if (alternativePlatform !== null && alternativePlatform !== targetPlatform) {
                nodePath = findPathInGraph(platformGraph, botPlatform, alternativePlatform);
            }
        }

        // Convert node path to waypoints
        this.path = [];
        for (const nodeIdx of nodePath) {
            const p = platforms[nodeIdx];
            // Add waypoint near the center of the platform, offset toward target direction
            const wayX = targetX < p.x + p.w / 2 ? p.x + 20 : p.x + p.w - 20;
            this.path.push({
                x: wayX,
                y: p.y,
                platformIndex: nodeIdx
            });
        }

        // Add final target waypoint
        this.path.push({
            x: targetX,
            y: targetY,
            platformIndex: targetPlatform
        });

        this.pathIndex = 0;
    }

    // Find an alternative platform near the target that might be reachable
    findAlternativePlatform(botPlatform, targetPlatform, targetX, platforms) {
        if (targetPlatform < 0) return null;

        const targetPlat = platforms[targetPlatform];
        let bestAlternative = null;
        let bestScore = Infinity;

        for (let i = 0; i < platforms.length; i++) {
            if (i === botPlatform || i === targetPlatform) continue;

            const p = platforms[i];
            
            // Calculate distance from this platform to target platform
            const dx = (p.x + p.w / 2) - (targetPlat.x + targetPlat.w / 2);
            const dy = p.y - targetPlat.y;
            const distToTarget = Math.sqrt(dx * dx + dy * dy);

            // Prefer platforms at similar height to target (easier to reach player from there)
            const heightDiff = Math.abs(p.y - targetPlat.y);
            
            // Score: distance to target + height penalty
            const score = distToTarget + heightDiff * 2;

            // Only consider platforms within reasonable distance
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
        const nextWaypoint = this.pathIndex + 1 < this.path.length ? this.path[this.pathIndex + 1] : null;

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
                // Target platform is above - need to jump
                this.moveTowardWithJump(botPlayer, waypoint.x, waypoint.y, platforms, currentTick, true);
            } else if (b.y > a.y) {
                // Target platform is below - need to drop or walk off edge
                if (this.isAbovePlatform(botPlayer.x, botPlayer.y, b)) {
                    // Directly above, can drop down
                    this.moveTowardWithJump(botPlayer, waypoint.x, waypoint.y, platforms, currentTick, false);
                } else {
                    // Need to walk to edge and drop
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
            // Same platform - just walk toward waypoint
            this.moveToward(botPlayer, waypoint.x, platforms);
        }
    }

    // Check if current platform is the full-width ground (no actual edges)
    isGroundPlatform(botPlayer, platforms) {
        if (!botPlayer.onGround) return false;
        const feetY = botPlayer.y + 60;
        for (const p of platforms) {
            if (feetY >= p.y - 5 && feetY <= p.y + 15) {
                // Platform spans more than 90% of world width = ground
                if (p.w > 4500) return true;
                break;
            }
        }
        return false;
    }

    // Find the nearest platform above that is reachable via a jump
    findNearestAbovePlatform(botPlayer, platforms) {
        const botPlat = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
        if (botPlat < 0) return null;
        
        const currentPlat = platforms[botPlat];
        let best = null;
        let bestDist = Infinity;
        
        for (let i = 0; i < platforms.length; i++) {
            if (i === botPlat) continue;
            const p = platforms[i];
            // Must be above us
            if (p.y >= currentPlat.y) continue;
            // Must be within jump height
            const heightDiff = currentPlat.y - p.y;
            if (heightDiff > MAX_SINGLE_JUMP_HEIGHT) continue;
            // Check horizontal overlap
            const hOverlap = Math.min(botPlayer.x + 40, p.x + p.w) - Math.max(botPlayer.x, p.x);
            if (hOverlap > 0) {
                // We can jump straight up to reach this platform
                // Calculate horizontal distance from bot to get under it
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

    // Find the nearest staircase platform to climb up
    findClosestClimbablePlatform(botPlayer, platforms) {
        let bestPlat = null;
        let bestDist = Infinity;
        const feetY = botPlayer.y + 60;
        
        // Find current platform
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
            // Must be above current platform
            if (p.y >= currentPlat.y) continue;
            const heightDiff = currentPlat.y - p.y;
            if (heightDiff > MAX_SINGLE_JUMP_HEIGHT) continue;
            
            // Calculate distance from bot to the nearest point on this platform
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

    getCombatTarget(botPlayer, /* {x,y} */ target) {
        if (!target) {
            return null;
        }

        const bx = botPlayer.x;
        const by = botPlayer.y;
        const tx = target.x;
        const ty = target.y;

        const desiredChaseDist = this.attackRange + 60; // fight from ~1.5 attack-radii away

        const dx = tx - bx;
        const dy = ty - by;
        const absDx = Math.abs(dx);

        // Already inside the combat ring – lock to the player's position.
        if (absDx <= desiredChaseDist) {
            return { x: tx, y: ty };
        }

        // Position to the side of the player at the same elevation
        const sideOffset = 60; // pixels to the side
        const targetX = dx > 0 ? tx + sideOffset : tx - sideOffset;
        const targetY = ty; // same level as player

        return {
            x: targetX,
            y: targetY,
        };
    }

    directMove(botPlayer, targetX, targetY, platforms, currentTick) {
        const dx = targetX - botPlayer.x;
        const dy = targetY - botPlayer.y;
        const isGround = this.isGroundPlatform(botPlayer, platforms);

        // When on the full-width ground with target above, just run TOWARD the player
        // and jump frequently to catch onto platforms
        if (isGround && dy < -30) {
            if (dx > 0) {
                botPlayer.inputs.right = true;
                botPlayer.inputs.left = false;
                botPlayer.facingRight = true;
            } else {
                botPlayer.inputs.right = false;
                botPlayer.inputs.left = true;
                botPlayer.facingRight = false;
            }
            // Jump frequently while running toward player to catch onto higher platforms
            if (Math.random() < 0.08) {
                botPlayer.inputs.jump = true;
                this.lastJumpTick = currentTick;
                this.jumpAttempts++;
            }
            return;
        }

        // Standard case: not on ground, or target is same level
        const moveDir = dx > 0 ? 1 : -1;
        const atEdge = this.isAtPlatformEdge(botPlayer, platforms, moveDir);

        // Target is above us
        if (dy < -30) {
            if (!botPlayer.onGround) {
                this.moveToward(botPlayer, targetX, platforms);
                return;
            }

            if (atEdge) {
                // At a platform edge - jump immediately
                botPlayer.inputs.jump = true;
                this.lastJumpTick = currentTick;
                this.jumpAttempts++;
            } else {
                // Run toward edge/target
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
        } else if (dy > 60 && botPlayer.onGround) {
            // Target below
            if (atEdge) {
                botPlayer.inputs.down = true;
            }
            this.moveToward(botPlayer, targetX, platforms);
        } else {
            // Same level
            this.moveToward(botPlayer, targetX, platforms);
            if (atEdge && botPlayer.onGround) {
                botPlayer.inputs.jump = true;
                this.lastJumpTick = currentTick;
                this.jumpAttempts++;
            }
        }
    }

    moveToward(botPlayer, targetX, platforms) {
        const dx = targetX - botPlayer.x;
        if (Math.abs(dx) < 10) {
            botPlayer.inputs.left = false;
            botPlayer.inputs.right = false;
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

    moveTowardWithJump(botPlayer, targetX, targetY, platforms, currentTick, shouldJump) {
        const dx = targetX - botPlayer.x;
        const dy = targetY - botPlayer.y;
        const moveDir = dx > 0 ? 1 : -1;
        const atEdge = this.isAtPlatformEdge(botPlayer, platforms, moveDir);

        // Move toward target horizontally
        if (dx > 0) {
            botPlayer.inputs.right = true;
            botPlayer.inputs.left = false;
            botPlayer.facingRight = true;
        } else {
            botPlayer.inputs.right = false;
            botPlayer.inputs.left = true;
            botPlayer.facingRight = false;
        }

        // Jump logic - ALWAYS jump at the edge, no momentum building
        if (shouldJump && botPlayer.onGround && atEdge) {
            botPlayer.inputs.jump = true;
            this.lastJumpTick = currentTick;
            this.jumpAttempts++;
        }
    }

    isAtPlatformEdge(botPlayer, platforms, direction) {
        // Check if walking in `direction` would lead off the current platform
        if (!botPlayer.onGround) return false;

        const checkX = direction > 0 ? botPlayer.x + 42 : botPlayer.x - 2;
        const feetY = botPlayer.y + 60;

        for (const p of platforms) {
            if (feetY >= p.y - 5 && feetY <= p.y + 15) {
                if (checkX >= p.x && checkX <= p.x + p.w) {
                    return false; // Still on this platform
                }
            }
        }

        return true; // No platform found ahead = at edge
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

        // If stuck for too long
        if (this.stuckTimer > BOT_STUCK_TIMEOUT) {
            // Reset path and try something different
            this.path = [];
            this.pathIndex = 0;
            this.stuckTimer = 0;
            this.jumpAttempts = 0;

            // Random jump to break stuck
            botPlayer.inputs.jump = true;

            // Change wander direction
            if (Math.random() > 0.5) {
                this.wanderDirection *= -1;
            }

            // If stuck for very long, switch state
            if (this.stuckTimer > BOT_STUCK_TIMEOUT * 2) {
                this.state = 'PATROL';
            }

            this.debugInfo += ' STUCK!';
        }

        // Platform fail check - try alternative platform
        if (this.jumpAttempts > 5 && this.state === 'CHASE') {
            // Failed to reach platform, try alternative
            const botPlatform = findPlatformAt(botPlayer.x, botPlayer.y, platforms);
            
            // If we have a target platform in our path, try alternative
            if (this.path.length > 0 && this.path[0].platformIndex >= 0) {
                const targetPlatform = this.path[0].platformIndex;
                const alternativePlatform = this.findAlternativePlatform(botPlatform, targetPlatform, this.path[0].x, platforms);
                
                if (alternativePlatform !== null && alternativePlatform !== targetPlatform) {
                    // Rebuild path to alternative platform
                    if (!platformGraph || graphBuildVersion !== platforms.length) {
                        platformGraph = buildPlatformGraph(platforms);
                        graphBuildVersion = platforms.length;
                    }
                    
                    const nodePath = findPathInGraph(platformGraph, botPlatform, alternativePlatform);
                    this.path = [];
                    for (const nodeIdx of nodePath) {
                        const p = platforms[nodeIdx];
                        const wayX = this.path[0].x < p.x + p.w / 2 ? p.x + 20 : p.x + p.w - 20;
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
                    // No alternative found, just reset
                    this.path = [];
                    this.pathIndex = 0;
                    this.jumpAttempts = 0;
                    this.wanderDirection *= -1;
                    this.debugInfo += ' PLATFORM_FAIL!';
                }
            } else {
                // No path target, just reset
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
// For the first 8 bots (botIndex 0-7), place them on the highest platforms at the very top of the map.
// The remaining 2 bots (botIndex 8-9) spawn on lower platforms or ground.
function findBotSpawnPosition(players, platforms, worldWidth, worldHeight) {
    const PLAYER_WIDTH = 40;
    const PLAYER_HEIGHT = 60;
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
        // HIGH TIER: TIER 7 (y: 100-200) — absolute sky platforms at the very top of the world
        // HIGH TIER: TIER 6 (y: 500-700) — very high platforms just below the sky tier
        // LOW TIER: ground and low platforms
        let highTierPlatforms = [];
        let lowTierPlatforms = [];

        for (const p of platforms) {
            if (p.y <= 400) {
                highTierPlatforms.push(p);
            } else {
                lowTierPlatforms.push(p);
            }
        }

        // Use global spawn counter via botAIs to know how many bots have been spawned this session
        const existingBotCount = global.botAIs ? global.botAIs.size : 0;
        const useHighTier = existingBotCount < 8; // First 8 bots → very top of map

        let platform;
        if (useHighTier && highTierPlatforms.length > 0) {
            // Spawn on the highest platforms available (sky tier / TIER 6)
            platform = highTierPlatforms[Math.floor(Math.random() * highTierPlatforms.length)];
        } else if (Math.random() < 0.4) {
            // Spawn on ground
            platform = platforms[0];
        } else if (lowTierPlatforms.length > 0) {
            // Spawn on a random lower platform
            platform = lowTierPlatforms[Math.floor(Math.random() * lowTierPlatforms.length)];
        } else {
            // Fallback: ground
            platform = platforms[0];
        }

        const x = platform.x + 20 + Math.random() * Math.max(1, platform.w - 60);
        const y = platform.y - PLAYER_HEIGHT;

        // Check if too close to any existing player
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

    // Fallback: left side of ground
    return { x: 100 + Math.random() * 200, y: worldHeight - 100 - PLAYER_HEIGHT };
}

// Verify spawn doesn't overlap with player (simplified check)
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

// Spawn a bot and add it to the players map
function spawnBot(players, platforms, worldWidth, worldHeight, botIndex) {
    const position = findBotSpawnPosition(players, platforms, worldWidth, worldHeight);
    const character = BOT_CHARACTERS[botIndex % BOT_CHARACTERS.length];

    // Create negative ID to avoid conflict with real players
    const botId = -(botIndex + 999);

    // Generate dark color
    const hue = Math.floor(Math.random() * 360);
    const color = `hsl(${hue}, 20%, 35%)`;

    // Create the bot player object (same structure as real players)
    const Player = require('./server').Player;
    // Can't import this way since it's defined internally
    // Instead, create a player object with the same structure

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

    // Create and store the AI
    const personality = getBotPersonality(botIndex);
    const ai = new BotAI(botId, personality);
    botAIs.set(botId, ai);

    console.log(`Spawned bot ${botIndex} (${personality}) at (${Math.round(position.x)}, ${Math.round(position.y)})`);

    return botPlayer;
}

// Check if a bot should respawn
function checkBotRespawn(botPlayer, players, platforms, worldWidth, worldHeight, botAIsMap) {
    if (botPlayer.isDead && botPlayer.deathTimer <= 0 && !botPlayer.isFading) {
        // Bot is dead and ready to respawn
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

        // Reset AI state
        const ai = botAIsMap.get(botPlayer.id);
        if (ai) ai.reset();
    }
}

// Get count of human players
function getHumanPlayerCount(players) {
    let count = 0;
    for (const [id, { player }] of players) {
        if (!player.isBot) count++;
    }
    return count;
}

// Get count of bot players
function getBotCount(players) {
    let count = 0;
    for (const [id, { player }] of players) {
        if (player.isBot) count++;
    }
    return count;
}

// Main update function called from server game loop
function updateBotAI(players, platforms, worldWidth, worldHeight, currentTick) {
    // Ensure bot AIs map exists
    if (!global.botAIs) {
        global.botAIs = new Map();
    }
    const botAIs = global.botAIs;

    // Spawn bots if no human players
    const humanCount = getHumanPlayerCount(players);
    const currentBotCount = getBotCount(players);

    if (humanCount === 0 && currentBotCount < 10) {
        // Spawn missing bots
        for (let i = currentBotCount; i < 10; i++) {
            const botPlayer = spawnBot(players, platforms, worldWidth, worldHeight, i + currentBotCount);
            // Add to players map
            const ws = null; // bots don't have WebSocket
            players.set(botPlayer.id, { player: botPlayer, ws });
        }
        console.log(`Spawned ${10 - currentBotCount} bots (no human players)`);
    } else if (humanCount > 0 && currentBotCount < 10) {
        // Keep bots for practice even when human players are present
        for (let i = currentBotCount; i < 10; i++) {
            const botPlayer = spawnBot(players, platforms, worldWidth, worldHeight, i + currentBotCount);
            const ws = null;
            players.set(botPlayer.id, { player: botPlayer, ws });
        }
        console.log(`Spawned ${10 - currentBotCount} bots alongside human players`);
    }

    // Update each bot's AI
    for (const [id, { player }] of players) {
        if (!player.isBot) continue;

        // Check respawn
        if (player.isDead) {
            checkBotRespawn(player, players, platforms, worldWidth, worldHeight, botAIs);
        }

        // Get or create AI
        let ai = botAIs.get(id);
        if (!ai) {
            ai = new BotAI(id, getBotPersonality(player.botIndex || 0));
            botAIs.set(id, ai);
        }

        // Reset inputs before AI sets them
        player.inputs = { left: false, right: false, jump: false, attack: false, down: false };

        // Update AI
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