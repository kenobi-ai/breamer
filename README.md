# Breamer - High-Fidelity Browser Streaming

Experimental browser streaming service using Puppeteer's CDP Screencast API.

## Quick Start

```bash
pnpm install
pnpm dev
```

Visit http://localhost:3000 to see the BreamerVision™ interface.

## Architecture

- **Backend**: Puppeteer with Chrome DevTools Protocol for screencasting
- **Frontend**: React with real-time canvas rendering
- **Connection**: WebSocket for low-latency frame streaming

## Features

- Real-time browser streaming with CDP Screencast API
- Interactive viewport with click and scroll support
- Simple address bar navigation
- ~80-200ms latency (local network)