import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // packages/mls/pkg is wasm-bindgen output, rebuilt by packages/mls/build.sh.
    ignores: ["dist/**", "**/dist/**", "coverage/**", ".wrangler/**", "node_modules/**", "packages/mls/pkg/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"]
  })),
  prettier,
  {
    files: ["apps/desktop/e2e/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly"
      }
    }
  },
  {
    // Node scripts that also pass closures to the page (window).
    files: ["packages/mls/browser/*.mjs", "packages/crypto/browser/*.mjs"],
    languageOptions: {
      globals: {
        URL: "readonly",
        console: "readonly",
        process: "readonly",
        window: "readonly"
      }
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      // remus-wasm 2026.1.87 renamed the class; the old name is a deprecated
      // alias that a later Remus release removes.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "remus-wasm",
              importNames: ["BrepKernel"],
              message: "Use RemusKernel; BrepKernel is a deprecated alias."
            }
          ]
        }
      ]
    }
  },
  {
    // The web app is the only React surface (packages/viewport is
    // deliberately React-free). rules-of-hooks violations are runtime bugs,
    // so they fail the build; exhaustive-deps stays advisory because the
    // viewer's imperative mount effect intentionally closes over refs.
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
);
