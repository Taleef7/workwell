/**
 * The "Attributed list" filter's data and notes (#874), shared by the work list, the roster and Cases.
 *
 * What is pinned: only the newest revision of a name is offered (an older one a link names stays
 * selectable, and the note offers the newer); a seat the server would refuse never sends the id; a
 * VIEWER never fetches the lists; and a list that cannot be named never makes an active filter invisible.
 */
import React from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

import { ListFilterNote, listParam, useListFilter } from "../list-filter";

const row = (id: string, name: string, revision: number, over: Record<string, unknown> = {}) => ({
  id,
  name,
  revision,
  source: null,
  note: null,
  createdBy: "admin@maui.workwell.dev",
  createdAt: `2026-0${revision}-24T00:00:00.000Z`,
  counts: { MATCHED: 250, NOT_FOUND: 1, AMBIGUOUS: 0 },
  ...over,
});
const Q3_V1 = row("list-q3-v1", "ACO Q3 attribution", 1);
const Q3_V2 = row("list-q3-v2", "ACO Q3 attribution", 2, { counts: { MATCHED: 260, NOT_FOUND: 0, AMBIGUOUS: 0 } });
const QA = row("list-qa", "QA list", 1, { counts: { MATCHED: 3, NOT_FOUND: 2, AMBIGUOUS: 1 } });

const params = (query: string) => new URLSearchParams(query);

beforeEach(() => {
  vi.clearAllMocks();
  setSubject("patient");
  get.mockResolvedValue([Q3_V1, Q3_V2, QA]);
});

it("a case manager's link keeps its list; any other seat drops it and says so", () => {
  expect(listParam(params("listId=list-qa"), "ROLE_CASE_MANAGER")).toEqual({ listId: "list-qa", refused: false });
  expect(listParam(params("listId=list-qa"), "ROLE_ADMIN")).toEqual({ listId: "list-qa", refused: false });
  // The worker answers 403 to a VIEWER naming a list, so the screen never sends it.
  expect(listParam(params("listId=list-qa"), "ROLE_VIEWER")).toEqual({ listId: "", refused: true });
  // Before the session loads the seat is unknown: nothing sent, and no note flashed at a case manager.
  expect(listParam(params("listId=list-qa"), undefined)).toEqual({ listId: "", refused: false });
  expect(listParam(params(""), "ROLE_VIEWER")).toEqual({ listId: "", refused: false });
});

it("offers only the newest revision of each name, labelled with its counts", async () => {
  const { result } = renderHook(() => useListFilter("", true));
  await waitFor(() => expect(result.current.options).toHaveLength(3));
  const labels = result.current.options.map((o) => o.label);
  expect(labels[0]).toBe("Not limited to a list");
  // v1 of the Q3 list is not offered: two "ACO Q3 attribution" entries would leave a reader guessing.
  expect(result.current.options.map((o) => o.value)).toEqual(["", "list-q3-v2", "list-qa"]);
  expect(labels[1]).toBe("ACO Q3 attribution v2 · imported 2026-02-24 · 260 patients");
  // AMBIGUOUS is not matched either: both count.
  expect(labels[2]).toBe("QA list · imported 2026-01-24 · 3 patients (3 not matched)");
  expect(result.current.state).toBe("none");
});

it("an older revision a link names stays selected, and the newer one is offered", async () => {
  const { result } = renderHook(() => useListFilter("list-q3-v1", true));
  await waitFor(() => expect(result.current.state).toBe("found"));
  expect(result.current.options.map((o) => o.value)).toEqual(["", "list-q3-v2", "list-q3-v1", "list-qa"]);
  expect(result.current.chipName).toBe("ACO Q3 attribution v1");
  expect(result.current.newer?.id).toBe("list-q3-v2");

  const onChange = vi.fn();
  render(<ListFilterNote listId="list-q3-v1" refused={false} filter={result.current} onChange={onChange} />);
  expect(screen.getByText(/1 list member isn't matched to a patient here/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Review on Attributed lists" })).toHaveAttribute("href", "/lists");
  expect(screen.getByText(/A newer revision of this list was imported on 2026-02-24/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Use it" }));
  expect(onChange).toHaveBeenCalledWith("list-q3-v2");
});

it("a list the lists cannot name stays visible: as an option, a chip and a note", async () => {
  get.mockRejectedValue(new Error("Failed to fetch"));
  const { result } = renderHook(() => useListFilter("list-q3-v2", true));
  await waitFor(() => expect(result.current.state).toBe("failed"));
  // The select keeps showing the active filter instead of falling back to "Not limited to a list".
  expect(result.current.options.at(-1)).toEqual({ value: "list-q3-v2", label: "list-q3-v2" });
  expect(result.current.chipName).toBe("list-q3-v2");

  const onChange = vi.fn();
  render(<ListFilterNote listId="list-q3-v2" refused={false} filter={result.current} onChange={onChange} />);
  expect(screen.getByText(/Limited to attributed list list-q3-v2; the lists could not be loaded/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear the list" }));
  expect(onChange).toHaveBeenCalledWith("");
});

it("a link opened before the session names the seat reads as loading, never as missing", async () => {
  // A hard load mounts with no role: nothing enabled and no id. Both arrive in the same render, one
  // render before the deferred fetch starts.
  const { result, rerender } = renderHook(({ id, enabled }) => useListFilter(id, enabled), {
    initialProps: { id: "", enabled: false },
  });
  rerender({ id: "list-qa", enabled: true });
  expect(result.current.state).toBe("loading");
  expect(result.current.options.at(-1)).toEqual({ value: "list-qa", label: "Loading…" });
  await waitFor(() => expect(result.current.state).toBe("found"));
});

it("an id no list holds says so, and offers to clear it", async () => {
  const { result } = renderHook(() => useListFilter("no-such-list", true));
  await waitFor(() => expect(result.current.state).toBe("missing"));
  render(<ListFilterNote listId="no-such-list" refused={false} filter={result.current} onChange={vi.fn()} />);
  expect(screen.getByText("No attributed list has the id no-such-list.")).toBeInTheDocument();
});

it("a seat that may not filter by list never fetches the lists", async () => {
  const { result } = renderHook(() => useListFilter("", false));
  // Past the deferred tick the enabled hook fetches on.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(get).not.toHaveBeenCalled();
  expect(result.current.options).toEqual([{ value: "", label: "Not limited to a list" }]);

  const onChange = vi.fn();
  render(<ListFilterNote listId="" refused filter={result.current} onChange={onChange} />);
  expect(screen.getByTestId("list-filter-note")).toHaveTextContent(
    "Attributed lists are for case managers, so the list in this link was not applied.",
  );
  // The seat has no picker or chip to clear it with, so the note is the way out.
  await userEvent.click(screen.getByRole("button", { name: "Remove it from the link" }));
  expect(onChange).toHaveBeenCalledWith("");
});
