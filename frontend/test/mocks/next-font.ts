// Vitest mock for next/font/* — fonts return a stable className and variable string
const makeFont = () => () => ({ className: "mock-font", variable: "--mock-font" });

export const Fraunces = makeFont();
export const Geist = makeFont();
export const Geist_Mono = makeFont();
export const GeistMono = Geist_Mono; // keep old name as alias
export const Inter = makeFont();

// Default export satisfies next/font/local's localFont(...) call signature
export default () => ({ className: "mock-font", variable: "--mock-font" });
