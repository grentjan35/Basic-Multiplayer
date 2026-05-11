---
title: Basic Multiplayer Platformer
sdk: docker
app_file: server.js
disable_embedding: false
---

# Basic Multiplayer Platformer

A lightweight multiplayer platformer game with server-authoritative physics.

## How to Play

- Use **Arrow Keys** or **WASD** to move
- **Space** or **Up Arrow** to jump
- Multiple players can join and interact with each other

## Features

- Real-time multiplayer gameplay
- Server-authoritative physics
- Smooth interpolation
- Large world with platforms
- Player-to-player collisions

## Technical Details

- **Server**: Node.js with WebSocket
- **Client**: HTML5 Canvas with vanilla JavaScript
- **Physics**: Custom collision detection and response
- **Network**: 30 tick rate with client-side interpolation

## Embedding

**Direct URL (no Hugging Face UI):**
```
https://grentjan35-basic-multiplayer.hf.space/
```

**For embedding on your website:**
```html
<iframe src="https://grentjan35-basic-multiplayer.hf.space/"
        style="width:100%; height:100vh; border:none;"
        sandbox="allow-scripts allow-same-origin">
</iframe>
```

*Note: Docker SDK Spaces serve the game directly without the /iframe endpoint.*
