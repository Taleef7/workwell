// Vitest mock for next/font/* — fonts return a stable className and variable string
const makeFont = () => () => ({ className: "mock-font", variable: "--mock-font" });

export const Fraunces = makeFont();
export const Geist = makeFont();
export const GeistMono = makeFont();
export const Inter = makeFont();
