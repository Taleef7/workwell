/** Leave the app for another URL (an OAuth client's redirect). A function so tests can observe it. */
export function leaveTo(url: string): void {
  window.location.assign(url);
}
