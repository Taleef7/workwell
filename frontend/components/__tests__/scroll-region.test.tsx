import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScrollRegion } from "../scroll-region";

describe("ScrollRegion (#700)", () => {
  it("is a labelled, keyboard-focusable horizontal scroller that shows its scroll cue", () => {
    render(
      <ScrollRegion label="Work list table" className="rounded-xl border">
        <table><tbody><tr><td>cell</td></tr></tbody></table>
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", { name: "Work list table" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("scroll-cue", "overflow-x-auto", "rounded-xl", "border");
    expect(region).toContainElement(screen.getByRole("table"));
  });
});
