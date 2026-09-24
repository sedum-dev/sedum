export const packages = [
  { name: "@sedum-dev/core", directory: "packages/core" },
  {
    name: "@sedum-dev/provider-typesafe",
    directory: "packages/provider-typesafe",
  },
  { name: "@sedum-dev/reporters", directory: "packages/reporters" },
  { name: "sedum-cli", directory: "packages/cli" },
];

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
