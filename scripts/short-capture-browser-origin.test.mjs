import assert from "node:assert/strict";
import test from "node:test";
import { resolveShortCaptureBrowserOrigin } from "../lib/short-capture-browser-origin.mjs";

test("uses the local app origin when no browser origin is configured", () => {
  assert.equal(
    resolveShortCaptureBrowserOrigin("http://127.0.0.1:6105"),
    "http://127.0.0.1:6105",
  );
});

test("allows a trusted HTTPS browser origin for capture playback", () => {
  assert.equal(
    resolveShortCaptureBrowserOrigin(
      "http://127.0.0.1:6105",
      "https://nexusdirector.epicglobal.app",
    ),
    "https://nexusdirector.epicglobal.app",
  );
});

test("rejects non-HTTPS public browser origins and non-origin URLs", () => {
  assert.throws(
    () => resolveShortCaptureBrowserOrigin("http://127.0.0.1:6105", "http://nexusdirector.epicglobal.app"),
    /must use HTTPS/,
  );
  assert.throws(
    () => resolveShortCaptureBrowserOrigin("http://127.0.0.1:6105", "https://nexusdirector.epicglobal.app/path"),
    /must be an origin/,
  );
});

test("keeps the internal app origin restricted to loopback", () => {
  assert.throws(
    () => resolveShortCaptureBrowserOrigin("https://nexusdirector.epicglobal.app"),
    /SHORT_CAPTURE_APP_ORIGIN must use localhost/,
  );
});
