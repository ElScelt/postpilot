export type ResearchSource = {
  title: string;
  url: string;
  publishedDate: string;
  primary: boolean;
  credible?: boolean;
};

export type Draft = {
  text: string;
  topic: string;
  sources: ResearchSource[];
  theme?: string;
};

// What the validator compares a draft against. Everything is optional so the policy can
// still judge a draft on its own, but the run supplies all of it.
export type DraftContext = {
  recentPosts?: string[];
  recentThemes?: string[];
  // Raw evidence text (titles, excerpts, URLs, dates). Every number in the draft must
  // appear here; the alternative is a threshold recycled from last night's post.
  evidence?: string[];
};
