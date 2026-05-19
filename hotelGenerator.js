/**
 * Procedural Hotel Generator for Basic Multiplayer
 * 
 * Generates complete, multi-story hotel environments using the game's
 * platform system. Each floor has rooms, hallways, common areas, and
 * stairs connecting all levels.
 * 
 * Platforms are returned as { x, y, w, h } objects compatible with
 * the existing physics/collision system in server.js
 */

// ============================================================
// CONFIGURATION
// ============================================================

const HOTEL_CONFIG = {
    // Overall building footprint (in pixels)
    buildingWidth: 1600,
    buildingDepth: 600,
    
    // Vertical structure
    floorCount: 6,
    floorHeight: 280,       // vertical space between floor surfaces
    floorThickness: 16,     // thickness of each floor slab
    
    // Room configuration
    roomWidth: 150,
    
    // Hallway
    hallwayWidth: 120,
    
    // Staircase
    stairStepWidth: 40,
    stairStepHeight: 20,
    
    // World position (center of hotel)
    worldX: 2500,
    worldY: 100,           // top of the hotel (highest point - lowest y value)
    
    // Wall thickness
    wallThickness: 8
};

// Floor themes with features
const FLOOR_THEMES = [
    { name: 'Lobby & Reception',  ceilingHeight: 360, hasPool: true,  hasBar: true,  hasRestaurant: true  },
    { name: 'Guest Rooms',        ceilingHeight: 240, hasPool: false, hasBar: false, hasRestaurant: false },
    { name: 'Guest Rooms - Suites',ceilingHeight: 260, hasPool: false, hasBar: false, hasRestaurant: false },
    { name: 'Executive Suites',   ceilingHeight: 260, hasPool: false, hasBar: true,  hasRestaurant: false },
    { name: 'Penthouse A',        ceilingHeight: 280, hasPool: true,  hasBar: true,  hasRestaurant: true  },
    { name: 'Penthouse B',        ceilingHeight: 280, hasPool: true,  hasBar: true,  hasRestaurant: false },
    { name: 'Rooftop Club',       ceilingHeight: 260, hasPool: true,  hasBar: true,  hasRestaurant: true  }
];

// ============================================================
// GENERATOR
// ============================================================

/**
 * Generate a complete hotel structure
 * @param {Object} [overrides] - Optional overrides for HOTEL_CONFIG
 * @returns {Array} Array of platform objects { x, y, w, h }
 */
function generateHotel(overrides = {}) {
    const config = { ...HOTEL_CONFIG, ...overrides };
    const platforms = [];
    
    const { worldX, worldY, buildingWidth, floorCount, floorHeight, floorThickness } = config;
    const leftEdge = worldX - buildingWidth / 2;
    
    // Track which areas are already occupied to avoid overlaps
    const occupied = new Set();
    function isOccupied(x, y, w, h) {
        const margin = 5;
        for (const key of occupied) {
            const [ox, oy, ow, oh] = key.split(',').map(Number);
            if (x < ox + ow + margin && x + w > ox - margin &&
                y < oy + oh + margin && y + h > oy - margin) {
                return true;
            }
        }
        return false;
    }
    function addOccupied(x, y, w, h) {
        occupied.add(`${x},${y},${w},${h}`);
    }
    function addPlatform(x, y, w, h) {
        // Round values to avoid floating point issues
        const px = Math.round(x * 10) / 10;
        const py = Math.round(y * 10) / 10;
        const pw = Math.round(w * 10) / 10;
        const ph = Math.round(h * 10) / 10;
        if (!isOccupied(px, py, pw, ph)) {
            platforms.push({ x: px, y: py, w: pw, h: ph });
            addOccupied(px, py, pw, ph);
        }
    }
    
    // =========================================================
    // Generate each floor from bottom to top
    // =========================================================
    for (let floor = 0; floor < floorCount; floor++) {
        const floorY = worldY + (floorCount - 1 - floor) * floorHeight;
        const theme = FLOOR_THEMES[floor] || FLOOR_THEMES[FLOOR_THEMES.length - 1];
        const ceilingH = theme.ceilingHeight || floorHeight;
        
        // Floor slab (standing surface)
        addPlatform(leftEdge, floorY, buildingWidth, floorThickness);
        
        // Exterior left wall (skip where doorways are)
        const leftWallSegments = splitWallForDoorways(0, floorY, buildingWidth, ceilingH, config);
        for (const seg of leftWallSegments) {
            addPlatform(leftEdge - config.wallThickness, seg.y, config.wallThickness, seg.h);
        }
        
        // Exterior right wall
        const rightWallSegments = splitWallForDoorways(0, floorY, buildingWidth, ceilingH, config);
        for (const seg of rightWallSegments) {
            addPlatform(leftEdge + buildingWidth, seg.y, config.wallThickness, seg.h);
        }
        
        // Ceiling platform (top boundary)
        addPlatform(leftEdge, floorY - ceilingH, buildingWidth, config.wallThickness);
        
        // Interior layout
        generateInterior(platforms, config, floor, floorY, ceilingH, theme, addPlatform, isOccupied);
        
        // Stairs connecting this floor to the one above
        if (floor < floorCount - 1) {
            const aboveY = worldY + (floorCount - 2 - floor) * floorHeight;
            generateStaircase(platforms, config, floor, floorY, aboveY, ceilingH, addPlatform, isOccupied);
        }
    }
    
    // Roof elements
    generateRoof(platforms, config, addPlatform);
    
    // Exterior features
    generateExterior(platforms, config, addPlatform);
    
    console.log(`Hotel Generator: Created ${platforms.length} platforms for ${floorCount}-story hotel`);
    return platforms;
}

