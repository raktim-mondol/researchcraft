/**
 * ResearchCraft product branding — single source of truth for UI strings.
 * White-label ResearchCraft build (fork of open-source K-Dense BYOK, MIT).
 */
export const BRAND = {
  name: "ResearchCraft",
  /** Short product label used in tooltips and version chips */
  product: "ResearchCraft",
  /** Agent display name in chat / notebook lanes */
  agent: "ResearchCraft",
  agentLead: "ResearchCraft (lead)",
  tagline: "AI research assistant for scientists",
  description:
    "Bring-your-own-key AI research assistant. All API calls use keys from your .env file and run on your machine.",
  siteUrl: "https://researchcraft.dev",
  logoSrc: "/brand/researchcraft-logo.svg",
  markSrc: "/brand/researchcraft-mark.svg",
  /** Composer placeholder */
  askPlaceholder: "Ask ResearchCraft anything… (@ for files, + for data / compute / skills)",
  askButton: "Ask ResearchCraft",
  askAboutDoc: "Ask ResearchCraft about this document in chat",
  companyLine: "ResearchCraft",
  notebookEmpty: "ResearchCraft’s notebook — entries appear here as it works.",
} as const;
