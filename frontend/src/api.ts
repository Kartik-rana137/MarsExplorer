// Thin client for the backend API. The frontend holds no mission data or planning logic of its own.
import type { Conditions, Escape, History, Params, PhotoResult, Plan, Site, StopInput } from "./types";

const BASE: string = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BASE + path, init);
  } catch {
    throw new ApiError("Cannot reach the planning backend. Is it running on port 8001?");
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* keep the status text */
    }
    throw new ApiError(detail);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** Resolve a backend-relative URL (map overlays) against the API base. */
export const backendUrl = (path: string): string => BASE + path;

export const api = {
  site: () => request<Site>("/api/site"),
  conditions: (sol: number) => request<Conditions>(`/api/conditions?sol=${sol}`),
  history: () => request<History>("/api/conditions/history"),
  plan: (camp: { lat: number; lon: number }, stops: StopInput[], params: Params, sol: number, signal?: AbortSignal) =>
    post<Plan>("/api/plan", { camp, stops, params, sol }, signal),
  escape: (camp: { lat: number; lon: number }, position: { lat: number; lon: number }, params: Params, signal?: AbortSignal) =>
    post<Escape>("/api/escape", { camp, position, params }, signal),
  photos: (lat: number, lon: number) => request<PhotoResult>(`/api/photos?lat=${lat}&lon=${lon}`),
  /** Raw bytes, for the packed elevation grid. */
  binary: async (path: string): Promise<ArrayBuffer> => {
    let response: Response;
    try {
      response = await fetch(BASE + path);
    } catch {
      throw new ApiError("Cannot reach the planning backend.");
    }
    if (!response.ok) throw new ApiError(`${response.status} ${response.statusText}`);
    return response.arrayBuffer();
  },
};
