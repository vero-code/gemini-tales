import React, { useState, useRef } from 'react';
import { Send, Loader2, Search, Scale, PenTool } from 'lucide-react';
import clsx from 'clsx';

const Hero = ({ onGenerated }) => {
  const [topic, setTopic] = useState('');
  const [isBuilding, setIsBuilding] = useState(false);
  const [statusText, setStatusText] = useState('Initializing AI squad...');
  const [activeStep, setActiveStep] = useState(null); // 'researcher', 'judge', 'builder'
  const [error, setError] = useState(null);

  const sessionIdRef = useRef('session-' + Math.random().toString(36).substring(2, 15));

  const updateStatus = (text) => {
    setStatusText(text);
    const lowerText = text.toLowerCase();
    if (lowerText.includes('research') || lowerText.includes('scout')) {
      setActiveStep('researcher');
    } else if (lowerText.includes('judge') || lowerText.includes('evaluating') || lowerText.includes('guardian')) {
      setActiveStep('judge');
    } else if (lowerText.includes('writ') || lowerText.includes('build') || lowerText.includes('storysmith')) {
      setActiveStep('builder');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!topic.trim()) return;

    setIsBuilding(true);
    setError(null);

    try {
      const response = await fetch('/api/chat_stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `Create a comprehensive course on: ${topic}`,
          session_id: sessionIdRef.current
        })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.type === 'progress') {
              updateStatus(data.text);
            } else if (data.type === 'result') {
              onGenerated(data.text, data.rendered_content);
              return;
            }
          } catch (e) {
            console.error('Error parsing JSON:', e, line);
          }
        }
      }
    } catch (err) {
      console.error('Error:', err);
      setError('Something went wrong. Please try again.');
      setIsBuilding(false);
    }
  };

  return (
    <div className="max-w-4xl w-full flex flex-col items-center text-center space-y-12">
      <div className="space-y-4">
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-white">
          Magical world where <span className="text-transparent bg-clip-text magical-gradient">stories come to life!</span>
        </h1>
        <p className="text-slate-400 text-lg max-w-2xl mx-auto">
          Gemini Tales uses advanced AI to watch, listen, and tell stories. Ensure your child is in a safe space for physical movement.
        </p>
      </div>

      {!isBuilding ? (
        <form onSubmit={handleSubmit} className="w-full max-w-2xl relative group">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            disabled={isBuilding}
            placeholder="Which tale would you like to bring to life?"
            className="w-full h-16 bg-white/5 border border-white/10 rounded-2xl px-6 pr-40 text-lg text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all glass"
          />
          <button
            type="submit"
            disabled={!topic.trim() || isBuilding}
            className="absolute right-2 top-2 h-12 px-6 bg-white text-black font-semibold rounded-xl hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
          >
            <span>Begin Your Story</span>
            <Send size={18} />
          </button>
          
          {error && <p className="mt-4 text-rose-500">{error}</p>}
        </form>
      ) : (
        <div className="w-full max-w-2xl glass p-8 rounded-3xl space-y-8 animate-in fade-in zoom-in duration-500">
          <div className="flex items-center gap-4 justify-center">
            <div className="p-3 bg-white/5 rounded-full">
              <Loader2 className="animate-spin text-magical-400" size={32} />
            </div>
            <div className="text-left">
              <p className="text-sm font-medium text-slate-500 uppercase tracking-widest">Current Status</p>
              <h3 className="text-xl font-semibold text-white">{statusText}</h3>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <Step 
              icon={<Search size={24} />} 
              label="Scouting" 
              active={activeStep === 'researcher'} 
              completed={activeStep === 'judge' || activeStep === 'builder'}
            />
            <Step 
              icon={<Scale size={24} />} 
              label="Evaluating" 
              active={activeStep === 'judge'} 
              completed={activeStep === 'builder'}
            />
            <Step 
              icon={<PenTool size={24} />} 
              label="Writing" 
              active={activeStep === 'builder'} 
              completed={false}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const Step = ({ icon, label, active, completed }) => (
  <div className={clsx(
    "flex flex-col items-center gap-3 p-4 rounded-2xl transition-all duration-500",
    active ? "bg-white/10 text-white scale-105" : "text-slate-500 opacity-50",
    completed && "text-magical-400 opacity-100"
  )}>
    <div className={clsx(
      "w-12 h-12 flex items-center justify-center rounded-xl",
      active ? "bg-magical-500 text-white shadow-[0_0_20px_rgba(14,165,233,0.3)]" : "bg-white/5",
      completed && "bg-magical-400/20"
    )}>
      {icon}
    </div>
    <span className="text-sm font-semibold">{label}</span>
  </div>
);

export default Hero;
