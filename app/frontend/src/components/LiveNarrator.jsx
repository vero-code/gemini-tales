import React, { useState, useEffect } from 'react';
import { Mic, MicOff, X, Volume2 } from 'lucide-react';
import { useGeminiLive } from '../hooks/useGeminiLive';
import clsx from 'clsx';

const LiveNarrator = ({ storyContext, onClose }) => {
  const { isConnected, isStreaming, error, connect, disconnect } = useGeminiLive({
    systemInstruction: `You are a magical storyteller. The story context is: ${storyContext}. Interact with the child, ask them to move and play along with the story. Keep it engaging and safe.`,
  });

  const [transcription, setTranscription] = useState("");

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="w-full max-w-lg glass rounded-3xl p-8 space-y-8 relative overflow-hidden">
        {/* Animated Background Effect */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-64 bg-magical-500/20 blur-[80px] -z-10 rounded-full animate-pulse" />

        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className={clsx(
              "w-3 h-3 rounded-full",
              isConnected ? "bg-emerald-500 animate-pulse" : "bg-slate-600"
            )} />
            <h2 className="text-xl font-bold text-white tracking-tight">Live Narrator</h2>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition-all"
          >
            <X size={24} />
          </button>
        </div>

        <div className="flex flex-col items-center justify-center space-y-6 py-8">
          <div className={clsx(
            "w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 overflow-hidden relative",
            isStreaming ? "bg-magical-600 shadow-[0_0_40px_rgba(14,165,233,0.4)]" : "bg-white/5"
          )}>
            {isStreaming ? (
              <div className="flex items-center gap-1">
                {[...Array(5)].map((_, i) => (
                  <div 
                    key={i} 
                    className="w-1.5 h-8 bg-white rounded-full animate-bounce" 
                    style={{ animationDelay: `${i * 0.1}s`, height: `${10 + Math.random() * 30}px` }} 
                  />
                ))}
              </div>
            ) : (
              <MicOff size={48} className="text-slate-600" />
            )}
          </div>
          
          <div className="text-center space-y-2">
            <p className="text-magical-300 font-medium">
              {isConnected ? "Listening for your voice..." : "Connecting to Gemini..."}
            </p>
            <p className="text-slate-500 text-sm max-w-xs">
              Gemini is ready to tell the story and listen to your reactions.
            </p>
          </div>
        </div>

        {error && (
          <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl text-rose-400 text-sm text-center">
            {error}
          </div>
        )}

        <div className="flex items-center justify-center gap-4 pt-4">
           {/* Add a Volume control or other live indicators here if needed */}
           <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-widest font-bold">
              <Volume2 size={16} />
              <span>Crystal Clear Audio</span>
           </div>
        </div>
      </div>
    </div>
  );
};

export default LiveNarrator;
