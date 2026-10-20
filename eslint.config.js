import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "receipts.jsonl", "posts.json"] },
  ...tseslint.configs.recommended,
);
