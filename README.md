# Server-Authoritative Multiplayer Platformer

A fully server-authoritative multiplayer platformer game with client-side interpolation.

## Features
- **Server-authoritative physics** - All movement, collision, and game logic handled server-side
- **Client interpolation** - Smooth 60ms delay buffer for responsive gameplay
- **Real-time multiplayer** - WebSocket-based communication
- **Large world** - 5000x2000 procedural platform generation
- **Player collision** - Momentum-based player-to-player interactions
- **Mini-map** - Zoomed view showing nearby players and platforms
- **Dark theme** - Minimalist dark color palette

## Controls
- Arrow Keys or WASD to move
- Space to jump
- Movement speed affects jump height

## Deployment
This project is configured for automatic deployment to Hugging Face Spaces via GitHub Actions.

### Required GitHub Secrets
- `HF_TOKEN` - Hugging Face access token
- `HF_SPACE_ID` - Space ID (format: username/space-name)

### Docker Configuration
- Node.js 18 Alpine
- Port 7860 (Hugging Face requirement)
- WebSocket server with 60 tick rate

## Development
```bash
npm install
npm start
```

Server runs on http://localhost:7860
