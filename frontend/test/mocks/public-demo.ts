import { ROLES, normRole } from "@/lib/rbac";

export let PUBLIC_DEMO = false;

export function setPublicDemo(value: boolean) {
  PUBLIC_DEMO = value;
}

export function setPilotMode(isPilot: boolean) {
  PUBLIC_DEMO = !isPilot;
}

export function isPilotMode(): boolean {
  return !PUBLIC_DEMO;
}

export function canSeeEngineering(role?: string | null): boolean {
  return !isPilotMode() || normRole(role) === ROLES.ADMIN;
}

const mock = {
  get PUBLIC_DEMO() {
    return PUBLIC_DEMO;
  },
  isPilotMode,
  canSeeEngineering,
  setPublicDemo,
  setPilotMode,
};

export default mock;
