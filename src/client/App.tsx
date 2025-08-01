import React, { useState, useRef, useEffect } from 'react';
import { useAuth, SignIn, SignedIn, SignedOut } from '@clerk/clerk-react';
import './App.css';

const App: React.FC = () => {
  const [url, setUrl] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { getToken } = useAuth();

  useEffect(() => {
    const connectWebSocket = async () => {
      try {
        // Get auth token from Clerk
        const token = await getToken();
        if (!token) {
          console.error('No auth token available');
          return;
        }
        
        // Determine WebSocket URL based on current location
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname;
        // For production, don't specify port - let it use default 443 for wss
        const wsUrl = host === 'localhost' 
          ? 'ws://localhost:8080' 
          : `${protocol}//${host}`;
        
        // Include token in WebSocket connection
        const ws = new WebSocket(`${wsUrl}?token=${token}`);
    
    ws.onopen = () => {
      console.log('Connected to Breamer server');
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      if (message.type === 'frame' && canvasRef.current) {
        const img = new Image();
        img.onload = () => {
          const ctx = canvasRef.current?.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, canvasRef.current!.width, canvasRef.current!.height);
          }
        };
        img.src = `data:image/jpeg;base64,${message.data}`;
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from Breamer server');
      setIsConnected(false);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setIsConnected(false);
    };

    wsRef.current = ws;
      } catch (error) {
        console.error('Failed to connect:', error);
      }
    };
    
    connectWebSocket();
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [getToken]);

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'navigate',
        url: url
      }));
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (1280 / rect.width);
      const y = (e.clientY - rect.top) * (1280 / rect.height);
      
      wsRef.current.send(JSON.stringify({
        type: 'click',
        x,
        y
      }));
    }
  };

  const handleCanvasScroll = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'scroll',
        deltaY: e.deltaY
      }));
    }
  };

  return (
    <div className="app">
      <SignedOut>
        <div className="auth-container">
          <SignIn />
        </div>
      </SignedOut>
      <SignedIn>
      <header className="header">
        <div className="branding">
          <h1>BreamerVision™</h1>
          <span className={`status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '● Connected' : '● Disconnected'}
          </span>
        </div>
        <form onSubmit={handleNavigate} className="address-bar">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Enter URL (e.g., google.com)"
            className="url-input"
          />
          <button type="submit" className="go-button">Go</button>
        </form>
      </header>
      <main className="viewport">
        <canvas
          ref={canvasRef}
          width={1280}
          height={1280}
          onClick={handleCanvasClick}
          onWheel={handleCanvasScroll}
          className="stream-canvas"
        />
      </main>
      </SignedIn>
    </div>
  );
};

export default App;