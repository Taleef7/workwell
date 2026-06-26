import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SegmentEditorModal } from "../SegmentEditorModal";

vi.mock("../hooks/usePreview", () => ({ usePreview: () => ({ preview: { count: 3, members: ["emp-006", "emp-010", "emp-012"] }, previewError: null }) }));
vi.mock("../hooks/useDirectorySearch", () => ({ useDirectorySearch: () => [{ externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A" }] }));

const MEASURES = [{ id: "audiogram", name: "Audiogram" }, { id: "hazwoper", name: "HAZWOPER Surveillance" }];

describe("SegmentEditorModal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a name, ≥1 condition, and ≥1 measure before save is enabled, then posts the draft", async () => {
    const onSave = vi.fn().mockResolvedValue({ id: "s1" });
    const onSaved = vi.fn();
    render(<SegmentEditorModal open initial={null} activeMeasures={MEASURES} onClose={() => {}} onSaved={onSaved} onSave={onSave} />);
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/group name/i), "Welders");
    await userEvent.click(screen.getByRole("button", { name: /add condition/i }));
    await userEvent.type(screen.getByLabelText(/condition value/i), "Welder");
    await userEvent.click(screen.getByLabelText(/measure audiogram/i));
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const draft = onSave.mock.calls[0][0];
    expect(draft.name).toBe("Welders");
    expect(draft.measureIds).toContain("audiogram");
    expect(draft.rule.conditions[0]).toMatchObject({ attr: "role", op: "contains", value: "Welder" });
    expect(onSaved).toHaveBeenCalled();
  });

  it("shows the live membership preview count", () => {
    render(<SegmentEditorModal open initial={null} activeMeasures={MEASURES} onClose={() => {}} onSaved={() => {}} onSave={vi.fn()} />);
    expect(screen.getByText(/3 employees match/i)).toBeInTheDocument();
  });

  it("previews membership from the rule alone — before any measure is selected", async () => {
    render(<SegmentEditorModal open initial={null} activeMeasures={MEASURES} onClose={() => {}} onSaved={() => {}} onSave={vi.fn()} />);
    // No name, no measure — just a complete condition.
    await userEvent.click(screen.getByRole("button", { name: /add condition/i }));
    await userEvent.type(screen.getByLabelText(/condition value/i), "Welder");
    expect(screen.getByText(/3 employees match/i)).toBeInTheDocument();
    // Save is still gated on the full canSave (name + measure missing).
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("handles the in-operator: a comma-separated value posts a trimmed string[] in the draft", async () => {
    const onSave = vi.fn().mockResolvedValue({ id: "s2" });
    render(<SegmentEditorModal open initial={null} activeMeasures={MEASURES} onClose={() => {}} onSaved={() => {}} onSave={onSave} />);
    await userEvent.type(screen.getByLabelText(/group name/i), "Plants");
    await userEvent.click(screen.getByRole("button", { name: /add condition/i }));
    await userEvent.selectOptions(screen.getByLabelText(/condition 1 operator/i), "in");
    await userEvent.type(screen.getByLabelText(/condition value/i), "Plant A, Plant B");
    await userEvent.click(screen.getByLabelText(/measure audiogram/i));
    const save = screen.getByRole("button", { name: /save/i });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].rule.conditions[0]).toMatchObject({ op: "in", value: ["Plant A", "Plant B"] });
  });

  it("trims a padded scalar value in the posted draft (so the backend matcher can match it)", async () => {
    const onSave = vi.fn().mockResolvedValue({ id: "s3" });
    render(<SegmentEditorModal open initial={null} activeMeasures={MEASURES} onClose={() => {}} onSaved={() => {}} onSave={onSave} />);
    await userEvent.type(screen.getByLabelText(/group name/i), "Welders");
    await userEvent.click(screen.getByRole("button", { name: /add condition/i }));
    // Default condition is attr=role, op=contains; type a value with surrounding whitespace.
    await userEvent.type(screen.getByLabelText(/condition value/i), "  Welder  ");
    await userEvent.click(screen.getByLabelText(/measure audiogram/i));
    const save = screen.getByRole("button", { name: /save/i });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].rule.conditions[0]).toMatchObject({ attr: "role", op: "contains", value: "Welder" });
  });
});
