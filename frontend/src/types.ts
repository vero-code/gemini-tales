// frontend/src/types.ts
export interface StoryScene {
  text: string;
  imageUrl: string | null;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  unlocked: boolean;
}

export const AppState = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  STORYTELLING: 'STORYTELLING',
  WAITING_FOR_ACTION: 'WAITING_FOR_ACTION',
  ERROR: 'ERROR'
} as const;

export type AppState = typeof AppState[keyof typeof AppState];
