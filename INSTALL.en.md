# Installation Guide (dsh-prime-memory)

This plugin ships as a **DSH official bundle package**: after install, the `dsh.bundle` layer in `cordis.patch.yml` auto-mounts the plugin entry — no manual profile edits needed.

## Requirements

- Node.js ≥ 22.16 (DSH 0.1.1-rc.2 and above)
- DeepSeek Harness (DSH) installed, with `--profile web` available

## Install

Pick any invocation style (the `npx` prefix can replace `dsh` in any command below):

```bash
# Option 1: run the official CLI via npx (no pre-installed dsh; version can be pinned, e.g. dsh-prime-memory@0.8.4)
npx -y @deepseek-ai/dsh plugin --profile web add dsh-prime-memory

# Option 2: with the dsh CLI installed (dsh is a pnpm forwarder; npm i -g pnpm first if missing)
dsh plugin --profile web add dsh-prime-memory

# Alternative sources: GitHub repo / local path (dev & debugging, link: points at the repo; npm run build + restart dsh to apply)
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-prime-memory
```

### Install via an AI Agent (Recommended)

Send this message as-is to your current agent (if it can run terminal commands):

```text
Please install the dsh-prime-memory plugin for the web profile of DeepSeek Harness.

Run only the two commands below and do not modify any other profile:
dsh plugin --profile web add dsh-prime-memory
dsh --profile web --dump-config

Confirm that dsh-prime-memory appears in the output, then report the result to me.
Do not close or restart my running DSH yourself; after installation, remind me to manually restart the DSH Web Host.
```

## Upgrade

```bash
# Upgrade to the latest
dsh plugin --profile web update dsh-prime-memory

# Upgrade to a specific version
dsh plugin --profile web update dsh-prime-memory@0.8.11
```

Upgrade only replaces plugin code and the `dist/` build; the data directory `~/.dsh/memory/` is untouched.

## Verify

After installing and restarting the DSH Web Host, check:

1. **Data directory appears** → plugin applied: `~/.dsh/memory/` contains `conversations/` `records/` `scenes/` and `memory.db`;
2. **Settings shows a "Memory" page** and the input bar shows the mode pill → client half is ready;
3. Send a message with personal info; after distillation completes, ask about it in another turn — you should see a "Context injection · memory" row in the context.

Optional smoke test (dev / troubleshooting):

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## Migrate / Downgrade

- **Migrate from old versions (named `dsh-memory-plugin` before 0.5.0)**: old data dir is incompatible with the new package. Back it up, delete `~/.dsh/memory/`, and let the new plugin rebuild on first run; history cannot be upgraded in place — re-distillation is required.
- **Roll back to an old version**: `dsh plugin --profile web remove dsh-prime-memory`, then reinstall per the old docs. The data dir is preserved, but old versions won't read the new layout — clean it too.

## Uninstall

```bash
dsh plugin --profile web remove dsh-prime-memory
```

Data stays in `~/.dsh/memory/`; delete the whole directory manually if you don't need it.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No "Memory" page after install | DSH not restarted / bundle not mounted | Restart DSH Web Host; `dsh --profile web --dump-config` should list `dsh-prime-memory` |
| Startup error `duplicate loader entry id` | patch uses `insert:` with the same id as the bundle layer | Remove your manual `insert:` entry — the bundle layer already ships with the package |
| No "Context injection · memory" row | Distillation didn't run / recall off | Ensure mode ≠ off and `recall.enabled=true`; check `L1 阶段完成` in `memory.log` |
| Local embedding download stuck | Mirror unreachable directly | Set `embedding.proxy` to a proxy, or switch `embedding.mirror` to official `huggingface.co` |
| Remote embedding 401 | Wrong apiKey / key-less service shouldn't get a key | Check `embedding.apiKey`; for a key-less self-hosted service, leave apiKey empty |

See also [README.en.md](./README.en.md) and [CHANGELOG.en.md](./CHANGELOG.en.md).
