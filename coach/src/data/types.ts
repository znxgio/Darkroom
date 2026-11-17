import type { CritiqueResult } from '../../supabase/functions/_shared/critique';

export type Source = 'import' | 'live';

/** Camera info we keep (no GPS / location, ever). */
export interface Exif {
  make?: string;
  model?: string;
  lens?: string;
  focalLength35?: number;
  iso?: number;
  shutter?: string; // e.g. "1/60"
  aperture?: number;
  flash?: boolean;
}

export interface Photo {
  id: string;
  created_at: string;
  taken_at: string | null;
  source: Source;
  thumb: string; // data URL
  width: number | null;
  height: number | null;
  exif: Exif | null;
  live_score: number | null;
  note: string | null;
}

export interface Critique {
  id: string;
  photo_id: string;
  created_at: string;
  model: string;
  score: number;
  result: CritiqueResult;
  tags: string[];
  cost_usd: number;
}

export interface PhotoWithCritiques extends Photo {
  critiques: Critique[]; // newest first
}

export interface Overlays {
  grid: boolean;
  level: boolean;
  center: boolean;
}

export interface Settings {
  live_coaching: boolean;
  ai_critique: boolean;
  editing_tips: boolean;
  monthly_cap_usd: number;
  depth: 'quick' | 'thorough';
  overlays: Overlays;
}

export const DEFAULT_SETTINGS: Settings = {
  live_coaching: true,
  ai_critique: true,
  editing_tips: true,
  monthly_cap_usd: 5,
  depth: 'quick',
  overlays: { grid: true, level: true, center: false },
};

export interface Spend {
  month_usd: number;
  all_usd: number;
  count_month: number;
  cap_usd: number;
}

export interface NewPhoto {
  source: Source;
  thumb: string;
  width: number;
  height: number;
  exif: Exif | null;
  taken_at: string | null;
  live_score: number | null;
  note: string | null;
}

export class CritiqueError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly spend?: { spent: number; cap: number },
  ) {
    super(message);
  }
}

export interface Repo {
  mode: 'cloud' | 'demo';
  listPhotos(): Promise<PhotoWithCritiques[]>;
  addPhoto(p: NewPhoto): Promise<Photo>;
  deletePhoto(id: string): Promise<void>;
  /** image: base64 JPEG (no prefix) sized for the AI. Throws CritiqueError. */
  critique(photoId: string, image: string): Promise<{ critique: Critique; spend: { spent: number; cap: number } }>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  spend(): Promise<Spend>;
}
