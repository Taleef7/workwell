import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ElmExplorer, type CompileResult, type ElmLibrary } from "../ElmExplorer";

// Minimal ELM fixtures — only the bits ElmExplorer reads (statements.def name/expression).
const elmWith = (defineName: string): ElmLibrary => ({
  library: {
    identifier: { id: "Demo", version: "1.0.0" },
    statements: { def: [{ name: defineName, expression: { type: "Literal", localId: "1" } }] },
  },
});
const SEED_CQL = "library Demo version '1.0.0'";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const textbox = () => screen.getByRole("textbox") as HTMLTextAreaElement;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ElmExplorer live recompile", () => {
  it("compiles an edit and shows the new define's AST", async () => {
    const onCompile = vi.fn(async (): Promise<CompileResult> => ({ ok: true, elm: elmWith("Edited Define"), diagnostics: [] }));
    render(<ElmExplorer initialCql={SEED_CQL} initialElm={elmWith("Seed Define")} onCompile={onCompile} />);

    fireEvent.change(textbox(), { target: { value: SEED_CQL + "\ndefine \"Edited Define\": 1" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onCompile).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Edited Define")).toBeTruthy();
  });

  it("does not let a stale compile response overwrite the editor after the user reverts (race guard)", async () => {
    const d = deferred<CompileResult>();
    const onCompile = vi.fn(() => d.promise);
    render(<ElmExplorer initialCql={SEED_CQL} initialElm={elmWith("Seed Define")} onCompile={onCompile} />);

    // Edit → let the debounce fire → compile("B") is now in flight (unresolved).
    fireEvent.change(textbox(), { target: { value: SEED_CQL + "\ndefine \"From B\": 2" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(onCompile).toHaveBeenCalledTimes(1);

    // Revert to the seed BEFORE the in-flight response lands — this must invalidate it.
    fireEvent.change(textbox(), { target: { value: SEED_CQL } });

    // The stale response resolves now; it must be discarded, not rendered.
    await act(async () => {
      d.resolve({ ok: true, elm: elmWith("From B"), diagnostics: [] });
      await Promise.resolve();
    });

    expect(screen.queryByText("From B")).toBeNull();
    expect(screen.getByText("Seed Define")).toBeTruthy();
  });
});
