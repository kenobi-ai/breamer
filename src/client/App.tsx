import React, { useState, useRef, useEffect } from 'react';
import './App.css';

const App: React.FC = () => {
  const [url, setUrl] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Determine WebSocket URL based on current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const wsUrl = host === 'localhost' ? 'ws://localhost:8080' : `${protocol}//${host}:${port}`;
    
    const ws = new WebSocket(wsUrl);
    
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

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, []);

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
      const y = (e.clientY - rect.top) * (720 / rect.height);
      
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
          height={720}
          onClick={handleCanvasClick}
          onWheel={handleCanvasScroll}
          className="stream-canvas"
        />
      </main>
    </div>
  );
};

export default App;