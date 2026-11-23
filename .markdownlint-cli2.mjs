import relativeLinksRule from "markdownlint-rule-relative-links";

export default {
  config: {
    default: true,
    MD013: false,
    "relative-links": { root_path: "." },
  },
  customRules: [relativeLinksRule],
  globs: ["**/*.md"],
  gitignore: true,
  ignores: [".patricktree-stack/**", ".claude/worktrees/**"],
};
