import { expect, it } from "vitest";
import { goalGenerators } from "./goal-data.js";

it("offers a broad, executable scalar catalog within the choice budget", () => {
  const catalog = goalGenerators(42);
  const ids = Object.keys(catalog.descriptions);
  expect(ids.length).toBeGreaterThan(170);
  expect(ids.length + 49).toBeLessThanOrEqual(255);
  for (const id of ids) {
    const value = catalog.generate(id);
    expect(value.trim(), id).not.toBe("");
    expect(value.length, id).toBeLessThanOrEqual(2000);
  }
  expect(() => catalog.generate("faker.helpers.fake")).toThrow("Unknown");
  expect(() => catalog.generate("constructor")).toThrow("Unknown");
});

it("isolates seeded sequences between goals and uses reserved email domains", () => {
  const a = goalGenerators(53);
  const b = goalGenerators(53);
  const first = a.generate("faker.internet.exampleEmail");
  const second = a.generate("faker.internet.exampleEmail");
  expect(first).toMatch(/@example\.(com|net|org)$/);
  expect(second).not.toBe(first);
  expect(b.generate("faker.internet.exampleEmail")).toBe(first);
  expect(b.generate("faker.internet.exampleEmail")).toBe(second);
});