/**
 * Split a wall into segments with a doorway gap
 */
function splitWallForDoorways(roomIndex, floorY, buildingWidth, ceilingHeight, config) {
    // Exterior walls have no doorways (they're outer walls)
    // Full wall from floor to ceiling
    return [{
        y: floorY - ceilingHeight + config.wallThickness,
        h: ceilingHeight - config.wallThickness
    }];
}

/**
 * Generate interior layout for a floor
 */
function generateInterior(platforms, config, floor, floorY, ceilingH, theme, addPlatform, isOccupied) {
    const cfg = getConfig(config);
    const { leftEdge, buildingWidth, hallwayWidth, wallThickness, roomWidth } = cfg;
    
    const hallwayLeft = leftEdge + (buildingWidth - hallwayWidth) / 2;
    
    // Number of rooms on each side
    const sideWidth = (buildingWidth - hallwayWidth) / 2;
    const roomsPerSide = Math.max(2, Math.floor(sideWidth / roomWidth));
    const actualRoomWidth = sideWidth / roomsPerSide;
    
    // Room percentage for features
    const hasPool = theme.hasPool;
    const hasBar = theme.hasBar;
    const hasRestaurant = theme.hasRestaurant;
    const isLobby = floor === 0;
    
    // Room divider walls (perpendicular to hallway) - LEFT side
    for (let i = 0; i <= roomsPerSide; i++) {
        const wallX = leftEdge + i * actualRoomWidth;
        // Only add wall panels (skip doorway position)
        const doorX = wallX + actualRoomWidth / 2; // Door in center of each room
        // Create wall segments above/below door
        addPlatform(
            wallX - wallThickness / 2,
            floorY - ceilingH + wallThickness,
            wallThickness,
            ceilingH - wallThickness
        );
    }
    
    // Room divider walls - RIGHT side
    const rightStart = hallwayLeft + hallwayWidth;
    for (let i = 0; i <= roomsPerSide; i++) {
        const wallX = rightStart + i * actualRoomWidth;
        addPlatform(
            wallX - wallThickness / 2,
            floorY - ceilingH + wallThickness,
            wallThickness,
            ceilingH - wallThickness
        );
    }
    
    // Hallway walls (walls between rooms and hallway)
    // These need doorways for each room
    
    // LEFT hallway wall
    createHallwayWallWithDoors(platforms, config, floor, floorY, ceilingH,
        hallwayLeft, leftEdge, rightStart, 'left', roomsPerSide, actualRoomWidth, addPlatform);
    
    // RIGHT hallway wall
    createHallwayWallWithDoors(platforms, config, floor, floorY, ceilingH,
        hallwayLeft + hallwayWidth, leftEdge, rightStart, 'right', roomsPerSide, actualRoomWidth, addPlatform);
    
    // --- Interior features ---
    
    if (isLobby) {
        // Ground floor features
        generateLobby(platforms, config, floor, floorY, ceilingH, addPlatform);
    }
    
    if (hasPool) {
        generatePoolArea(platforms, config, floor, floorY, ceilingH, addPlatform, leftEdge, buildingWidth);
    }
    
    if (hasBar) {
        generateBarArea(platforms, config, floor, floorY, addPlatform, leftEdge, buildingWidth);
    }
    
    if (hasRestaurant) {
        generateRestaurantArea(platforms, config, floor, floorY, addPlatform, leftEdge, buildingWidth);
    }
    
    // Add furniture in rooms
    for (let side = 0; side < 2; side++) {
        const sideStartX = side === 0 ? leftEdge : rightStart;
        for (let i = 0; i < roomsPerSide; i++) {
            const roomCenterX = sideStartX + i * actualRoomWidth + actualRoomWidth / 2;
            
            // Add bed/desk platforms in rooms
            if ((i + floor) % 3 !== 0) {
                addPlatform(roomCenterX - 25, floorY - 10, 50, 6);
            }
            if ((i + floor) % 2 === 0) {
                addPlatform(roomCenterX - 15, floorY - 20, 30, 5);
            }
        }
    }
}

