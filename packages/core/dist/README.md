# Committed build output

Everything else in this directory is compiled from `../src` via `npm run
build` (plain `tsc`) and is **checked into git**, unlike most build output.

Why: `packages/mobile` resolves `@lyric-viewer/core` via this directory
(`package.json`'s `"main"`/`"types"` point here). Relying on a pre-script
hook to build it automatically before `expo start` proved unreliable in
practice — it only fires for `npm run <script>`, not `npx expo start ...`
run directly, and that gap caused repeated "package specifies a main module
field that could not be resolved" errors on a real machine. Shipping the
build output removes the failure mode entirely.

**If you change anything in `../src`, rebuild and recommit:**

```sh
cd packages/core
npm run build
git add dist
git commit -m "Rebuild packages/core/dist"
```

This file itself is untouched by `tsc` (nothing in `src` produces it), so it
survives rebuilds.
