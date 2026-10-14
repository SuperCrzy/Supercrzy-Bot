# Pull Request

## What this changes

<!-- One or two sentences. If it fixes an issue, write "Closes #123". -->

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behaviour change)
- [ ] Documentation
- [ ] Build / tooling / CI
- [ ] Performance

## How it was verified

<!--
Be specific. "It works" is not verification. Paste the command you ran and its result.
Examples:
  - `pnpm --filter @supercrzy/server test` → 34 files / 498 tests passed
  - Manual: opened http://localhost:5173, clicked "read aloud", got audio in ~0.6s
  - Added a regression test in `x.test.ts` that fails on the previous commit
-->

```
<paste the exact command + output>
```

## Checklist

- [ ] `pnpm lint` passes (server `tsc --noEmit`, client `vue-tsc --noEmit`)
- [ ] `pnpm test` passes
- [ ] Added/updated tests for the change (or explained why none are needed)
- [ ] No credentials, tokens, real user data, or `*.db` files are included
- [ ] Docs updated if behaviour or setup changed (`README`, `CONTRIBUTING`, comments in the touched module)

## Risk / blast radius

<!--
What could this break? Which parts of the app touch it?
Call out anything that needs a reviewer's attention: migrations, IPC contracts,
protocol frames, shared constants, anything a future edit could silently misalign.
-->

## Screenshots / recordings

<!-- Required for UI changes. Before / after is ideal. -->
