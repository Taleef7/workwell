import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The grid library needs a browser layout engine to be useful; what is pinned here is only the frame
// the page's layout depends on, so the library is stood in for by an element with the same escaping
// child it really renders (an absolutely positioned screen-reader link).
vi.mock("@mieweb/ui/datavis", () => ({
  DataVisNitroContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  DataVisNitroGrid: () => (
    <div className="wcdv-grid">
      <a className="sr-only" href="#t">Skip to table</a>
    </div>
  ),
}));
vi.mock("datavis-ace", () => ({ ComputedView: class {}, Source: class {} }));

import NitroGrid from "./NitroGrid";

describe("NitroGrid frame", () => {
  it("is a positioned box, so the grid's absolutely positioned pieces stay inside the page's scroll area", () => {
    // Without it, the "Skip to table" link was placed against the document, escaped <main>'s clipping and
    // gave /runs a second scrollbar into empty space. jsdom has no layout, so the frame's class is the
    // contract; verified in a browser on 2026-09-25 (document height 3,099px -> 900px, the viewport).
    render(<NitroGrid rows={[]} columns={[]} />);
    const frame = screen.getByTestId("nitro-grid-frame");
    // The style itself, not a class name a later merge could drop or override.
    expect(getComputedStyle(frame).position).toBe("relative");
    expect(frame).toContainElement(screen.getByText("Skip to table"));
  });
});