/**
 * Create a hallway wall with doorways for each room
 */
function createHallwayWallWithDoors(platforms, config, floor, floorY, ceilingH,
    wallX, leftEdge, rightStart, side, roomsPerSide, actualRoomWidth, addPlatform) {
    
    const { wallThickness } = getConfig(config);
    const doorWidth = 32;
    const doorHeight = 50;
    
    // Wall segments: [y, h] pairs for solid sections
    const segments = [];
    
    // Top of wall (above door)
    const topY = floorY - ceilingH + wallThickness;
    const topH = ceilingH - wallThickness - doorHeight;
    if (topH > 0) {
        segments.push({ y: topY, h: topH });
    }
    
    // Bottom of wall (below door) - already covered by floor
    
    // Create the wall as one solid piece, but with gaps for doorways
    // Since we can't "remove" parts, we generate separate wall pieces
    const sideStart = side === 'left' ? leftEdge : rightStart;
    const sideEnd = side === 'left' ? wallX : wallX + 10;
    const wallLength = Math.abs(sideEnd - sideStart);
    
    // Generate wall sections between rooms (including door gaps)
    for (let i = 0; i < roomsPerSide; i++) {
        const roomStartX = sideStart + i * actualRoomWidth;
        const roomEndX = roomStartX + actualRoomWidth;
        const doorCenterX = roomStartX + actualRoomWidth / 2;
        const doorLeft = doorCenterX - doorWidth / 2;
        const doorRight = doorCenterX + doorWidth / 2;
        
        // Wall section to the left of door (from room divider to door)
        const leftSectionW = doorLeft - roomStartX;
        if (leftSectionW > wallThickness) {
            // Platform from hall wall to left side
            const platW = side === 'left' ? 
                wallX - roomStartX :
                roomStartX + leftSectionW - wallX;
            if (platW > 0) {
                addPlatform(
                    side === 'left' ? roomStartX : wallX,
                    topY,
                    side === 'left' ? wallX - roomStartX : leftSectionW,
                    topH
                );
            }
        }
        
        // Wall section to the right of door
        const rightSectionW = roomEndX - doorRight;
        if (rightSectionW > wallThickness) {
            addPlatform(
                side === 'left' ? doorRight : wallX,
                topY,
                side === 'left' ? roomEndX - doorRight : rightSectionW,
                topH
            );
        }
    }
}

/**
 * Generate lobby features
 */
function generateLobby(platforms, config, floor, floorY, ceilingH, addPlatform) {
    const { leftEdge, buildingWidth, wallThickness } = getConfig(config);
    
    // Reception desk
    addPlatform(leftEdge + buildingWidth * 0.25, floorY - 20, 80, 12);
    
    // Decorative pillars (vertical platforms from floor to ceiling)
    const pillarPositions = [0.15, 0.4, 0.6, 0.85];
    for (const pos of pillarPositions) {
        const px = leftEdge + buildingWidth * pos;
        addPlatform(px - 6, floorY - ceilingH + wallThickness, 12, ceilingH - wallThickness);
    }
    
    // Seating area (low platforms)
    addPlatform(leftEdge + buildingWidth * 0.55, floorY - 10, 40, 5);
    addPlatform(leftEdge + buildingWidth * 0.7, floorY - 10, 40, 5);
}

/**
 * Generate pool area
 */
function generatePoolArea(platforms, config, floor, floorY, ceilingH, addPlatform, leftEdge, buildingWidth) {
    // Pool area at the back
    const poolX = leftEdge + buildingWidth * 0.65;
    const poolW = 100;
    
    // Pool deck (raised edge around pool)
    addPlatform(poolX - 10, floorY - 6, poolW + 20, 4);
    
    // Pool surface (lower - players can jump in)
    addPlatform(poolX, floorY - 2, poolW, 2);
}

/**
 * Generate bar area
 */
