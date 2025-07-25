'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';

interface BreamvisionProps {
  wsUrl?: string; // Default: ws://localhost:8080
  initialUrl?: string;
}

interface EvaluateResult {
  type: 'evaluate';
  status: 'success' | 'error';
  result?: any;
  error?: string;
}

export function Breamvision({ wsUrl = 'ws://localhost:8080', initialUrl = 'https://example.com' }: BreamvisionProps) {
  const [url, setUrl] = useState(initialUrl);
  const [isConnected, setIsConnected] = useState(false);
  const [jsCode, setJsCode] = useState('');
  const [evaluateResult, setEvaluateResult] = useState<EvaluateResult | null>(null);
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

        // Connect to Breamvision WebSocket with auth token
        const ws = new WebSocket(`${wsUrl}?token=${token}`);
        
        ws.onopen = () => {
          console.log('Connected to Breamvision');
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
          } else if (message.type === 'navigation') {
            console.log('Navigation result:', message);
          } else if (message.type === 'evaluate') {
            setEvaluateResult(message);
            console.log('Evaluate result:', message);
          }
        };

        ws.onclose = () => {
          console.log('Disconnected from Breamvision');
          setIsConnected(false);
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
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
  }, [wsUrl, getToken]); // Removed initialUrl from dependencies

  // Separate effect for initial navigation
  useEffect(() => {
    if (isConnected && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // Add a small delay to ensure browser is ready
      const timer = setTimeout(() => {
        wsRef.current?.send(JSON.stringify({
          type: 'navigate',
          url: initialUrl
        }));
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, [isConnected, initialUrl]); // Navigate when connected or URL changes

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

  const handleEvaluate = (e: React.FormEvent) => {
    e.preventDefault();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && jsCode.trim()) {
      wsRef.current.send(JSON.stringify({
        type: 'evaluate',
        code: jsCode
      }));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <form onSubmit={handleNavigate} className="flex gap-2 flex-1">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Enter URL"
            className="flex-1 px-3 py-2 border rounded"
          />
          <button 
            type="submit" 
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            disabled={!isConnected}
          >
            Navigate
          </button>
        </form>
        <span className={`text-sm ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
          {isConnected ? '● Connected' : '● Disconnected'}
        </span>
      </div>
      
      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        onClick={handleCanvasClick}
        onWheel={handleCanvasScroll}
        className="w-full h-auto bg-black rounded cursor-pointer"
        style={{ maxHeight: '720px' }}
      />
      
      {/* JavaScript Evaluation Section */}
      <div className="border-t pt-4">
        <h3 className="text-lg font-semibold mb-2">Execute JavaScript</h3>
        <form onSubmit={handleEvaluate} className="flex flex-col gap-2">
          <textarea
            value={jsCode}
            onChange={(e) => setJsCode(e.target.value)}
            placeholder="// Enter JavaScript code to run on the page&#10;// Example: document.body.style.backgroundColor = 'red'"
            className="w-full h-32 px-3 py-2 border rounded font-mono text-sm"
            disabled={!isConnected}
          />
          <button
            type="submit"
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:bg-gray-400"
            disabled={!isConnected || !jsCode.trim()}
          >
            Execute Code
          </button>
        </form>
        
        {evaluateResult && (
          <div className={`mt-2 p-3 rounded ${evaluateResult.status === 'success' ? 'bg-green-100' : 'bg-red-100'}`}>
            <p className="font-semibold">{evaluateResult.status === 'success' ? 'Success' : 'Error'}</p>
            {evaluateResult.status === 'success' ? (
              <pre className="text-sm mt-1">{JSON.stringify(evaluateResult.result, null, 2)}</pre>
            ) : (
              <p className="text-sm mt-1 text-red-600">{evaluateResult.error}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Example usage with security warning
export function BreamvisionWithWarning(props: BreamvisionProps) {
  return (
    <div>
      <div className="bg-yellow-100 border border-yellow-400 text-yellow-700 px-4 py-3 rounded mb-4">
        <strong>Security Warning:</strong> JavaScript evaluation allows arbitrary code execution on the remote page. 
        Only use with trusted sources and sanitized input.
      </div>
      <Breamvision {...props} />
    </div>
  );
}