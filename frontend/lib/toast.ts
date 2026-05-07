export function emitToast(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("workwell:toast", { detail: { message } }));
}