function generateBarArea(platforms, config, floor, floorY, addPlatform, leftEdge, buildingWidth) {
    // Bar counter
    addPlatform(leftEdge + buildingWidth * 0.2, floorY - 22, 70, 12);
    
    // Bar stools
    for (let i = 0; i < 4; i++) {
        addPlatform(leftEdge + buildingWidth * 0.21 + i * 16, floorY - 8, 10, 4);
    }
}

/**
 * Generate restaurant area
 */
function generateRestaurantArea(platforms, config, floor, floorY, addPlatform, leftEdge, buildingWidth) {
    // Restaurant tables
    for (let i = 0; i < 3; i++) {
        addPlatform(leftEdge + buildingWidth * 0.78 + i * 45, floorY - 16, 28, 6);
    }
}

/**
 * Generate staircase connecting two floors
 */
function generateStaircase(platforms, config, floor, floorY, aboveY, ceilingH, addPlatform, isOccupied) {
    const { leftEdge, buildingWidth, stairStepWidth, stairStepHeight } = getConfig(config);
    
    // Stairwell at the right side of the building
    const stairX = leftEdge + buildingWidth - 160;
    const stairwellW = 140;
    
    // Vertical gap between floors
    const gap = floorY - aboveY;
    const totalRise = gap;
    const stepsNeeded = Math.ceil(totalRise / stairStepHeight);
    const actualStepH = totalRise / stepsNeeded;
    
    // Create a zigzag staircase with a landing midway
    
    // First flight (going up-right)
    const stepsPerFlight = Math.ceil(stepsNeeded / 2);
    for (let step = 0; step < stepsPerFlight; step++) {
        const sx = stairX + step * stairStepWidth;
        const sy = (floorY - gap) + step * actualStepH;
        addPlatform(sx, sy, stairStepWidth, actualStepH);
    }
    
    // Mid-landing
    const landingY = (floorY - gap) + stepsPerFlight * actualStepH;
    const landingW = stairStepWidth * stepsPerFlight + 20;
    addPlatform(stairX, landingY, landingW, actualStepH);
    
    // Second flight (going up-left back toward building)
    for (let step = 0; step < stepsPerFlight; step++) {
        const sx = stairX + (stepsPerFlight - 1 - step) * stairStepWidth;
        const sy = landingY - (step + 1) * actualStepH;
        addPlatform(sx, sy, stairStepWidth, actualStepH);
    }
    
    // Stairwell back wall
    addPlatform(stairX - 10, floorY - ceilingH + config.wallThickness, 8, ceilingH - config.wallThickness);
}

/**
 * Generate roof elements
 */
function generateRoof(platforms, config, addPlatform) {
    const { leftEdge, worldY, buildingWidth, floorHeight, floorCount, floorThickness, wallThickness } = getConfig(config);
    
    const topFloorY = worldY;
    
    // Roof surface (top floor ceiling becomes the roof)
    addPlatform(leftEdge, topFloorY - floorHeight, buildingWidth, floorThickness);
    
    // Rooftop railings
    addPlatform(leftEdge - 4, topFloorY - floorHeight - 24, 4, 24);
    addPlatform(leftEdge + buildingWidth, topFloorY - floorHeight - 24, 4, 24);
}

/**
 * Generate exterior features (balconies)
 */
function generateExterior(platforms, config, addPlatform) {
    const { leftEdge, worldY, buildingWidth, floorCount, floorHeight } = getConfig(config);
    
    for (let floor = 1; floor < floorCount; floor++) {
        if (floor % 2 === 0) continue;
        
        const floorY = worldY + (floorCount - 1 - floor) * floorHeight;
        
        for (let b = 0; b < 3; b++) {
            const bx = leftEdge + (buildingWidth / 4) * (b + 1) - 20;
            addPlatform(bx - 20, floorY - 8, 40, 4);
        }
    }
}

// ============================================================
// HELPERS
// ============================================================

function getConfig(config) {
    return {
        leftEdge: config.worldX - config.buildingWidth / 2,
        ...config
    };
}

/**
 * Generate a small hotel variant
 */
function generateSmallHotel(overrides = {}) {
    return generateHotel({
        buildingWidth: 800,
        floorCount: 3,
        floorHeight: 240,
        roomWidth: 120,
        hallwayWidth: 80,
        worldY: 200,
        ...overrides
    });
}

/**
 * Generate a large luxury hotel
 */
function generateLuxuryHotel(overrides = {}) {
    return generateHotel({
        buildingWidth: 2000,
        floorCount: 8,
        floorHeight: 300,
        roomWidth: 180,
        hallwayWidth: 140,
        worldY: 50,
        ...overrides
    });
}

module.exports = {
    generateHotel,
    generateSmallHotel,
    generateLuxuryHotel,
    HOTEL_CONFIG
};