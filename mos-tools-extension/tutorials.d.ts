export interface TutorialContext {
  authenticated: boolean;
  features: string[];
  current: string | null;
  scope: string;
}
export interface TutorialController {
  open(): void;
  sync(): void;
  reset(): void;
  destroy(): void;
}
export function createTutorials(options: {
  surface: "web" | "extension";
  request(method: "GET" | "PUT", body?: { action: string; guide?: string; expectedPersonId: string }): Promise<unknown>;
  getContext(): TutorialContext;
}): TutorialController;
export const guides: Array<{id: string; title: string; duration: string; features: string[]; prerequisite: string; steps: string[][]}>;
export function validPayload(payload: unknown): boolean;
