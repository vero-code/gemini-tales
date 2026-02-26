import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import type { AppState, Achievement } from './types';
import { GeminiLiveAPI } from './utils/geminilive';
import { AudioStreamer, VideoStreamer, AudioPlayer } from './utils/mediaUtils';

// --- ENV VARIABLES ---
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID;
const PROXY_URL = import.meta.env.VITE_PROXY_URL;
const MODEL_ID = import.meta.env.VITE_MODEL_ID;
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
if (!PROJECT_ID || !PROXY_URL || !MODEL_ID || !GEMINI_API_KEY) {
  throw new Error('Missing required environment variables');
}

const INITIAL_ACHIEVEMENTS: Achievement[] = [
  { id: 'bunny_hop', title: 'Hop-Skip', description: 'Hopped around like a real bunny', icon: '🐰', unlocked: false },
  { id: 'wizard_wave', title: 'Young Wizard', description: 'Waved your hands like a magician', icon: '🪄', unlocked: false },
  { id: 'curious_explorer', title: 'Little Inquirer', description: 'Asked an interesting question about the story', icon: '❓', unlocked: false },
  { id: 'graceful_leaf', title: 'Little Leaf', description: 'Twirled around like an autumn leaf', icon: '🍃', unlocked: false },
  { id: 'story_lover', title: 'Good Listener', description: 'Listened to the first chapter until the end', icon: '📖', unlocked: false },
];

const SYSTEM_INSTRUCTION = `
You are Gemini Tales, a magical and interactive storyteller. 
Your goal is to tell an enchanting story and reward the child for participation.
INTERACTION RULES:
1. INTERRUPTIONS: If the child interrupts, stop the story immediately, answer them warmly, and ask to continue.
2. CHOICES: Call the 'showChoice' function with 2-3 options.
3. MOVEMENT: Ask the child to perform actions (jump, spin). Use the camera to verify.
4. REWARDS: If they succeed, call 'awardBadge'.
5. VISUALS: Call 'generateIllustration' for every new major scene.
`;

