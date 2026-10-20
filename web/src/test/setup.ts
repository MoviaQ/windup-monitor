import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// Bez globals: true testing-library nie sprząta DOM między testami — robimy to jawnie.
afterEach(() => {
  cleanup();
});
