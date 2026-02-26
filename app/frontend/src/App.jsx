import React, { useState, useEffect } from 'react';
import Hero from './components/Hero';
import StoryViewer from './components/StoryViewer';
import { Sparkles } from 'lucide-react';

function App() {
  const [currentView, setCurrentView] = useState('hero'); // 'hero' or 'story'
  const [courseData, setCourseData] = useState(null);
  const [renderedContent, setRenderedContent] = useState(null);

  useEffect(() => {
    const savedCourse = localStorage.getItem('currentCourse');
    const savedRendered = localStorage.getItem('renderedContent');
    if (savedCourse) {
      setCourseData(savedCourse);
      setRenderedContent(savedRendered);
      setCurrentView('story');
    }
  }, []);

  const handleStoryGenerated = (data, rendered) => {
    setCourseData(data);
    setRenderedContent(rendered);
    localStorage.setItem('currentCourse', data);
    localStorage.setItem('renderedContent', rendered);
    setCurrentView('story');
  };

  const handleReset = () => {
    localStorage.removeItem('currentCourse');
    localStorage.removeItem('renderedContent');
    setCourseData(null);
    setRenderedContent(null);
    setCurrentView('hero');
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-4 md:p-8">
      {currentView === 'hero' ? (
        <Hero onGenerated={handleStoryGenerated} />
      ) : (
        <StoryViewer 
          data={courseData} 
          rendered={renderedContent} 
          onBack={handleReset} 
        />
      )}
      
      <footer className="mt-auto py-6 text-slate-400 text-sm flex items-center gap-2">
        <Sparkles size={16} className="text-magical-400" />
        <span>Magical world where stories come to life!</span>
      </footer>
    </div>
  );
}

export default App;
