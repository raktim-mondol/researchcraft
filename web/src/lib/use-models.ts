"use client";

import { useCallback, useEffect, useState } from "react";

import type { Model } from "@/components/model-selector";
import { apiFetch, onProjectChange } from "@/lib/projects";

export interface UseModelsReturn {
  /** Currently configured model (from Settings), or empty list if not set. */
  models: Model[];
  /** Always empty — Ollama catalogue discovery was removed; point LLM_BASE_URL at Ollama instead. */
  ollamaModels: Model[];
  ollamaAvailable: boolean;
  /** Re-fetch the configured model from credentials. */
  refresh: () => void;
  /** True while the first load is in flight. */
  loading: boolean;
  /** Configured base URL (for display), if any. */
  baseUrl: string;
}

/** Matches server DEFAULT_LLM_CONTEXT_WINDOW when LLM_CONTEXT_WINDOW is unset. */
export const DEFAULT_LLM_CONTEXT_WINDOW = 1_000_000;

function parseContextLength(raw: string | undefined): number {
  if (!raw) return DEFAULT_LLM_CONTEXT_WINDOW;
  const n = Number(String(raw).trim().replace(/_/g, "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LLM_CONTEXT_WINDOW;
  return Math.floor(n);
}

function toModel(
  id: string,
  baseUrl?: string,
  contextLength?: number,
  extra?: { multimodal?: boolean; priceInput?: number; priceOutput?: number },
): Model {
  return {
    id,
    label: id,
    provider: "Custom",
    tier: "flagship",
    context_length: contextLength ?? DEFAULT_LLM_CONTEXT_WINDOW,
    pricing: { prompt: extra?.priceInput ?? 0, completion: extra?.priceOutput ?? 0 },
    modality: extra?.multimodal ? "text+image->text" : "text->text",
    description: baseUrl
      ? `Configured endpoint • ${baseUrl}`
      : "Configured in Settings → API keys",
    default: true,
  };
}

/** Parse a USD-per-1M-token price from the credentials payload. */
function parsePrice(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(String(raw).trim().replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Single source of truth for the active model: whatever the user saved under
 * Settings (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_CONTEXT_WINDOW /
 * LLM_MULTIMODAL / LLM_PRICE_*).
 * No OpenRouter catalogue, no Fusion presets, no Ollama tag discovery.
 */
export function useModels(): UseModelsReturn {
  const [models, setModels] = useState<Model[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchConfig = useCallback(() => {
    apiFetch("/credentials")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, { set?: boolean; value?: string }> | null) => {
        if (!data) return;
        const modelName = (data.llmModel?.value || data.llm?.value || "").trim();
        const url = (data.llmBaseUrl?.value || "").trim();
        const ctx = parseContextLength(data.llmContextWindow?.value);
        const multimodal = (data.llmMultimodal?.value ?? "").trim().toLowerCase() === "true";
        const priceInput = parsePrice(data.llmPriceInput?.value);
        const priceOutput = parsePrice(data.llmPriceOutput?.value);
        setBaseUrl(url);
        setModels(
          modelName
            ? [toModel(modelName, url, ctx, { multimodal, priceInput, priceOutput })]
            : [],
        );
      })
      .catch(() => {
        setModels([]);
        setBaseUrl("");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => onProjectChange(() => fetchConfig()), [fetchConfig]);

  useEffect(() => {
    const bump = () => fetchConfig();
    window.addEventListener("llm-config-changed", bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener("llm-config-changed", bump);
      window.removeEventListener("storage", bump);
    };
  }, [fetchConfig]);

  return {
    models,
    ollamaModels: [],
    ollamaAvailable: false,
    refresh: fetchConfig,
    loading,
    baseUrl,
  };
}

/** Fallback used before credentials load / when nothing is configured. */
export const UNCONFIGURED_MODEL: Model = {
  id: "unconfigured",
  label: "Configure model in Settings",
  provider: "Custom",
  tier: "budget",
  context_length: 0,
  pricing: { prompt: 0, completion: 0 },
  modality: "text->text",
  description: "Open Settings → API keys and set base URL, API key, and model name.",
};
