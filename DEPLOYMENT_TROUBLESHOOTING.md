# GitHub to Hugging Face Spaces Deployment Blueprint

This document outlines the complete deployment process from GitHub to Hugging Face Spaces, including all common errors and their solutions.

## Prerequisites

1. **Hugging Face Space Created**: Create your Space at https://huggingface.co/spaces
2. **GitHub Repository**: Your project must be in a GitHub repository
3. **Hugging Face Access Token**: Generate a token with write permissions at https://huggingface.co/settings/tokens

## Required GitHub Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions and add:

- `HF_SPACE_ID`: `your-username/your-space-name` (e.g., `Grentjan35/Basic-Multiplayer`)
- `HF_TOKEN`: Your Hugging Face access token with write permissions

## Project Requirements

### Dockerfile
Your project must have a Dockerfile that:
- Uses an appropriate base image (Node.js for JavaScript projects)
- Exposes port 7860 (required by Hugging Face Spaces)
- Has proper CMD instruction

Example for Node.js project:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 7860
CMD ["npm", "start"]
```

### Server Configuration
- Your server must listen on port 7860
- Example: `server.listen(7860, () => { ... })`

## GitHub Actions Workflow

Create `.github/workflows/deploy-huggingface.yml`:

```yaml
name: Deploy to Hugging Face Spaces

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      HF_SPACE_ID: ${{ secrets.HF_SPACE_ID }}
      HF_TOKEN: ${{ secrets.HF_TOKEN }}
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Clone Hugging Face Space
        run: |
          git clone https://huggingface.co/spaces/${HF_SPACE_ID} huggingface-space

      - name: Copy files to Space
        run: |
          rsync -av --exclude='huggingface-space' --exclude='.git' . huggingface-space/
          cd huggingface-space
          git add .
          git config --global user.email "action@github.com"
          git config --global user.name "GitHub Action"
          git commit -m "Deploy from GitHub Actions"

      - name: Push to Hugging Face Space
        run: |
          cd huggingface-space
          git push https://user:${HF_TOKEN}@huggingface.co/spaces/${HF_SPACE_ID} main
```

## Common Errors and Solutions

### Error 1: `Option '--token' requires an argument`
**Problem**: Using `hf auth login --token` incorrectly
**Solution**: Use `hf auth login` without `--token` flag when piping token via stdin

### Error 2: `invalid tag: repository name must be lowercase`
**Problem**: Docker tags must be lowercase, but space ID contains uppercase
**Solution**: Use lowercase Docker tag or avoid Docker-specific commands

### Error 3: `No such command 'docker'`
**Problem**: Hugging Face CLI doesn't have a `docker` command
**Solution**: Use Git-based deployment instead of Docker commands

### Error 4: `cannot copy a directory, '.', into itself`
**Problem**: Trying to copy directory into itself when including cloned space
**Solution**: Use `rsync` with exclusions or copy specific files only

### Error 5: `could not read Username for 'https://huggingface.co'`
**Problem**: Git authentication not properly configured
**Solution**: Include token in URL: `https://user:${HF_TOKEN}@huggingface.co/...`

### Error 6: `User is already logged in`
**Problem**: Hugging Face CLI detects existing login
**Solution**: This is a warning, not an error. Deployment can continue.

### Error 7: `WebSocket connection to 'wss://localhost:7860/' failed`
**Problem**: Client hardcoded to connect to localhost even on Hugging Face
**Solution**: Use dynamic host detection:
```javascript
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsHost = window.location.host;
const wsUrl = `${wsProtocol}//${wsHost}`;
```

### Error 8: Game shows "Players: 0" and no map on Hugging Face
**Problem**: WebSocket connection failing due to hostname mismatch
**Symptoms**: 
- Console shows `WebSocket connection to 'wss://localhost:7860/' failed`
- Page loads but no game elements appear
- Player count stays at 0
**Solution**: Implement dynamic WebSocket connection that uses current domain

### Error 9: `ERR_BLOCKED_BY_CLIENT` errors in console
**Problem**: AWS WAF or ad blocker interference
**Solution**: These errors are unrelated to your game and can be ignored. They come from browser extensions blocking AWS WAF telemetry.

### Error 10: WebSocket connects but immediately disconnects
**Problem**: Missing CORS headers or server configuration issues
**Solution**: Add CORS headers to server:
```javascript
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
```

### Error 11: Connection works locally but fails on Hugging Face
**Problem**: Protocol mismatch (HTTP vs HTTPS)
**Solution**: Use protocol detection for WebSocket:
```javascript
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
```

## Deployment Process

1. **Local Development**:
   ```bash
   # Make changes to your project
   # Test locally
   npm start
   ```

2. **Commit and Push to GitHub**:
   ```bash
   git add .
   git commit -m "Your commit message"
   git push origin main
   ```

3. **Automatic Deployment**:
   - GitHub Action triggers automatically on push to main
   - Action clones your Hugging Face Space
   - Copies project files (excluding .git and space directory)
   - Commits and pushes to Hugging Face
   - Hugging Face automatically builds and deploys

4. **Monitor Deployment**:
   - Check GitHub Actions tab for deployment status
   - Check your Hugging Face Space for build logs
   - Your app will be available at `https://your-username-your-space-name.huggingface.co`

## Best Practices

1. **Always test locally** before pushing
2. **Keep Dockerfile simple** and specific to your project
3. **Exclude unnecessary files** from deployment (.git, node_modules, etc.)
4. **Use specific Node.js version** in Dockerfile for consistency
5. **Monitor build logs** on both GitHub and Hugging Face
6. **Keep secrets secure** - never commit tokens to repository

## Troubleshooting Checklist

### General Deployment
- [ ] GitHub secrets are correctly set
- [ ] Dockerfile exists and exposes port 7860
- [ ] Server listens on port 7860
- [ ] Workflow file is in correct location (.github/workflows/)
- [ ] All required files are committed to repository
- [ ] Hugging Face token has write permissions
- [ ] Space ID format is correct (username/space-name)

### WebSocket Connection Issues
- [ ] Client uses dynamic host detection (`window.location.host`)
- [ ] Protocol detection implemented (WS vs WSS)
- [ ] Server has CORS headers enabled
- [ ] WebSocket server attached to HTTP server
- [ ] Connection timeout and retry logic implemented
- [ ] Error handling shows detailed connection status

## Quick Reference Commands

```bash
# Generate Hugging Face token
# Visit: https://huggingface.co/settings/tokens

# Set GitHub secrets (in GitHub UI)
# HF_SPACE_ID=username/space-name
# HF_TOKEN=your-token-here

# Deploy workflow
git add .
git commit -m "Deploy to Hugging Face"
git push origin main
```

This blueprint should help you avoid all the common pitfalls when deploying from GitHub to Hugging Face Spaces.