const customTools = {
    functionDeclarations: [
        { name: 'generateIllustration', description: 'Generates a watercolor style illustration.', parameters: { type: 'OBJECT', properties: { prompt: { type: 'STRING' } }, required: ['prompt'] } },
        { name: 'awardBadge', description: 'Awards a virtual badge.', parameters: { type: 'OBJECT', properties: { badgeId: { type: 'STRING' } }, required: ['badgeId'] } },
        { name: 'showChoice', description: 'Displays multiple-choice buttons.', parameters: { type: 'OBJECT', properties: { options: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['options'] } }
    ]
};

const App: React.FC = () => {
  // --- STORY STATE ---
  const [appState, setAppState] = useState<AppState | 'IDLE' | 'STARTING' | 'STORYTELLING' | 'ERROR'>('IDLE');
  const [currentIllustration, setCurrentIllustration] = useState<string | null>(null);
  const [aiTranscription, setAiTranscription] = useState('');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [achievements, setAchievements] = useState<Achievement[]>(INITIAL_ACHIEVEMENTS);
  const [lastAwarded, setLastAwarded] = useState<Achievement | null>(null);
  const [storyChoices, setStoryChoices] = useState<string[]>([]);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  // --- DEV PANEL STATE ---
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState('');
  const [selectedCamera, setSelectedCamera] = useState('');
  const [isAudioOn, setIsAudioOn] = useState(false);
  const [isVideoOn, setIsVideoOn] = useState(false);
  const [chatMessages, setChatMessages] = useState<{sender: string, text: string, type: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [debugInfo, setDebugInfo] = useState('Application initialized...\n');

  // --- REFS ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  
  const liveClientRef = useRef<GeminiLiveAPI | null>(null);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const videoStreamerRef = useRef<VideoStreamer | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);

  // --- INIT DEVICES ---
  useEffect(() => {
    async function getDevices() {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter(d => d.kind === 'audioinput'));
        setCameras(devices.filter(d => d.kind === 'videoinput'));
      } catch (err) {
        logDebug("Device access error: " + err);
      }
    }
    getDevices();
    return () => disconnect();
  }, []);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // --- UTILS ---
  const logDebug = (msg: string) => setDebugInfo(prev => `${msg}\n${prev}`.slice(0, 1500));
  
  const appendChat = (sender: string, text: string, type: string) => {
    setChatMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.sender === sender && type === 'transcript') {
        const newArr = [...prev];
        newArr[newArr.length - 1].text += text;
        return newArr;
      }
      return [...prev, { sender, text, type }];
    });
  };

  const generateNewIllustration = async (prompt: string) => {
    if (!GEMINI_API_KEY) { logDebug("API Key missing for image gen."); return; }
    logDebug(`Generating image: ${prompt}`);
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `Magical watercolor illustration for children's story: ${prompt}` }] },
      });
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          setCurrentIllustration(`data:image/png;base64,${part.inlineData.data}`);
          logDebug("Image generated successfully.");
          break;
        }
      }
    } catch (err) { logDebug("Image gen failed: " + err); }
  };

  const handleAwardBadge = (badgeId: string) => {
    logDebug(`Awarding badge: ${badgeId}`);
    setAchievements(prev => {
      const achievement = prev.find(a => a.id === badgeId);
      if (achievement && !achievement.unlocked) {
        setLastAwarded(achievement);
        setTimeout(() => setLastAwarded(null), 5000);
        return prev.map(a => a.id === badgeId ? { ...a, unlocked: true } : a);
      }
      return prev;
    });
  };

  const selectChoice = (choice: string) => {
    setStoryChoices([]);
    appendChat("YOU", `I choose: ${choice}`, "text");
    liveClientRef.current?.sendClientContent([{ text: `I choose: ${choice}` }]);
  };

  const sendText = () => {
    if (!chatInput.trim() || !liveClientRef.current) return;
    appendChat("YOU", chatInput, "text");
    liveClientRef.current.sendTextMessage(chatInput);
    setChatInput('');
  };

  // --- CORE LOGIC (Split into manual steps like Google Demo) ---
  const connect = async () => {
    setAppState('STARTING');
    setConnectionStatus('Connecting...');
    logDebug("Connecting to Gemini...");

    try {
        const client = new GeminiLiveAPI(PROXY_URL, PROJECT_ID, MODEL_ID);
        liveClientRef.current = client;

        client.systemInstructions = SYSTEM_INSTRUCTION;
        client.responseModalities = ["AUDIO"];
        client.voiceName = "Kore";
        client.inputAudioTranscription = true;
        client.outputAudioTranscription = true;
        
        // Register Tools
        client.addFunction({ declaration: customTools.functionDeclarations[0], functionToCall: (p: any) => generateNewIllustration(p.prompt) });
        client.addFunction({ declaration: customTools.functionDeclarations[1], functionToCall: (p: any) => handleAwardBadge(p.badgeId) });
        client.addFunction({ declaration: customTools.functionDeclarations[2], functionToCall: (p: any) => setStoryChoices(p.options) });

        client.onReceiveResponse = (message: any) => {
            if (message.type === 'OUTPUT_TRANSCRIPTION') {
                if (!message.data.finished) {
                    setAiTranscription(prev => prev + message.data.text);
                    appendChat("GEMINI", message.data.text, "transcript");
                }
            } else if (message.type === 'INPUT_TRANSCRIPTION') {
                setIsUserSpeaking(!message.data.finished);
                if (!message.data.finished) appendChat("YOU", message.data.text, "transcript");
            } else if (message.type === 'TURN_COMPLETE') {
                setAiTranscription('');
                setIsUserSpeaking(false);
            } else if (message.type === 'INTERRUPTED') {
                setAiTranscription('(Story paused...)');
                setStoryChoices([]);
                appendChat("SYSTEM", "[Interrupted]", "system");
                audioPlayerRef.current?.interrupt();
            } else if (message.type === 'AUDIO') {
                audioPlayerRef.current?.play(message.data);
            } else if (message.type === 'SETUP_COMPLETE') {
                 setConnectionStatus('Connected');
                 setAppState('STORYTELLING');
                 appendChat("SYSTEM", "Setup Complete. Ready!", "system");
                 logDebug("Connection established.");
            }
        };

        client.onError = (err: any) => {
            logDebug("Socket Error: " + err);
            setConnectionStatus('Error');
            setAppState('ERROR');
        };

        await client.connect();

        const player = new AudioPlayer();
        await player.init();
        audioPlayerRef.current = player;

    } catch (error) {
        logDebug("Failed to connect: " + error);
        setConnectionStatus('Failed');
        setAppState('ERROR');
    }
  };

  const disconnect = () => {
    audioStreamerRef.current?.stop();
    videoStreamerRef.current?.stop();
    liveClientRef.current?.webSocket?.close();
    
    setAppState('IDLE');
    setConnectionStatus('Disconnected');
    setIsAudioOn(false);
    setIsVideoOn(false);
    setIsCameraActive(false);
    setCurrentIllustration(null);
    setStoryChoices([]);
    logDebug("Disconnected from Gemini.");
  };

  const toggleAudio = async () => {
    if (!liveClientRef.current) return logDebug("Connect first!");
    if (!isAudioOn) {
      try {
        if (!audioStreamerRef.current) audioStreamerRef.current = new AudioStreamer(liveClientRef.current);
        await audioStreamerRef.current.start(selectedMic || undefined);
        setIsAudioOn(true);
        appendChat("SYSTEM", "[Mic ON]", "system");
        logDebug("Audio streaming started.");
      } catch (err: any) { logDebug("Audio error: " + err); }
    } else {
      audioStreamerRef.current?.stop();
      setIsAudioOn(false);
      appendChat("SYSTEM", "[Mic OFF]", "system");
      logDebug("Audio streaming stopped.");
    }
  };

  const toggleVideo = async () => {
    if (!liveClientRef.current) return logDebug("Connect first!");
    if (!isVideoOn) {
      try {
        if (!videoStreamerRef.current && videoRef.current) {
            videoStreamerRef.current = new VideoStreamer(liveClientRef.current, videoRef.current);
        }
        await videoStreamerRef.current?.start({ width: 320, height: 240, fps: 1, deviceId: selectedCamera || null });
        setIsVideoOn(true);
        setIsCameraActive(true);
        appendChat("SYSTEM", "[Camera ON]", "system");
        logDebug("Video streaming started.");
      } catch (err: any) { logDebug("Video error: " + err); }
    } else {
      videoStreamerRef.current?.stop();
      setIsVideoOn(false);
      setIsCameraActive(false);
      appendChat("SYSTEM", "[Camera OFF]", "system");
      logDebug("Video streaming stopped.");
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-8 space-y-8 overflow-y-auto bg-[#faf7f2] font-sans">
      
      {/* --- ACHIEVEMENT POPUP --- */}
      {lastAwarded && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-sm animate-in fade-in duration-300">
           <div className="bg-white rounded-[40px] shadow-2xl p-10 border-8 border-yellow-400 flex flex-col items-center gap-4 animate-bounce">
            <span className="text-8xl">{lastAwarded.icon}</span>
            <div className="text-center">
              <h4 className="text-3xl font-black text-gray-800">Hooray! New badge!</h4>
              <p className="text-2xl text-purple-600 font-bold mt-2">{lastAwarded.title}</p>
            </div>
          </div>
        </div>
      )}

      {/* --- HEADER --- */}
      <header className="text-center z-10 w-full max-w-7xl">
        <h1 className="text-5xl md:text-7xl font-bold bg-gradient-to-r from-purple-600 to-pink-500 bg-clip-text text-transparent">Gemini Tales</h1>
        <p className="text-xl text-gray-500 mt-2 font-medium italic">A magical world where stories come to life!</p>
      </header>

      {/* --- MAIN STORY EXPERIENCE (Beautiful UI) --- */}
      <main className="w-full max-w-7xl flex flex-col lg:flex-row gap-8 z-10">
        <div className="flex-1 flex flex-col gap-6">
          <div className="glass-card rounded-[40px] overflow-hidden flex-1 shadow-xl flex flex-col relative min-h-[400px] bg-white/60 border border-white/50 backdrop-blur-md">
            <div className="flex-1 bg-white/20 flex items-center justify-center relative">
              {currentIllustration ? (
                <img src={currentIllustration} className="w-full h-full object-cover animate-in fade-in duration-1000" alt="Story Scene" />
              ) : (
                <div className="text-center p-12 space-y-6">
                  {appState === 'IDLE' ? (
                    <div className="text-gray-400 font-medium">Connect and start media below to begin the magic.</div>
                  ) : (
                    <div className="flex flex-col items-center gap-6">
                      <div className="w-20 h-20 border-8 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                      <p className="text-purple-600 text-xl font-black">Story is active...</p>
                    </div>
                  )}
                </div>
              )}

              {storyChoices.length > 0 && (
                <div className="absolute inset-0 z-20 flex items-center justify-center p-12 bg-black/30 backdrop-blur-[2px]">
                   <div className="flex flex-col md:flex-row gap-6 w-full max-w-3xl">
                      {storyChoices.map((choice, i) => (
                        <button key={i} onClick={() => selectChoice(choice)} className="flex-1 bg-white/95 hover:bg-yellow-400 hover:scale-105 active:scale-95 transition-all p-8 rounded-3xl shadow-2xl border-4 border-purple-400 text-xl font-black text-purple-900">
                          {choice}
                        </button>
                      ))}
                   </div>
                </div>
              )}
            </div>
            <div className="bg-white/95 p-8 border-t border-white/50 backdrop-blur-xl">
              <p className="text-purple-950 text-2xl font-medium leading-relaxed italic text-center">
                {aiTranscription || (appState === 'STORYTELLING' ? "..." : "Your story awaits")}
              </p>
            </div>
          </div>
        </div>

        <div className="w-full lg:w-96 flex flex-col gap-6">
          <div className={`glass-card rounded-[40px] overflow-hidden aspect-square relative shadow-xl bg-indigo-950 border-4 transition-all duration-500 ${isUserSpeaking ? 'border-pink-400 scale-[1.02]' : 'border-white/20'}`}>
            <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full object-cover transform -scale-x-100 transition-opacity duration-1000 ${isCameraActive ? 'opacity-80' : 'opacity-0'}`} />
            {!isCameraActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white/20">
                <span className="text-6xl mb-4">📷</span>
                <span className="font-black text-xs uppercase tracking-tighter">Camera Off</span>
              </div>
            )}
            <div className="absolute bottom-6 left-6 bg-black/60 px-4 py-2 rounded-full flex items-center gap-3 backdrop-blur-md">
               <div className={`w-3 h-3 rounded-full ${isCameraActive ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
               <span className="text-white text-[12px] font-black tracking-widest uppercase">{isUserSpeaking ? "User Speaking" : "AI Storytelling"}</span>
            </div>
          </div>

          <div className="glass-card rounded-[40px] p-6 flex-1 shadow-inner bg-white/60 overflow-y-auto max-h-[300px] border border-white/50 backdrop-blur-md">
            <h3 className="text-lg font-black text-purple-800 mb-4 flex items-center gap-2"><span className="text-2xl">🏺</span> Achievements</h3>
            <div className="grid grid-cols-2 gap-3">
              {achievements.map(ach => (
                <div key={ach.id} className={`p-3 rounded-2xl border-2 transition-all flex flex-col items-center text-center ${ach.unlocked ? 'bg-white border-yellow-300 shadow-md' : 'bg-gray-200/40 border-transparent grayscale opacity-40'}`}>
                  <span className="text-4xl mb-1">{ach.icon}</span>
                  <span className="text-[10px] font-black text-gray-800 uppercase tracking-tighter leading-tight">{ach.title}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {/* --- DEVELOPER CONTROL CENTER (The Google UI you requested) --- */}
      <section className="w-full max-w-7xl bg-white/80 backdrop-blur-xl border-2 border-purple-100 shadow-2xl rounded-[40px] p-8 z-10 flex flex-col lg:flex-row gap-8">
        
        {/* Connection & Media Settings */}
        <div className="flex-1 flex flex-col gap-6">
            <div>
                <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">🔌 Connection & Media</h3>
                <div className="flex gap-3 mb-4">
                    <button onClick={connect} disabled={connectionStatus === 'Connected'} className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed">Connect API</button>
                    <button onClick={disconnect} disabled={connectionStatus !== 'Connected'} className="bg-red-100 text-red-600 hover:bg-red-200 px-6 py-2 rounded-xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed">Disconnect</button>
                </div>
                <div className="text-sm font-medium text-gray-600">
                    Status: <span className={connectionStatus === 'Connected' ? 'text-green-600 font-bold' : 'text-purple-600 font-bold'}>{connectionStatus}</span>
                </div>
            </div>

            <div className="space-y-4 bg-gray-50/50 p-4 rounded-2xl border border-gray-100">
                <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Microphone</label>
                    <select className="w-full border border-gray-200 rounded-lg p-2 bg-white text-sm" value={selectedMic} onChange={e => setSelectedMic(e.target.value)}>
                        <option value="">Default Microphone</option>
                        {mics.map(m => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Camera</label>
                    <select className="w-full border border-gray-200 rounded-lg p-2 bg-white text-sm" value={selectedCamera} onChange={e => setSelectedCamera(e.target.value)}>
                        <option value="">Default Camera</option>
                        {cameras.map(c => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
                    </select>
                </div>
                <div className="flex gap-3 pt-2">
                    <button onClick={toggleAudio} className={`flex-1 py-2 rounded-lg font-bold text-sm transition-all ${isAudioOn ? 'bg-green-100 text-green-700 border border-green-300' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                        {isAudioOn ? 'Stop Audio' : 'Start Audio'}
                    </button>
                    <button onClick={toggleVideo} className={`flex-1 py-2 rounded-lg font-bold text-sm transition-all ${isVideoOn ? 'bg-green-100 text-green-700 border border-green-300' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                        {isVideoOn ? 'Stop Video' : 'Start Video'}
                    </button>
                </div>
            </div>
            
            <button onClick={() => liveClientRef.current?.sendClientContent([{ text: "Start the magical fairy tale and ask me for my name!" }])} 
                    className="w-full bg-gradient-to-r from-yellow-400 to-orange-400 text-white py-3 rounded-xl font-black shadow-md hover:scale-[1.02] transition-transform">
                Start Fairy Tale (Send Prompt)
            </button>
        </div>

        {/* Chat & Debug */}
        <div className="flex-1 flex flex-col gap-4">
            <div>
                <h3 className="text-lg font-bold text-gray-800 mb-2 flex items-center gap-2">💬 Chat Logs</h3>
                <div ref={chatContainerRef} className="border border-gray-200 bg-white rounded-xl h-[180px] overflow-y-auto p-4 space-y-2 shadow-inner text-sm">
                    {chatMessages.length === 0 && <div className="text-gray-400 italic">Connect to Gemini to start chatting...</div>}
                    {chatMessages.map((msg, i) => (
                        <div key={i} className="leading-tight">
                            <span className={`font-black text-[10px] px-2 py-0.5 mr-2 rounded text-white uppercase tracking-wider ${
                                msg.sender === 'SYSTEM' ? 'bg-red-500' : msg.sender === 'GEMINI' ? 'bg-blue-500' : 'bg-green-500'
                            }`}>{msg.sender}</span>
                            <span className={msg.type === 'transcript' ? 'italic text-gray-600' : 'text-gray-800 font-medium'}>{msg.text}</span>
                        </div>
                    ))}
                </div>
                <div className="flex gap-2 mt-2">
                    <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendText()} placeholder="Type message to Gemini..." className="flex-1 border border-gray-200 rounded-lg p-2 text-sm outline-none focus:border-purple-400" />
                    <button onClick={sendText} className="bg-gray-800 text-white px-4 rounded-lg text-sm font-bold hover:bg-gray-700 transition-colors">Send</button>
                </div>
            </div>

            <div>
                <h3 className="text-lg font-bold text-gray-800 mb-2 flex items-center gap-2">🐛 Debug Console</h3>
                <pre className="border border-gray-200 bg-gray-900 text-green-400 rounded-xl h-[120px] overflow-y-auto p-4 text-[11px] font-mono shadow-inner whitespace-pre-wrap">
                    {debugInfo}
                </pre>
            </div>
        </div>
      </section>

    </div>
  );
};

export default App;