/**
 * Evidence MIME detection + filename sanitization unit test (#108).
 * node --import tsx --test src/case/evidence-service.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMimeType, sanitizeFileName } from "./evidence-service.ts";

const bytes = (...b: number[]) => new Uint8Array(b);

test("detectMimeType: strong binary signatures win over the filename", () => {
  assert.equal(detectMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x1), "x.txt"), "image/png");
  assert.equal(detectMimeType(bytes(0xff, 0xd8, 0xff, 0x00), "x.txt"), "image/jpeg");
  assert.equal(detectMimeType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31), "x.txt"), "application/pdf");
});

test("detectMimeType: ZIP → xlsx only with the .xlsx extension, else unsupported", () => {
  const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
  assert.equal(detectMimeType(zip, "book.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(detectMimeType(zip, "resume.docx"), null, "other zip types are not allow-listed");
});

test("detectMimeType: UTF-8 text routes to csv (by ext) or plain; binary → null", () => {
  const text = new TextEncoder().encode("name,role\nOmar,Welder\n");
  assert.equal(detectMimeType(text, "people.csv"), "text/csv");
  assert.equal(detectMimeType(text, "notes.txt"), "text/plain");
  // invalid UTF-8 (lone continuation byte) is not text → undetectable
  assert.equal(detectMimeType(bytes(0xc0, 0xff, 0x00, 0x9f), "mystery"), null);
});

test("sanitizeFileName strips paths + unsafe chars, never empty", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("C:\\evil\\report final.pdf"), "report_final.pdf");
  assert.equal(sanitizeFileName("..."), "evidence");
  assert.equal(sanitizeFileName(null), "evidence");
  assert.equal(sanitizeFileName("a b@c#.png"), "a_b_c_.png");
});
