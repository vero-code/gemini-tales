import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, List, MessageSquare } from 'lucide-react';
import { marked } from 'marked';
import clsx from 'clsx';
import LiveNarrator from './LiveNarrator';

const StoryViewer = ({ data, rendered, onBack }) => {
  const [toc, setToc] = useState([]);
  const [activeHeading, setActiveHeading] = useState(null);
  const [showLive, setShowLive] = useState(false);
  const contentRef = useRef(null);
  const googleSearchRef = useRef(null);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.innerHTML = marked.parse(data || '');
      
      // Generate TOC
      const headings = contentRef.current.querySelectorAll('h2');
      const tocItems = Array.from(headings).map((h, i) => {
        const id = `section-${i}`;
        h.id = id;
        return { id, text: h.textContent };
      });
      setToc(tocItems);

      // Scroll to top
      window.scrollTo(0, 0);
    }
  }, [data]);

  useEffect(() => {
    if (rendered && googleSearchRef.current && !googleSearchRef.current.shadowRoot) {
      const shadow = googleSearchRef.current.attachShadow({ mode: 'open' });
      const styleFix = `
        <style>
          .container { 
              display: flex !important;
              flex-direction: column !important;
              align-items: flex-start !important;
              gap: 12px !important;
              height: auto !important;
              padding: 16px !important;
              font-family: sans-serif;
              color: white;
          }
          .headline {
              display: flex !important;
              align-items: center !important;
              width: 100% !important;
              gap: 8px !important;
              font-size: 14px !important;
              color: #94a3b8 !important;
          }
          .carousel { 
              display: flex !important;
              flex-wrap: wrap !important;
              white-space: normal !important; 
              overflow: visible !important; 
              gap: 8px !important;
          }
          .chip { 
              margin: 0 !important; 
              display: inline-block !important;
              padding: 6px 16px !important;
              border: 1px solid rgba(255,255,255,0.1) !important;
              border-radius: 20px !important;
              font-size: 14px !important;
              color: white !important;
              background: rgba(255,255,255,0.05) !important;
              cursor: pointer !important;
              transition: all 0.2s !important;
          }
          .chip:hover {
              background: rgba(255,255,255,0.1) !important;
              border-color: rgba(255,255,255,0.2) !important;
          }
        </style>
      `;
      shadow.innerHTML = styleFix + rendered;
    }
  }, [rendered]);

  const scrollToHeading = (id) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
      setActiveHeading(id);
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto flex flex-col md:flex-row gap-8 animate-in slide-in-from-bottom-4 duration-700">
      {/* Sidebar */}
      <aside className="w-full md:w-64 flex-shrink-0 space-y-6">
        <button 
          onClick={onBack}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors py-2"
        >
          <ArrowLeft size={18} />
          <span>New Story</span>
        </button>

        <div className="glass p-6 rounded-2xl sticky top-8">
          <div className="flex items-center gap-2 mb-4 text-magical-400">
            <List size={20} />
            <h3 className="font-bold uppercase tracking-widest text-xs">Table of Contents</h3>
          </div>
          <nav className="space-y-1">
            {toc.map((item) => (
              <button
                key={item.id}
                onClick={() => scrollToHeading(item.id)}
                className={clsx(
                  "w-full text-left px-3 py-2 rounded-lg text-sm transition-all",
                  activeHeading === item.id 
                    ? "bg-magical-500/20 text-magical-300 font-medium" 
                    : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                )}
              >
                {item.text}
              </button>
            ))}
          </nav>

          <div className="mt-8 pt-6 border-t border-white/10">
            <button 
              onClick={() => setShowLive(true)}
              className="w-full py-3 bg-magical-600 hover:bg-magical-500 text-white rounded-xl font-semibold flex items-center justify-center gap-2 shadow-lg shadow-magical-600/20 transition-all active:scale-95 group"
            >
              <MessageSquare size={20} className="group-hover:animate-pulse" />
              <span>Talk to Gemini</span>
            </button>
            <p className="mt-3 text-[10px] text-slate-500 text-center uppercase tracking-tighter">
              Start voice narration adventure
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-grow glass p-8 md:p-12 rounded-3xl min-h-[80vh]">
        <article 
          ref={contentRef}
          className="prose prose-invert prose-magical max-w-none"
        >
          {/* Markdown rendered here */}
        </article>

        {rendered && (
          <div className="mt-12 pt-8 border-t border-white/10">
            <div ref={googleSearchRef}></div>
          </div>
        )}
      </main>

      {showLive && (
        <LiveNarrator 
          storyContext={data} 
          onClose={() => setShowLive(false)} 
        />
      )}

      <style>{`
        .prose-magical h1 { @apply text-4xl font-bold mb-8 text-white; }
        .prose-magical h2 { @apply text-2xl font-bold mt-12 mb-6 text-magical-300 border-b border-white/5 pb-2; }
        .prose-magical p { @apply text-slate-300 leading-relaxed mb-6 text-lg; }
        .prose-magical ul { @apply list-disc list-inside space-y-2 mb-6 text-slate-400; }
        .prose-magical strong { @apply text-white font-semibold; }
      `}</style>
    </div>
  );
};

export default StoryViewer;
