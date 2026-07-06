/**
 * Unit tests for GlobalFilterGroup — the labelled wrapper around the app-wide
 * site/time selectors in the dashboard header (UX-13). Its whole job is
 * discoverability: making it obvious that the header selectors govern *every*
 * page (global scope), distinct from a page's own on-page filter bar. Contracts:
 *  1. Exposes an accessible group named "Global" so AT users know the scope.
 *  2. Renders a visible "Global" caption for sighted users.
 *  3. Still renders its children (the actual <select>s) unchanged.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { GlobalFilterGroup } from "../global-filter-group";

describe("GlobalFilterGroup", () => {
  it("exposes an accessible group whose name marks it as global scope", () => {
    render(
      <GlobalFilterGroup>
        <button type="button">All Sites</button>
      </GlobalFilterGroup>,
    );
    expect(screen.getByRole("group", { name: /global/i })).toBeInTheDocument();
  });

  it("renders a visible 'Global' caption", () => {
    render(
      <GlobalFilterGroup>
        <button type="button">All Sites</button>
      </GlobalFilterGroup>,
    );
    expect(screen.getByText("Global")).toBeInTheDocument();
  });

  it("still renders its children (the filter selectors)", () => {
    render(
      <GlobalFilterGroup>
        <button type="button">All Sites</button>
        <button type="button">All time</button>
      </GlobalFilterGroup>,
    );
    const group = screen.getByRole("group", { name: /global/i });
    expect(within(group).getByRole("button", { name: "All Sites" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "All time" })).toBeInTheDocument();
  });
});
