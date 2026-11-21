import type { AccessService } from "./access-service";

// The app's computer-access service, set once at start (main.ts); null in tests that do not use it.
let service: AccessService | null = null;

export function useAccess(s: AccessService | null): void {
  service = s;
}

export function accessService(): AccessService | null {
  return service;
}
