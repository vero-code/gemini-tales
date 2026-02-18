
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration } from '@google/genai';
import { AppState, StoryScene, Achievement } from './types';
import { encode, decode, decodeAudioData, createPcmBlob } from './services/audioUtils';

const API_KEY = process.env.API_KEY || '';

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
1. INTERRUPTIONS: If the child interrupts with a question or comment, stop the story immediately, answer them warmly in character, and then ask if they want to continue or change the story.
2. CHOICES: Every 2-3 minutes, give the child a choice to influence the story. Call the 'showChoice' function with 2-3 options (e.g., ["Go to the cave", "Follow the squirrel"]).
3. MOVEMENT: Ask the child to perform actions (jump, spin, wave). Use the camera to verify.
4. REWARDS: If they succeed or are very curious, call 'awardBadge' with the appropriate ID.
5. VISUALS: Call 'generateIllustration' for every new major scene.

Available badges: bunny_hop, wizard_wave, curious_explorer, graceful_leaf, story_lover.
`;

const generateIllustrationDeclaration: FunctionDeclaration = {
  name: 'generateIllustration',
  parameters: {
    type: Type.OBJECT,
    description: 'Generates a watercolor style illustration for the scene.',
    properties: {
      prompt: { type: Type.STRING, description: 'Prompt for the illustration in English for better image generation.' },
    },
    required: ['prompt'],
  },
};

const awardBadgeDeclaration: FunctionDeclaration = {
  name: 'awardBadge',
  parameters: {
    type: Type.OBJECT,
    description: 'Awards a virtual badge to the child.',
    properties: {
      badgeId: { type: Type.STRING, description: 'The ID of the badge.' },
    },
    required: ['badgeId'],
  },
};

const showChoiceDeclaration: FunctionDeclaration = {
  name: 'showChoice',
  parameters: {
    type: Type.OBJECT,
    description: 'Displays multiple-choice buttons to the child to decide what happens next.',
    properties: {
      options: { 
        type: Type.ARRAY, 
        items: { type: Type.STRING },
        description: 'A list of 2 or 3 story choices.' 
      },
    },
    required: ['options'],
  },
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [currentIllustration, setCurrentIllustration] = useState<string | null>(null);
  const [userTranscription, setUserTranscription] = useState('');
  const [aiTranscription, setAiTranscription] = useState('');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [achievements, setAchievements] = useState<Achievement[]>(INITIAL_ACHIEVEMENTS);
  const [lastAwarded, setLastAwarded] = useState<Achievement | null>(null);
  const [storyChoices, setStoryChoices] = useState<string[]>([]);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const frameIntervalRef = useRef<number | null>(null);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraActive(true);
      }
      return stream;
    } catch (err) {
      console.error("Camera access error:", err);
      setAppState(AppState.ERROR);
      return null;
    }
  };

  const generateNewIllustration = async (prompt: string) => {
    const ai = new GoogleGenAI({ apiKey: API_KEY });
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `Magical watercolor illustration for children's story: ${prompt}` }] },
      });
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          setCurrentIllustration(`data:image/png;base64,${part.inlineData.data}`);
          break;
        }
      }
    } catch (err) {
      console.error("Image generation failed:", err);
    }
  };

  const handleAwardBadge = (badgeId: string) => {
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
    sessionPromiseRef.current?.then(s => s.send({ text: `I choose: ${choice}` }));
  };

  const handleSessionMessage = async (message: any) => {
    // Handling transcription and interrupts
    if (message.serverContent?.outputTranscription) {
      setAiTranscription(prev => prev + message.serverContent.outputTranscription.text);
    } else if (message.serverContent?.inputTranscription) {
      setUserTranscription(prev => prev + message.serverContent.inputTranscription.text);
      setIsUserSpeaking(true);
    }

    if (message.serverContent?.turnComplete) {
      setAiTranscription('');
      setUserTranscription('');
      setIsUserSpeaking(false);
    }

    const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
    if (audioData && audioContextOutRef.current) {
      const ctx = audioContextOutRef.current;
      nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
      const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.addEventListener('ended', () => sourcesRef.current.delete(source));
      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += buffer.duration;
      sourcesRef.current.add(source);
    }

    if (message.serverContent?.interrupted) {
      sourcesRef.current.forEach(s => s.stop());
      sourcesRef.current.clear();
      nextStartTimeRef.current = 0;
      setAiTranscription('(Story paused...)');
      setStoryChoices([]);
    }

    if (message.toolCall) {
      for (const fc of message.toolCall.functionCalls) {
        if (fc.name === 'generateIllustration') {
          generateNewIllustration(fc.args.prompt);
          sessionPromiseRef.current?.then(s => s.sendToolResponse({
            functionResponses: { id: fc.id, name: fc.name, response: { result: "Done" } }
          }));
        } else if (fc.name === 'awardBadge') {
          handleAwardBadge(fc.args.badgeId);
          sessionPromiseRef.current?.then(s => s.sendToolResponse({
            functionResponses: { id: fc.id, name: fc.name, response: { result: `Awarded` } }
          }));
        } else if (fc.name === 'showChoice') {
          setStoryChoices(fc.args.options);
          sessionPromiseRef.current?.then(s => s.sendToolResponse({
            functionResponses: { id: fc.id, name: fc.name, response: { result: `Options shown` } }
          }));
        }
      }
    }
  };

  const startStory = async () => {
    setAppState(AppState.STARTING);
    const stream = await startCamera();
    if (!stream) return;

    audioContextInRef.current = new AudioContext({ sampleRate: 16000 });
    audioContextOutRef.current = new AudioContext({ sampleRate: 24000 });

    const ai = new GoogleGenAI({ apiKey: API_KEY });
    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        tools: [{ functionDeclarations: [generateIllustrationDeclaration, awardBadgeDeclaration, showChoiceDeclaration] }],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          setAppState(AppState.STORYTELLING);
          sessionPromise.then(s => s.sendClientContent({ turns: [{ text: "Start the magical fairy tale and ask the child for their name." }], turnComplete: true }));
          const source = audioContextInRef.current!.createMediaStreamSource(stream);
          const processor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (e) => {
            const blob = createPcmBlob(e.inputBuffer.getChannelData(0));
            sessionPromise.then(s => s.sendRealtimeInput({ media: blob }));
          };
          source.connect(processor);
          processor.connect(audioContextInRef.current!.destination);

          frameIntervalRef.current = window.setInterval(() => {
            if (videoRef.current && canvasRef.current) {
              const canvas = canvasRef.current;
              canvas.width = 320; canvas.height = 240;
              canvas.getContext('2d')?.drawImage(videoRef.current, 0, 0, 320, 240);
              canvas.toBlob(blob => {
                if (blob) {
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const base64 = (reader.result as string).split(',')[1];
                    sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } }));
                  };
                  reader.readAsDataURL(blob);
                }
              }, 'image/jpeg', 0.5);
            }
          }, 4000);
        },
        onmessage: handleSessionMessage,
        onclose: () => setAppState(AppState.IDLE),
      },
    });
    sessionPromiseRef.current = sessionPromise;
  };

  const stopStory = () => {
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    sessionPromiseRef.current?.then(s => s.close());
    setAppState(AppState.IDLE);
    setIsCameraActive(false);
    setCurrentIllustration(null);
    setStoryChoices([]);
    if (videoRef.current?.srcObject) (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8 space-y-8 relative overflow-hidden bg-[#faf7f2]">
      {/* Interactive Achievement Popup */}
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

      {/* Header */}
      <header className="text-center z-10">
        <h1 className="text-5xl md:text-7xl font-bold bg-gradient-to-r from-purple-600 to-pink-500 bg-clip-text text-transparent">
          Gemini Tales
        </h1>
        <p className="text-xl text-gray-500 mt-2 font-medium italic">A magical world where stories come to life!</p>
      </header>

      {/* Main Experience */}
      <main className="w-full max-w-7xl flex flex-col lg:flex-row gap-8 z-10 h-full">
        {/* Story Canvas Side */}
        <div className="flex-1 flex flex-col gap-6">
          <div className="glass-card rounded-[40px] overflow-hidden flex-1 shadow-2xl flex flex-col relative min-h-[450px]">
            <div className="flex-1 bg-white/40 flex items-center justify-center relative">
              {currentIllustration ? (
                <img src={currentIllustration} className="w-full h-full object-cover animate-in fade-in duration-1000" alt="Story Scene" />
              ) : (
                <div className="text-center p-12 space-y-6">
                  {appState === AppState.IDLE ? (
                    <div className="space-y-8">
                       <div className="w-48 h-48 bg-gradient-to-br from-purple-100 to-pink-100 rounded-full mx-auto flex items-center justify-center shadow-inner">
                          <span className="text-6xl animate-pulse">✨</span>
                       </div>
                       <button onClick={startStory} className="bg-gradient-to-br from-purple-500 to-pink-500 text-white px-16 py-6 rounded-full font-black text-3xl shadow-xl hover:scale-110 active:scale-95 transition-all">
                        Begin Your Story
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-6">
                      <div className="w-20 h-20 border-8 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                      <p className="text-purple-600 text-xl font-black">The magic begins...</p>
                    </div>
                  )}
                </div>
              )}

              {/* Story Choices Overlay */}
              {storyChoices.length > 0 && (
                <div className="absolute inset-0 z-20 flex items-center justify-center p-12 bg-black/30 backdrop-blur-[2px]">
                   <div className="flex flex-col md:flex-row gap-6 w-full max-w-3xl">
                      {storyChoices.map((choice, i) => (
                        <button 
                          key={i} 
                          onClick={() => selectChoice(choice)}
                          className="flex-1 bg-white/95 hover:bg-yellow-400 hover:scale-105 active:scale-95 transition-all p-8 rounded-3xl shadow-2xl border-4 border-purple-400 text-xl font-black text-purple-900"
                        >
                          {choice}
                        </button>
                      ))}
                   </div>
                </div>
              )}
            </div>

            {/* AI Text Display */}
            <div className="bg-white/95 p-8 border-t border-white/50 backdrop-blur-xl">
              <p className="text-purple-950 text-3xl font-medium leading-relaxed italic text-center">
                {aiTranscription || (appState === AppState.STORYTELLING ? "..." : "Your story awaits")}
              </p>
            </div>
          </div>

          {/* User Voice / Interruption Indicator */}
          <div className={`h-16 flex items-center justify-center gap-4 transition-all duration-300 ${isUserSpeaking ? 'opacity-100' : 'opacity-40 grayscale'}`}>
            <div className="flex gap-1 h-8 items-center">
              {[...Array(8)].map((_, i) => (
                <div key={i} className={`w-2 bg-pink-500 rounded-full transition-all duration-300 ${isUserSpeaking ? 'animate-bounce' : 'h-1'}`} style={{ animationDelay: `${i * 0.1}s` }}></div>
              ))}
            </div>
            <span className="text-pink-600 font-black text-sm uppercase tracking-widest">
              {isUserSpeaking ? "I'm listening!" : "You can interrupt me"}
            </span>
          </div>
        </div>

        {/* Sidebar for Interaction & Assets */}
        <div className="w-full lg:w-96 flex flex-col gap-6">
          {/* Magic Camera View */}
          <div className={`glass-card rounded-[40px] overflow-hidden aspect-square relative shadow-2xl bg-indigo-950 border-4 transition-all duration-500 ${isUserSpeaking ? 'border-pink-400 scale-[1.02]' : 'border-white/20'}`}>
            <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full object-cover transform -scale-x-100 transition-opacity duration-1000 ${isCameraActive ? 'opacity-80' : 'opacity-0'}`} />
            
            {/* Listening Ring overlay */}
            {isUserSpeaking && (
              <div className="absolute inset-0 border-[12px] border-pink-400/50 animate-pulse rounded-[40px] pointer-events-none"></div>
            )}

            {!isCameraActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white/20">
                <span className="text-6xl mb-4">📷</span>
                <span className="font-black text-xs uppercase tracking-tighter">Camera Standby</span>
              </div>
            )}
            
            <div className="absolute bottom-6 left-6 bg-black/60 px-4 py-2 rounded-full flex items-center gap-3 backdrop-blur-md">
               <div className={`w-3 h-3 rounded-full ${isCameraActive ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
               <span className="text-white text-[12px] font-black tracking-widest uppercase">
                 {isUserSpeaking ? "User Speaking" : "AI Storytelling"}
               </span>
            </div>
          </div>

          {/* Achievements Grid */}
          <div className="glass-card rounded-[40px] p-8 flex-1 shadow-inner bg-white/40 overflow-y-auto max-h-[400px] border border-white">
            <h3 className="text-xl font-black text-purple-800 mb-6 flex items-center gap-3">
              <span className="text-3xl">🏺</span> My Achievements
            </h3>
            <div className="grid grid-cols-2 gap-4">
              {achievements.map(ach => (
                <div key={ach.id} className={`group relative p-4 rounded-3xl border-2 transition-all flex flex-col items-center text-center ${ach.unlocked ? 'bg-white border-yellow-300 shadow-xl' : 'bg-gray-200/40 border-transparent grayscale opacity-30'}`}>
                  <span className={`text-5xl mb-2 transition-transform duration-500 ${ach.unlocked ? 'group-hover:rotate-12 group-hover:scale-110' : ''}`}>{ach.icon}</span>
                  <span className="text-[11px] font-black text-gray-800 uppercase tracking-tighter">{ach.title}</span>
                  {ach.unlocked && (
                    <div className="absolute top-2 right-2 bg-yellow-400 text-[10px] w-6 h-6 rounded-full flex items-center justify-center shadow-sm">
                      ✨
                    </div>
                  )}
                  {/* Detailed Description Tooltip */}
                  <div className="absolute bottom-full mb-3 hidden group-hover:block w-40 bg-purple-900 text-white text-[10px] p-3 rounded-2xl z-50 pointer-events-none shadow-2xl">
                    <p className="font-bold mb-1">{ach.title}</p>
                    {ach.description}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {appState !== AppState.IDLE && (
            <button onClick={stopStory} className="bg-red-50 text-red-500 py-6 rounded-[30px] font-black text-lg hover:bg-red-500 hover:text-white transition-all shadow-lg active:scale-95">
              Close Storybook
            </button>
          )}
        </div>
      </main>

      <footer className="text-center text-gray-500 text-[11px] py-4 max-w-4xl z-10 leading-relaxed font-medium">
        <p>Gemini Tales uses advanced AI to watch, listen, and tell stories. Ensure your child is in a safe space for physical movement. No data is stored beyond this session.</p>
      </footer>
    </div>
  );
};

export default App;
