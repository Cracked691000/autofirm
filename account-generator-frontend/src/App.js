import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Loader, Wifi, WifiOff, Zap, SkipForward, Clock, Target, CheckCircle } from 'lucide-react';

export default function AccountGeneratorApp() {
  const [inviteUrl, setInviteUrl] = useState('https://act.playcfl.com/act/a20251031rlr/index.html?code=agsaqik');
  const [accountCount, setAccountCount] = useState(2);
  const [isRunning, setIsRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  
  // AI Solver settings
  const [useAiSolver, setUseAiSolver] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  
  // Progress tracking
  const [successfulAccounts, setSuccessfulAccounts] = useState(0);
  const [totalAttempts, setTotalAttempts] = useState(0);
  const [startTime, setStartTime] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [estimatedTimeLeft, setEstimatedTimeLeft] = useState(null);
  const [isCompleted, setIsCompleted] = useState(false);
  
  // Captcha queue
  const [captchaQueue, setCaptchaQueue] = useState([]);
  const [currentCaptcha, setCurrentCaptcha] = useState(null);
  const currentCaptchaRef = useRef(null);

  const wsRef = useRef(null);
  const backendUrl = 'http://localhost:3001';
  const wsUrl = 'ws://localhost:3001';

  const gridCoordinates = {
    1: { x: 60, y: 190 }, 2: { x: 180, y: 190 }, 3: { x: 300, y: 190 },
    4: { x: 60, y: 290 }, 5: { x: 180, y: 290 }, 6: { x: 300, y: 290 }
  };

  useEffect(() => {
    currentCaptchaRef.current = currentCaptcha;
  }, [currentCaptcha]);

  // Timer effect
  useEffect(() => {
    let interval;
    if (isRunning && startTime) {
      interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        setElapsedTime(elapsed);
        
        // Calculate estimated time remaining
        if (successfulAccounts > 0 && successfulAccounts < accountCount) {
          const avgTimePerAccount = elapsed / successfulAccounts;
          const remaining = Math.ceil(avgTimePerAccount * (accountCount - successfulAccounts));
          setEstimatedTimeLeft(remaining);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRunning, startTime, successfulAccounts, accountCount]);

  // Format time as MM:SS
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Process captcha queue
  useEffect(() => {
    if (!currentCaptcha && captchaQueue.length > 0) {
      const [next, ...rest] = captchaQueue;
      setCurrentCaptcha(next);
      setCaptchaQueue(rest);
    }
  }, [captchaQueue, currentCaptcha]);

  const connectWebSocket = useCallback(() => {
    try {
      const ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        setConnected(true);
        console.log('WebSocket connected');
      };
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'progress') {
          setSuccessfulAccounts(data.successful);
          setTotalAttempts(data.attempts);
        } else if (data.type === 'captcha') {
          const captchaItem = {
            image: data.image,
            threadId: data.threadId,
            timestamp: data.timestamp || Date.now()
          };

          const activeCaptcha = currentCaptchaRef.current;
          if (activeCaptcha && activeCaptcha.threadId === data.threadId) {
            setCurrentCaptcha(captchaItem);
          } else {
            setCaptchaQueue(prev => {
              const filtered = prev.filter(c => c.threadId !== data.threadId);
              return [...filtered, captchaItem];
            });
          }
        }
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setConnected(false);
      };
      
      ws.onclose = () => {
        console.log('WebSocket closed');
        setConnected(false);
        setTimeout(() => {
          if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
            connectWebSocket();
          }
        }, 5000);
      };
      
      wsRef.current = ws;
    } catch (error) {
      console.error('WebSocket connection error:', error);
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [connectWebSocket]);

  const handleCaptchaSelect = (position) => {
    if (!currentCaptcha) return;
    const coords = gridCoordinates[position];
    
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'captcha_click',
        x: coords.x, y: coords.y, position,
        threadId: currentCaptcha.threadId
      }));
      
      setCurrentCaptcha(null);
    }
  };

  const handleSkipCaptcha = () => {
    if (!currentCaptcha) return;
    
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'skip_captcha',
        threadId: currentCaptcha.threadId
      }));
      
      setCurrentCaptcha(null);
    }
  };

  const startGeneration = async () => {
    if (isRunning || !connected) return;
    
    setIsRunning(true);
    setIsCompleted(false);
    setSuccessfulAccounts(0);
    setTotalAttempts(0);
    setStartTime(Date.now());
    setElapsedTime(0);
    setEstimatedTimeLeft(null);
    
    try {
      const response = await fetch(`${backendUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: inviteUrl,
          accountCount: accountCount,
          useAi: useAiSolver,
          geminiApiKey: useAiSolver ? geminiApiKey : undefined
        })
      });
      
      if (!response.ok) throw new Error('Backend request failed');
      
      setIsCompleted(true);
      
    } catch (error) {
      console.error(error);
    } finally {
      setIsRunning(false);
    }
  };

  const progressPercentage = accountCount > 0 ? (successfulAccounts / accountCount) * 100 : 0;

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '40px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        
        {/* Main Card */}
        <div style={{ backgroundColor: '#ffffff', borderRadius: '16px', boxShadow: '0 10px 25px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
          
          {/* Header */}
          <div style={{ padding: '24px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ fontSize: '24px', fontWeight: '800', color: '#111827', margin: 0 }}>
                Crossfire <span style={{color:'#3b82f6'}}>Account Generator</span>
              </h1>
              <p style={{ color: '#6b7280', fontSize: '13px', marginTop: '4px' }}>Automated Account Creator</p>
            </div>
            <div style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: connected ? '#dcfce7' : '#fee2e2', color: connected ? '#166534' : '#991b1b', fontSize: '12px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
              {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
              {connected ? 'Online' : 'Offline'}
            </div>
          </div>

          {/* Controls Area */}
          <div style={{ padding: '24px' }}>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#9ca3af', marginBottom: '6px', letterSpacing: '0.5px' }}>Target Link</label>
              <input 
                type="text" 
                value={inviteUrl} 
                onChange={(e) => setInviteUrl(e.target.value)} 
                disabled={isRunning}
                style={{ width: '100%', padding: '12px', backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', outline: 'none', color: '#374151', boxSizing: 'border-box' }} 
              />
            </div>

            <div style={{ marginBottom: '25px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#9ca3af', marginBottom: '6px', letterSpacing: '0.5px' }}>Target Accounts</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input 
                  type="number" 
                  value={accountCount} 
                  onChange={(e) => setAccountCount(parseInt(e.target.value) || 1)} 
                  disabled={isRunning}
                  style={{ width: '80px', padding: '12px', backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', fontWeight: '600', textAlign: 'center', outline: 'none', boxSizing: 'border-box' }} 
                />
                <div style={{ fontSize: '13px', color: '#6b7280' }}>successful accounts using <strong style={{color:'#000'}}>10 threads</strong></div>
              </div>
            </div>

            {/* AI Solver Section */}
            <div style={{ 
              marginBottom: '20px', 
              padding: '16px', 
              backgroundColor: '#f9fafb', 
              borderRadius: '12px', 
              border: '1px solid #e5e7eb' 
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: useAiSolver && showApiKeyInput ? '12px' : '0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Zap size={16} color="#f59e0b" fill="#fef3c7" />
                  <span style={{ fontSize: '14px', fontWeight: '600', color: '#374151' }}>
                    AI Captcha Solver
                  </span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: '#f59e0b', backgroundColor: '#fef3c7', padding: '2px 6px', borderRadius: '4px' }}>
                    BETA
                  </span>
                </div>
                <label style={{ position: 'relative', display: 'inline-block', width: '50px', height: '26px', cursor: isRunning ? 'not-allowed' : 'pointer' }}>
                  <input 
                    type="checkbox" 
                    checked={useAiSolver} 
                    onChange={(e) => {
                      setUseAiSolver(e.target.checked);
                      if (e.target.checked) {
                        setShowApiKeyInput(true);
                      } else {
                        setShowApiKeyInput(false);
                      }
                    }}
                    disabled={isRunning}
                    style={{ opacity: 0, width: 0, height: 0 }}
                  />
                  <span style={{ 
                    position: 'absolute', 
                    cursor: isRunning ? 'not-allowed' : 'pointer',
                    top: 0, left: 0, right: 0, bottom: 0,
                    backgroundColor: useAiSolver ? '#3b82f6' : '#d1d5db',
                    borderRadius: '26px',
                    transition: '0.3s'
                  }}>
                    <span style={{
                      position: 'absolute',
                      content: '',
                      height: '20px',
                      width: '20px',
                      left: useAiSolver ? '27px' : '3px',
                      bottom: '3px',
                      backgroundColor: 'white',
                      borderRadius: '50%',
                      transition: '0.3s'
                    }} />
                  </span>
                </label>
              </div>
              
              {useAiSolver && showApiKeyInput && (
                <div style={{ animation: 'fadeIn 0.3s ease-in' }}>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '6px' }}>
                    Gemini API Key
                  </label>
                  <input 
                    type="password" 
                    value={geminiApiKey} 
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    disabled={isRunning}
                    placeholder="Enter your Gemini API key..."
                    style={{ 
                      width: '100%', 
                      padding: '10px 12px', 
                      backgroundColor: '#ffffff', 
                      border: '1px solid #e5e7eb', 
                      borderRadius: '6px', 
                      fontSize: '13px', 
                      outline: 'none',
                      boxSizing: 'border-box',
                      fontFamily: 'monospace'
                    }} 
                  />
                  <div style={{ marginTop: '8px', fontSize: '11px', color: '#6b7280', lineHeight: '1.4' }}>
                    Get your free API key at{' '}
                    <a 
                      href="https://aistudio.google.com/app/apikey" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{ color: '#3b82f6', textDecoration: 'none', fontWeight: '600' }}
                    >
                      Google AI Studio
                    </a>
                  </div>
                </div>
              )}
              
              {!useAiSolver && (
                <p style={{ fontSize: '12px', color: '#6b7280', margin: '8px 0 0 0', lineHeight: '1.4' }}>
                  Enable to automatically solve captchas using Google's Gemini AI (requires API key)
                </p>
              )}
            </div>

            {/* Progress Section - Show when running OR completed */}
            {(isRunning || isCompleted) && (
              <div style={{ 
                marginBottom: '20px', 
                padding: '16px', 
                backgroundColor: isCompleted ? '#f0fdf4' : '#f9fafb', 
                borderRadius: '12px', 
                border: isCompleted ? '1px solid #86efac' : '1px solid #e5e7eb' 
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {isCompleted ? <CheckCircle size={18} color="#16a34a" /> : <Target size={18} color="#3b82f6" />}
                    <span style={{ fontSize: '14px', fontWeight: '600', color: '#374151' }}>
                      {successfulAccounts} / {accountCount} Accounts
                    </span>
                  </div>
                  <span style={{ fontSize: '14px', fontWeight: '600', color: isCompleted ? '#16a34a' : '#6b7280' }}>
                    {progressPercentage.toFixed(0)}%
                  </span>
                </div>
                
                {/* Progress Bar */}
                <div style={{ width: '100%', height: '8px', backgroundColor: '#e5e7eb', borderRadius: '4px', overflow: 'hidden', marginBottom: '12px' }}>
                  <div style={{ 
                    width: `${progressPercentage}%`, 
                    height: '100%', 
                    backgroundColor: isCompleted ? '#16a34a' : '#3b82f6',
                    transition: 'width 0.3s ease'
                  }} />
                </div>
                
                {/* Time Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', fontSize: '12px' }}>
                  <div>
                    <div style={{ color: '#9ca3af', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Clock size={12} /> {isCompleted ? 'Total Time' : 'Elapsed'}
                    </div>
                    <div style={{ fontWeight: '700', color: '#111827', fontSize: '16px' }}>
                      {formatTime(elapsedTime)}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: '#9ca3af', marginBottom: '4px' }}>
                      {isCompleted ? 'Avg/Account' : 'Remaining'}
                    </div>
                    <div style={{ fontWeight: '700', color: '#111827', fontSize: '16px' }}>
                      {isCompleted && successfulAccounts > 0 
                        ? formatTime(Math.floor(elapsedTime / successfulAccounts))
                        : estimatedTimeLeft 
                        ? formatTime(estimatedTimeLeft) 
                        : '--:--'}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: '#9ca3af', marginBottom: '4px' }}>Attempts</div>
                    <div style={{ fontWeight: '700', color: '#111827', fontSize: '16px' }}>
                      {totalAttempts}
                    </div>
                  </div>
                </div>
                
                {isCompleted && (
                  <div style={{ 
                    marginTop: '12px', 
                    padding: '8px 12px', 
                    backgroundColor: '#dcfce7', 
                    borderRadius: '6px', 
                    textAlign: 'center',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#166534'
                  }}>
                    ✓ Generation Complete!
                  </div>
                )}
              </div>
            )}

            <button 
              onClick={startGeneration} 
              disabled={isRunning || !connected || (useAiSolver && !geminiApiKey)}
              style={{ 
                width: '100%', padding: '16px', borderRadius: '10px', border: 'none', 
                background: isRunning ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' : '#111827', 
                color: '#ffffff', fontWeight: '600', fontSize: '16px', cursor: (isRunning || !connected || (useAiSolver && !geminiApiKey)) ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)', opacity: (!connected || (useAiSolver && !geminiApiKey)) ? 0.7 : 1
              }}
            >
              {isRunning ? <Loader className="rotating" size={20} /> : <Play size={20} />}
              {isRunning ? 'Processing...' : (useAiSolver && !geminiApiKey) ? 'API Key Required' : 'Start Automation'}
            </button>
          </div>
        </div>

        {/* Captcha Modal Popup */}
        {currentCaptcha && (
          <div style={{ 
            position: 'fixed', 
            top: 0, 
            left: 0, 
            right: 0, 
            bottom: 0, 
            backgroundColor: 'rgba(0, 0, 0, 0.75)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            zIndex: 9999,
            padding: '20px'
          }}>
            <div style={{ 
              backgroundColor: '#ffffff', 
              borderRadius: '16px', 
              padding: '24px', 
              maxWidth: '600px', 
              width: '100%',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
              animation: 'slideUp 0.3s ease-out'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Zap size={16} fill="#3b82f6" strokeWidth={0} />
                  <span style={{ fontSize: '14px', fontWeight: '700', color: '#374151' }}>
                    Solve Captcha (Thread {currentCaptcha.threadId})
                  </span>
                </div>
                {captchaQueue.length > 0 && (
                  <span style={{ fontSize: '12px', fontWeight: '600', color: '#6b7280', backgroundColor: '#e5e7eb', padding: '2px 8px', borderRadius: '4px' }}>
                    +{captchaQueue.length} queued
                  </span>
                )}
              </div>
              
              <p style={{ textAlign: 'center', fontSize: '12px', color: '#6b7280', margin: '0 0 10px 0', fontWeight: '600' }}>
                Click directly on the matching image
              </p>
              
              {/* Captcha Image with Clickable Grid Overlay */}
              <div style={{ position: 'relative', borderRadius: '8px', overflow: 'hidden', border: '2px solid #e5e7eb', marginBottom: '12px' }}>
                <img key={currentCaptcha.timestamp} src={currentCaptcha.image} style={{ width: '100%', display: 'block' }} alt="Captcha" />
                
                {/* Clickable Grid Overlay */}
                <div style={{ 
                  position: 'absolute', 
                  top: '25%', 
                  left: '0', 
                  width: '100%', 
                  height: '62%',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gridTemplateRows: 'repeat(2, 1fr)',
                  gap: '2px',
                  padding: '0'
                }}>
                  {[1, 2, 3, 4, 5, 6].map(num => (
                    <button
                      key={num}
                      onClick={() => handleCaptchaSelect(num)}
                      style={{
                        backgroundColor: 'transparent',
                        border: '3px solid transparent',
                        borderRadius: '0',
                        cursor: 'pointer',
                        fontSize: '36px',
                        fontWeight: '900',
                        color: '#ffffff',
                        textShadow: '0 0 12px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.9), 3px 3px 6px rgba(0,0,0,0.8), -1px -1px 4px rgba(0,0,0,0.7)',
                        transition: 'all 0.15s ease',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        WebkitTextStroke: '1px rgba(0,0,0,0.5)'
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.backgroundColor = 'transparent';
                        e.target.style.borderColor = 'transparent';
                      }}
                    >
                      
                    </button>
                  ))}
                </div>
              </div>
              
              <button 
                onClick={handleSkipCaptcha}
                style={{ 
                  width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '6px', 
                  backgroundColor: '#ffffff', color: '#6b7280', fontSize: '13px', fontWeight: '600',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
                }}
              >
                <SkipForward size={14} />
                Skip & Continue
              </button>
            </div>
          </div>
        )}

      </div>
      <style>{`
        .rotating { animation: rotate 1s linear infinite; } 
        @keyframes rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } } 
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(50px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
      `}</style>
    </div>
  );
}